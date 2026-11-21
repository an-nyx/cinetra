/**
 * My Cinema Stats through the HTTP API against the disposable test database: authentication, user isolation and
 * strict read-only behaviour (every row of every table is byte-identical afterwards). TMDB is stubbed in-process.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

if (!/^postgresql:\/\/postgres:status-test@127\.0\.0\.1:55439\/cinetra_status_test$/.test(process.env.DATABASE_URL ?? '')) throw new Error('Use the isolated test database only.');
process.env.JWT_SECRET ||= crypto.randomBytes(32).toString('hex');

const DAY = 86_400_000;
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

async function main() {
  // Fake TMDB at the service boundary: one ended series (3 aired episodes, 45 min) and two movies.
  const { TMDBApiService } = await import('../src/services/tmdb/tmdb-api.service');
  const stub = TMDBApiService.prototype as unknown as Record<string, unknown>;
  let tmdbCalls = 0;
  const seasons = [{ season_number: 1, episode_count: 4, air_date: day(-400) }];
  stub.getShow = async (id: number) => { tmdbCalls++; if (id !== 9101) throw Object.assign(new Error('not found'), { isAxiosError: true, response: { status: 404 } }); return { name: 'Stats Show', status: 'Returning Series', in_production: true, seasons, next_episode_to_air: null, genres: [{ id: 18, name: 'Drama' }, { id: 80, name: 'Crime' }] }; };
  // No TheTVDB/IMDb IDs: episode release times use the TMDB date fallback and no TVMaze request is made.
  stub.getExternalIds = async () => ({ tvdbId: null, imdbId: null });
  stub.getSeason = async () => { tmdbCalls++; return { episodes: [1, 2, 3].map(n => ({ episode_number: n, name: `E${n}`, air_date: day(-400 + n * 7), runtime: 45 })).concat([{ episode_number: 4, name: 'E4', air_date: day(30), runtime: 45 }]) }; };
  stub.getMovieInfo = async (id: number) => { tmdbCalls++; return { id, runtime: id === 9201 ? 120 : 95, genres: [{ name: id === 9201 ? 'Science Fiction' : 'Comedy' }] }; };

  const { prisma } = await import('../src/database/prisma');
  const { securityModule } = await import('../src/modules/security');
  const express = (await import('express')).default;
  const apiRoutes = (await import('../src/api/v1')).default;
  await prisma.$executeRawUnsafe('TRUNCATE "NotificationDelivery", "PushSubscription", "NotificationPreference", "EpisodeUnwatch", "EpisodeWatch", "MovieWatch", "Movie", "Show", "User" CASCADE');
  const app = express(); app.use(express.json()); app.use('/api/v1', apiRoutes);
  const server = await new Promise<http.Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const get = async (path: string, who?: string) => {
    const res = await fetch(base + path, { headers: who ? { Authorization: `Bearer ${securityModule.Commands.GenerateTokenCommand.execute(who)}` } : {} });
    const text = await res.text();
    return { status: res.status, cache: res.headers.get('cache-control'), json: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null };
  };

  const user = await prisma.user.create({ data: { email: `stats-${crypto.randomUUID()}@example.invalid`, username: 'stats', password: 'not-a-password' } });
  const other = await prisma.user.create({ data: { email: `stats-other-${crypto.randomUUID()}@example.invalid`, username: 'other', password: 'not-a-password' } });
  const empty = await prisma.user.create({ data: { email: `stats-empty-${crypto.randomUUID()}@example.invalid`, username: 'empty', password: 'not-a-password' } });

  // User: legacy position S1E2 with S1E1 unwatched, plus an explicit S1E3 record; one watched + rated movie with a
  // logged viewing; one watchlist movie rated 6.
  const show = await prisma.show.create({ data: { userId: user.id, name: 'Stats Show', tmdbId: 9101, status: 'watching', seasonsWatched: 1, episodesWatched: 2 } });
  await prisma.episodeUnwatch.create({ data: { showId: show.id, season: 1, episode: 1 } });
  await prisma.episodeWatch.create({ data: { showId: show.id, season: 1, episode: 3, watchedAt: new Date('2026-02-14T20:00:00Z') } });
  const watched = await prisma.movie.create({ data: { userId: user.id, name: 'Arrival', tmdbId: 9201, status: 'watched', rating: 9 } });
  await prisma.movieWatch.create({ data: { movieId: watched.id, watchedAt: new Date('2025-08-01T19:00:00Z') } });
  await prisma.movie.create({ data: { userId: user.id, name: 'Later', tmdbId: 9202, status: 'watchlist', rating: 6 } });
  // Other user: lots of activity that must never leak into the first user's stats.
  const otherShow = await prisma.show.create({ data: { userId: other.id, name: 'Other Show', tmdbId: 9101, status: 'completed', completed: true, seasonsWatched: 1, episodesWatched: 3 } });
  await prisma.episodeWatch.create({ data: { showId: otherShow.id, season: 1, episode: 1, watchedAt: new Date('2024-05-01T10:00:00Z') } });
  await prisma.movie.create({ data: { userId: other.id, name: 'Other Movie', tmdbId: 9201, status: 'watched', rating: 2 } });

  // Snapshot of every table (all columns, including updatedAt) before any stats request.
  const tables = ['User', 'Show', 'EpisodeWatch', 'EpisodeUnwatch', 'Movie', 'MovieWatch', 'NotificationPreference', 'PushSubscription', 'NotificationDelivery'];
  const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async t => [t, JSON.stringify(await prisma.$queryRawUnsafe(`SELECT * FROM "${t}" ORDER BY 1`))])));
  const before = await snapshot();

  // Authentication required.
  assert.equal((await get('/stats')).status, 401);

  const mine = await get('/stats?tz=Europe/Paris', user.id);
  assert.equal(mine.status, 200);
  assert.equal(mine.cache, 'no-store', 'personal statistics are never cached by intermediaries');
  const s = mine.json;
  assert.equal(s.timeZone, 'Europe/Paris');
  assert.equal(s.tv.watchedEpisodes, 2, 'S1E2 (position) + S1E3 (record); S1E1 unwatched; S1E4 unreleased');
  assert.deepEqual([s.tv.episodesFromSavedPositions, s.tv.episodesFromRecords], [1, 1]);
  const tracking = await get(`/show/${show.id}/tracking`, user.id);
  assert.equal(s.tv.watchedEpisodes, tracking.json.watchedCount, 'identical to the tracking summary');
  assert.equal(s.watchTime.tv.minutes, 90);
  assert.equal(s.watchTime.movies.minutes, 120, 'only the watched movie counts toward time');
  assert.equal(s.watchTime.totalMinutes, 210);
  assert.deepEqual(s.tv.statusCounts, { watching: 1, completed: 0, dropped: 0, none: 0 });
  assert.deepEqual([s.movies.watched, s.movies.watchlist], [1, 1]);
  assert.deepEqual(s.genres.items.map((g: { name: string }) => g.name).sort(), ['Crime', 'Drama', 'Science Fiction']);
  assert.equal(s.ratings.movies.average, 7.5);
  assert.deepEqual(s.ratings.movies.top.map((m: { name: string }) => m.name), ['Arrival', 'Later']);
  assert.deepEqual(s.years.items.map((y: { year: number }) => y.year), [2026, 2025]);
  assert.equal(s.metadataPending, 0);
  const serialized = JSON.stringify(s);
  assert.ok(!serialized.includes('Other Show') && !serialized.includes('Other Movie') && !serialized.includes(other.id), 'no other user data');
  assert.ok(!serialized.includes('2024'), 'the other user’s 2024 record does not appear');

  // The other user sees only their own library.
  const theirs = (await get('/stats', other.id)).json;
  assert.equal(theirs.tv.watchedEpisodes, 3);
  assert.equal(theirs.tv.completed, 1);
  assert.equal(theirs.ratings.movies.average, 2);
  assert.ok(!JSON.stringify(theirs).includes('Arrival'));

  // An empty library answers with zeros, not an error.
  const none = (await get('/stats', empty.id)).json;
  assert.deepEqual([none.watchTime.totalMinutes, none.tv.watchedEpisodes, none.movies.total, none.ratings.movies.average, none.years.items.length], [0, 0, 0, null, 0]);

  // Metadata is cached: repeat requests make no new TMDB calls. An invalid zone falls back to UTC.
  const calls = tmdbCalls;
  const again = (await get('/stats?tz=Bogus/Zone', user.id)).json;
  assert.equal(tmdbCalls, calls, 'genres, runtimes and catalogs come from caches');
  assert.equal(again.timeZone, 'UTC');

  // Strictly read-only: nothing changed anywhere.
  assert.deepEqual(await snapshot(), before, 'every row in every table is unchanged');

  server.close();
  await prisma.$executeRawUnsafe('TRUNCATE "MovieWatch", "Movie", "EpisodeUnwatch", "EpisodeWatch", "Show", "User" CASCADE');
  console.log('Cinema stats integration tests passed');
  await prisma.$disconnect();
}
main().catch(error => { console.error(error); process.exit(1); });
