/**
 * Upcoming and Home agree on when an episode is released: Upcoming carries the catalog's effective release instant
 * (TVMaze exact premiere, manual override or conservative fallback) whenever TVMaze's numbering is verified against
 * TMDB, and keeps a past-dated release listed until Cinetra releases it. Real Upcoming build path; TMDB stubbed in
 * process; TVMaze served through axios' adapter; disposable local PostgreSQL. No network.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';

if (!/^postgresql:\/\/postgres:status-test@127\.0\.0\.1:55439\/cinetra_status_test$/.test(process.env.DATABASE_URL ?? '')) throw new Error('Use the isolated test database only.');
const DAY = 86_400_000;
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

type TvEpisode = { id: number; season: number; number: number; type: string; airdate: string; airtime: string; airstamp: string };
const tvmaze = new Map<number, { tvdb: number; timezone: string | null; episodes: TvEpisode[] }>();
axios.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
  const url = new URL(config.url!, config.baseURL);
  const reply = (status: number, data: unknown, headers: Record<string, string> = {}) => {
    const response = { data, status, statusText: String(status), headers, config };
    if ((config.validateStatus ?? (s => s >= 200 && s < 300))(status)) return response;
    throw new AxiosError(`HTTP ${status}`, 'ERR_BAD_REQUEST', config, null, response as never);
  };
  if (url.hostname !== 'api.tvmaze.com') throw new Error(`Unexpected network request to ${url.hostname}`);
  if (url.pathname === '/lookup/shows') {
    const id = [...tvmaze.entries()].find(([, v]) => v.tvdb === Number(config.params?.thetvdb))?.[0];
    return id ? reply(302, '', { location: `https://api.tvmaze.com/shows/${id}` }) : reply(404, null);
  }
  if (url.pathname === '/updates/shows') return reply(200, {});
  const m = /^\/shows\/(\d+)$/.exec(url.pathname);
  if (m && tvmaze.has(Number(m[1]))) {
    const id = Number(m[1]); const s = tvmaze.get(id)!;
    const channel = s.timezone ? { network: { name: 'HBO', country: { timezone: s.timezone } }, webChannel: null } : { network: null, webChannel: { name: 'Streamer', country: null } };
    return reply(200, { id, name: `TVMaze ${id}`, status: 'Running', updated: 1, externals: { thetvdb: s.tvdb }, ...channel, _embedded: { episodes: structuredClone(s.episodes) } });
  }
  return reply(404, null);
};

type Ep = [season: number, number: number, airDate: string];
const tmdb = new Map<number, { name: string; episodes: Ep[]; tvdb: number }>();

async function main() {
  const { TMDBApiService } = await import('../src/services/tmdb/tmdb-api.service');
  const stub = TMDBApiService.prototype as unknown as Record<string, unknown>;
  const find = (id: number) => tmdb.get(id)!;
  stub.getShow = async (id: number) => { const s = find(id); const seasons = [...new Set(s.episodes.map(([n]) => n))]; return { name: s.name, original_name: s.name, overview: '', first_air_date: s.episodes[0][2], status: 'Returning Series', in_production: true, next_episode_to_air: null, seasons: seasons.map(n => ({ season_number: n, episode_count: s.episodes.filter(([x]) => x === n).length, air_date: s.episodes.find(([x]) => x === n)![2] })) }; };
  stub.getSeason = async (id: number, n: number) => ({ episodes: find(id).episodes.filter(([s]) => s === n).map(([, number, air_date]) => ({ episode_number: number, name: `Episode ${number}`, air_date, runtime: 60 })) });
  stub.getExternalIds = async (id: number) => ({ tvdbId: find(id).tvdb, imdbId: null });

  const { setReleaseOverridesForTests } = await import('../src/services/release-overrides.service');
  const { prisma } = await import('../src/database/prisma');
  const { getUpcomingReleases, getTrackingSummary, effectiveRelease } = await import('../src/services/episode-guide.service');
  await prisma.$executeRawUnsafe('TRUNCATE "NotificationDelivery", "PushSubscription", "NotificationPreference", "EpisodeUnwatch", "EpisodeWatch", "MovieWatch", "Movie", "Show", "User" CASCADE');
  const user = await prisma.user.create({ data: { email: `upcoming-${crypto.randomUUID()}@example.invalid`, username: 'upcoming', password: 'not-a-password' } });
  const add = async (tmdbId: number, name: string, episodes: Ep[], tvdb: number, tv: { id: number; timezone: string | null; episodes: TvEpisode[] }) => {
    tmdb.set(tmdbId, { name, episodes, tvdb }); tvmaze.set(tv.id, { tvdb, timezone: tv.timezone, episodes: tv.episodes });
    return prisma.show.create({ data: { userId: user.id, name, tmdbId, status: 'watching', seasonsWatched: 1, episodesWatched: 1 } });
  };
  const tvEp = (id: number, season: number, number: number, airdate: string, airstamp: string | null = null): TvEpisode =>
    ({ id, season, number, type: 'regular', airdate, airtime: airstamp ? '21:00' : '', airstamp: airstamp ?? `${airdate}T12:00:00+00:00` });

  // 1. Broadcast with an exact TVMaze time (tomorrow 21:00 New York).
  const broadcastAt = new Date(`${day(2)}T02:00:00Z`).toISOString();
  const broadcast = await add(9001, 'Broadcast Drama', [[1, 1, day(-30)], [1, 2, day(1)]], 7001, { id: 8001, timezone: 'America/New_York', episodes: [tvEp(1, 1, 1, day(-30), new Date(`${day(-29)}T02:00:00Z`).toISOString()), tvEp(2, 1, 2, day(1), broadcastAt)] });
  // 2. Streaming, date only; a documented manual time (fixture) 18:00 Los Angeles the evening before TMDB's date.
  const streaming = await add(9002, 'Streaming Saga', [[1, 1, day(-30)], [1, 2, day(2)]], 7002, { id: 8002, timezone: null, episodes: [tvEp(3, 1, 1, day(-30)), tvEp(4, 1, 2, day(2))] });
  setReleaseOverridesForTests({ version: 1, overrides: [{
    id: 'streaming-saga-s1e2', tmdbId: 9002, show: 'Streaming Saga', season: 1, episode: 2, releaseLocal: `${day(1)}T18:00`, timeZone: 'America/Los_Angeles',
    tmdbAirDate: day(2), source: { url: 'https://example.com/press', publisher: 'Test fixture', scope: 'episode' }, verifiedAt: day(0),
  }] });
  // 3. TVMaze dates it two days earlier than TMDB (today): Cinetra waits for TMDB's fallback (tomorrow 12:00Z).
  const conflicted = await add(9003, 'Conflicted Dates', [[1, 1, day(-30)], [1, 2, day(0)]], 7003, { id: 8003, timezone: null, episodes: [tvEp(5, 1, 1, day(-30)), tvEp(6, 1, 2, day(-2))] });
  // 4. TVMaze numbers an episode TMDB does not have: numbering unverified, so Upcoming shows TVMaze's date alone.
  const ambiguous = await add(9004, 'Split Numbering', [[1, 1, day(-30)], [1, 2, day(3)]], 7004, { id: 8004, timezone: null, episodes: [tvEp(7, 1, 1, day(-30)), tvEp(8, 1, 2, day(3)), tvEp(9, 1, 3, day(4))] });

  let upcoming = await getUpcomingReleases(user.id);
  for (let i = 0; i < 100 && (!('releases' in upcoming) || upcoming.refreshing); i++) { await new Promise(r => setTimeout(r, 100)); upcoming = await getUpcomingReleases(user.id); }
  assert.ok('releases' in upcoming, 'Upcoming built');
  const ready = upcoming;
  const byShow = (id: string) => ready.releases.filter(r => r.showId === id);
  const home = async (showId: string) => (await getTrackingSummary(showId, user.id)).upcomingEpisode;
  const cinetra = async (tmdbId: number, name: string, n: number) => (await effectiveRelease({ name, tmdbId }, 1, n)).releaseAt;

  const [b] = byShow(broadcast.id);
  assert.deepEqual([b.number, b.releaseAt, b.releaseSource, b.airTimestamp], [2, broadcastAt, 'tvmaze_exact', broadcastAt]);
  assert.equal(b.releaseAt, await cinetra(9001, 'Broadcast Drama', 2));
  assert.equal((await home(broadcast.id))?.number, 2);

  const [s] = byShow(streaming.id);
  assert.deepEqual([s.number, s.releaseSource, s.airTimestamp], [2, 'manual_override', null], 'Upcoming carries the documented time; TVMaze has none');
  assert.equal(s.releaseAt, await cinetra(9002, 'Streaming Saga', 2), 'Upcoming and Home use the same instant');
  assert.equal(s.releaseAt!.slice(0, 10), day(2), 'the evening before in Los Angeles is TMDB\'s date in UTC');

  const [c] = byShow(conflicted.id);
  assert.ok(c, 'a release whose TVMaze date has passed stays listed while Cinetra has not released it');
  assert.deepEqual([c.number, c.airDate, c.releaseSource, c.releaseAt], [2, day(-2), 'tmdb_date', `${day(1)}T12:00:00.000Z`]);
  assert.equal(c.releaseAt, await cinetra(9003, 'Conflicted Dates', 2));
  assert.equal((await home(conflicted.id))?.number, 2, 'Home still lists it as upcoming too');

  const a = byShow(ambiguous.id);
  assert.deepEqual(a.map(r => [r.number, r.releaseAt, r.releaseSource]), [[2, null, null], [3, null, null]], 'unverified numbering: TVMaze dates alone, as before');

  await prisma.$disconnect();
  console.log('Upcoming release integration tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
