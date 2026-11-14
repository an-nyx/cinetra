/**
 * Episode tracking, legacy saved positions and automatic Watching <-> Completed statuses, end to end through the HTTP
 * API against a disposable PostgreSQL database.
 *
 * TMDB is stubbed at the service boundary and TVMaze at the HTTP adapter, so the real catalog, identity matching,
 * premiere and status code runs. Nothing leaves this machine.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';

if (!process.env.DATABASE_URL?.includes('/cinetra_episode_toggle_test_20261109')) throw new Error('Use the isolated episode toggle test database only.');
process.env.JWT_SECRET ||= crypto.randomBytes(32).toString('hex');

// ---------------------------------------------------------------------------------------------------------------
// Dates relative to the real clock: the tracking model compares air dates with today.
const DAY = 86_400_000;
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

// Fake TMDB: details, season pages and external IDs per series.
type TmdbEpisode = { episode_number: number; name: string; air_date: string | null; runtime: null };
type TmdbSeries = { name: string; status: string; seasons: { season_number: number; episode_count: number; air_date: string | null }[]; pages: Record<number, TmdbEpisode[]>; next?: { season_number: number; episode_number: number; air_date: string | null } | null; tvdb: number | null };
const tmdb = new Map<number, TmdbSeries>();
const episodes = (count: number, firstOffset: number, step = 7, from = 1): TmdbEpisode[] => Array.from({ length: count }, (_, i) => ({ episode_number: from + i, name: `Episode ${from + i}`, air_date: day(firstOffset + i * step), runtime: null }));
const series = (name: string, tvdb: number | null, seasons: Record<number, TmdbEpisode[]>, extra: Partial<TmdbSeries> = {}): TmdbSeries => ({
  name, status: 'Returning Series', tvdb, pages: seasons,
  seasons: Object.entries(seasons).map(([n, list]) => ({ season_number: Number(n), episode_count: list.length, air_date: list[0]?.air_date ?? null })), ...extra,
});

// Fake TVMaze: TheTVDB lookups and per-show episode lists (served through axios' adapter, so the real client runs).
type TvEpisode = { id: number; season: number; number: number; type: string; airdate: string | null; airtime: string; airstamp: string | null };
const tvmaze = new Map<number, { tvdb: number; episodes: TvEpisode[] }>();
let nextTvId = 1;
const tvEp = (season: number, number: number, at: Date | null, type = 'regular'): TvEpisode => ({ id: nextTvId++, season, number, type, airdate: at ? at.toISOString().slice(0, 10) : null, airtime: at ? '21:00' : '', airstamp: at ? at.toISOString() : null });
const tvFromTmdb = (s: TmdbSeries) => Object.entries(s.pages).flatMap(([n, list]) => list.map(e => tvEp(Number(n), e.episode_number, e.air_date ? new Date(`${e.air_date}T02:00:00Z`) : null)));
axios.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
  const url = new URL(config.url!, config.baseURL);
  const reply = (status: number, data: unknown, headers: Record<string, string> = {}) => {
    const response = { data, status, statusText: String(status), headers, config };
    if ((config.validateStatus ?? (s => s >= 200 && s < 300))(status)) return response;
    throw new AxiosError(`HTTP ${status}`, 'ERR_BAD_REQUEST', config, null, response as never);
  };
  if (url.hostname !== 'api.tvmaze.com') throw new Error(`Unexpected network request to ${url.hostname}`);
  if (url.pathname === '/lookup/shows') {
    const tvdb = Number(config.params?.thetvdb);
    const id = [...tvmaze.entries()].find(([, v]) => v.tvdb === tvdb)?.[0];
    return id ? reply(302, '', { location: `https://api.tvmaze.com/shows/${id}` }) : reply(404, null);
  }
  if (url.pathname === '/search/shows') return reply(200, []);
  if (url.pathname === '/updates/shows') return reply(200, {});
  const m = /^\/shows\/(\d+)$/.exec(url.pathname);
  if (m && tvmaze.has(Number(m[1]))) {
    const id = Number(m[1]); const show = tvmaze.get(id)!;
    return reply(200, { id, name: `TVMaze ${id}`, status: 'Running', updated: 1, externals: { thetvdb: show.tvdb }, network: { name: 'Net', country: { timezone: 'America/New_York' } }, webChannel: null, _embedded: { episodes: structuredClone(show.episodes) } });
  }
  return reply(404, null);
};

async function main() {
  const { TMDBApiService } = await import('../src/services/tmdb/tmdb-api.service');
  const stubbed = TMDBApiService.prototype as unknown as Record<string, unknown>;
  const find = (id: number) => { const s = tmdb.get(id); if (!s) throw Object.assign(new Error('not found'), { isAxiosError: true, response: { status: 404 } }); return s; };
  stubbed.getShow = async (id: number) => { const s = find(id); return { name: s.name, original_name: s.name, overview: '', first_air_date: s.seasons[0]?.air_date, status: s.status, in_production: s.status !== 'Ended', seasons: s.seasons, next_episode_to_air: s.next ?? null, poster_path: null }; };
  stubbed.getSeason = async (id: number, n: number) => ({ episodes: find(id).pages[n] || [] });
  stubbed.getExternalIds = async (id: number) => ({ tvdbId: find(id).tvdb, imdbId: null });

  const { prisma } = await import('../src/database/prisma');
  const { invalidateCatalog } = await import('../src/services/episode-guide.service');
  const { resetTvmazeCachesForTests } = await import('../src/services/tvmaze/tvmaze.service');
  const { runShowStatusMonitor, statusPreview } = await import('../src/services/show-status.service');
  const { ShowPrismaRepository } = await import('../src/modules/show/infra/show-prisma.repository');
  const { securityModule } = await import('../src/modules/security');
  const express = (await import('express')).default;
  const apiRoutes = (await import('../src/api/v1')).default;
  await prisma.$executeRawUnsafe('TRUNCATE "NotificationDelivery", "PushSubscription", "NotificationPreference", "EpisodeUnwatch", "EpisodeWatch", "MovieWatch", "Movie", "Show", "User" CASCADE');

  const app = express(); app.use(express.json()); app.use('/api/v1', apiRoutes);
  const server = await new Promise<http.Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const user = await prisma.user.create({ data: { email: `toggle-${crypto.randomUUID()}@example.invalid`, username: 'toggle', password: 'not-a-password' } });
  const other = await prisma.user.create({ data: { email: `other-${crypto.randomUUID()}@example.invalid`, username: 'other', password: 'not-a-password' } });
  const auth = (id: string) => `Bearer ${securityModule.Commands.GenerateTokenCommand.execute(id)}`;
  const call = async (method: string, path: string, body?: unknown, who = user.id) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: auth(who) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const mark = (showId: string, season: number, episode: number, watched: boolean, who = user.id) => call('PUT', `/show/${showId}/episodes/${season}/${episode}`, { watched }, who);
  const markSeason = (showId: string, season: number) => call('POST', `/show/${showId}/seasons/${season}/watched`);
  const row = (id: string) => prisma.show.findUniqueOrThrow({ where: { id } });
  const summary = async (id: string) => (await call('GET', `/show/${id}/tracking`)).json;
  const providerChanged = (tmdbId: number) => { invalidateCatalog(tmdbId); resetTvmazeCachesForTests(); };
  const addShow = async (name: string, tmdbId: number, s: TmdbSeries, data: Record<string, unknown> = {}, tvmazeEpisodes: TvEpisode[] | null = tvFromTmdb(s)) => {
    tmdb.set(tmdbId, s);
    if (tvmazeEpisodes && s.tvdb) tvmaze.set(10_000 + tmdbId, { tvdb: s.tvdb, episodes: tvmazeEpisodes });
    return prisma.show.create({ data: { userId: user.id, name, tmdbId, status: 'watching', favorite: true, ...data } });
  };
  // Every field automatic statuses must never touch.
  const untouched = (s: Awaited<ReturnType<typeof row>>) => ({ seasonsWatched: s.seasonsWatched, episodesWatched: s.episodesWatched, favorite: s.favorite, tmdbId: s.tmdbId, name: s.name, posterURL: s.posterURL, overview: s.overview });

  // ===== 1. Lifecycle: 7/8 Watching -> finale -> Completed -> S2 announced -> S2 premieres -> Watching -> Completed =====
  const life = series('Lifecycle', 7001, { 1: episodes(8, -80) }, { status: 'Returning Series' });
  const lifeShow = await addShow('Lifecycle', 5001, life);
  for (let n = 1; n <= 7; n++) assert.equal((await mark(lifeShow.id, 1, n, true)).status, 200);
  assert.equal((await row(lifeShow.id)).status, 'watching', '7 of 8 watched: still Watching');
  const before = untouched(await row(lifeShow.id));
  const finale = await mark(lifeShow.id, 1, 8, true);
  assert.deepEqual([finale.json.statusChange?.to, finale.json.status], ['completed', 'completed'], 'watching the finale completes it in the same request');
  let s = await row(lifeShow.id);
  assert.deepEqual([s.status, s.completed, s.completedMonitorFrom instanceof Date], ['completed', true, true]);
  assert.deepEqual(untouched(s), before, 'only status fields changed');
  assert.equal((await mark(lifeShow.id, 1, 8, true)).json.statusChange, null, 'repeating the action changes nothing');

  // Season 2 announced (future dates, TMDB next episode, TVMaze future listings): stays Completed.
  life.pages[2] = episodes(6, 20); life.seasons.push({ season_number: 2, episode_count: 6, air_date: day(20) });
  life.next = { season_number: 2, episode_number: 1, air_date: day(20) };
  tvmaze.get(15001)!.episodes = tvFromTmdb(life);
  providerChanged(5001);
  const featureSince = new Date(Date.now() - 30 * DAY);   // tests run on any date; production uses AUTO_STATUS_SINCE
  let report = await runShowStatusMonitor(new Date(), { featureSince });
  assert.equal(report.reopened, 0); assert.equal((await row(lifeShow.id)).status, 'completed', 'announced season: still Completed');

  // S2E1 premieres (TMDB date today, TVMaze aired 3 hours ago) after the show was completed.
  await prisma.show.update({ where: { id: lifeShow.id }, data: { completedMonitorFrom: new Date(Date.now() - 5 * DAY) } });   // completed 5 days ago
  life.pages[2] = [{ ...life.pages[2][0], air_date: day(0) }, ...episodes(5, 7, 7, 2)];
  life.next = { season_number: 2, episode_number: 2, air_date: day(7) };
  tvmaze.get(15001)!.episodes = [...tvFromTmdb({ ...life, pages: { 1: life.pages[1] } }), tvEp(2, 1, hoursAgo(3)), ...life.pages[2].slice(1).map(e => tvEp(2, e.episode_number, new Date(`${e.air_date}T02:00:00Z`)))];
  providerChanged(5001);
  const watchesBefore = await prisma.episodeWatch.count();
  report = await runShowStatusMonitor(new Date(), { featureSince });
  assert.equal(report.reopened, 1, 'verified premiere reopens it in the background');
  s = await row(lifeShow.id);
  assert.deepEqual([s.status, s.completed, s.completedMonitorFrom], ['watching', false, null]);
  assert.deepEqual(untouched(s), before);
  assert.equal(await prisma.episodeWatch.count(), watchesBefore, 'no watch records created or removed');
  const stamp = s.updatedAt;
  report = await runShowStatusMonitor(new Date(), { featureSince });   // a second pass, as after a restart
  assert.equal((await row(lifeShow.id)).updatedAt.getTime(), stamp.getTime(), 'repeated passes write nothing');

  // Season 2 still airing: watching every released episode does not complete it.
  assert.equal((await mark(lifeShow.id, 2, 1, true)).json.statusChange, null);
  assert.equal((await row(lifeShow.id)).status, 'watching', 'current season still airing');
  // Season 2 finishes airing; the bulk season action completes it.
  life.pages[2] = episodes(6, -50, 7); life.next = null;
  tvmaze.get(15001)!.episodes = tvFromTmdb(life);
  providerChanged(5001);
  const bulk = await markSeason(lifeShow.id, 2);
  assert.deepEqual([bulk.json.statusChange?.to, (await row(lifeShow.id)).status], ['completed', 'completed'], 'completing season 2 completes it again');
  // Unmarking an episode of a verified-complete show reopens it; marking it again completes it.
  assert.equal((await mark(lifeShow.id, 2, 6, false)).json.statusChange?.to, 'watching');
  assert.equal((await mark(lifeShow.id, 2, 6, true)).json.statusChange?.to, 'completed');
  console.log('✓ lifecycle: finale -> Completed, announced season stays Completed, verified premiere -> Watching, next season -> Completed');

  // ===== 2. Not completed: still airing, gaps, incomplete or contradictory data =====
  const airing = await addShow('Still Airing', 5002, series('Still Airing', 7002, { 1: [...episodes(7, -60), { episode_number: 8, name: 'E8', air_date: day(5), runtime: null }] }, { next: { season_number: 1, episode_number: 8, air_date: day(5) } }));
  await markSeason(airing.id, 1);
  assert.equal((await row(airing.id)).status, 'watching', 'all released watched but E8 still to air');
  const gaps = await addShow('Gaps', 5003, series('Gaps', 7003, { 1: episodes(4, -60) }));
  assert.equal((await mark(gaps.id, 1, 4, true)).json.statusChange, null, 'earlier episodes unwatched');
  const incomplete = series('Incomplete', 7004, { 1: episodes(4, -60) }); incomplete.seasons[0].episode_count = 6;
  const incompleteShow = await addShow('Incomplete', 5004, incomplete);
  await markSeason(incompleteShow.id, 1);
  assert.equal((await row(incompleteShow.id)).status, 'watching', 'TMDB declares more episodes than it lists');
  const conflict = series('Conflict', 7005, { 1: episodes(4, -60) });
  const conflictShow = await addShow('Conflict', 5005, conflict, {}, [...tvFromTmdb(conflict), tvEp(1, 5, new Date(Date.now() + 9 * DAY))]);
  await markSeason(conflictShow.id, 1);
  assert.equal((await row(conflictShow.id)).status, 'watching', 'TVMaze lists an unaired fifth episode');
  const numbering = series('Yearly', 7006, { 1: episodes(4, -60) });
  const numberingShow = await addShow('Yearly', 5006, numbering, {}, tvFromTmdb(numbering).map(e => ({ ...e, season: 2026 })));
  await markSeason(numberingShow.id, 1);
  assert.equal((await row(numberingShow.id)).status, 'watching', 'TVMaze numbers seasons differently: no guessing');
  const unlisted = await addShow('Not On TVMaze', 5007, series('Not On TVMaze', null, { 1: episodes(3, -60) }), {}, null);
  assert.equal((await markSeason(unlisted.id, 1)).json.statusChange?.to, 'completed', 'not on TVMaze: TMDB alone verifies a finished season');
  const specials = await addShow('With Specials', 5008, series('With Specials', 7008, { 1: episodes(3, -60) }));
  tmdb.get(5008)!.seasons.push({ season_number: 0, episode_count: 2, air_date: day(-10) }); tmdb.get(5008)!.pages[0] = episodes(2, -10);
  assert.equal((await markSeason(specials.id, 1)).json.statusChange?.to, 'completed', 'unwatched specials never block completion');
  console.log('✓ no completion while airing, with gaps, incomplete or contradictory data; specials excluded; TMDB-only when not on TVMaze');

  // ===== 3. Manual statuses are never changed =====
  for (const [i, status] of ['dropped', 'paused', 'planned'].entries()) {
    const manual = await addShow(`Manual ${status}`, 5100 + i, series(`Manual ${status}`, 7100 + i, { 1: episodes(3, -60) }), { status });
    await markSeason(manual.id, 1);
    assert.equal((await row(manual.id)).status, status, `${status} is never changed automatically`);
  }
  const noStatus = await addShow('No Status', 5200, series('No Status', 7200, { 1: episodes(2, -60) }), { status: null });
  await markSeason(noStatus.id, 1);
  assert.equal((await row(noStatus.id)).status, null, 'no status stays no status');
  // Another user's request never touches this library.
  assert.equal((await mark(lifeShow.id, 1, 1, false, other.id)).status, 404);
  console.log('✓ Dropped, Paused, Planned and no status preserved; user-scoped');

  // ===== 4. Legacy saved positions keep their meaning; unwatching never rewrites them =====
  const legacySeries = series('Legacy', 7300, { 1: episodes(8, -400), 2: episodes(8, -300), 3: episodes(8, -100) });
  const watchedKeys = async (id: string) => {
    const keys: string[] = [];
    for (const n of [1, 2, 3]) {
      const guide = (await call('GET', `/show/${id}/episodes?season=${n}`)).json;
      for (const e of guide.episodes) if (e.watched) keys.push(`S${n}E${e.number}`);
    }
    return keys;
  };
  const range = (season: number, to: number) => Array.from({ length: to }, (_, i) => `S${season}E${i + 1}`);
  const cases: [string, number, number, string[]][] = [
    ['S02E08', 2, 8, [...range(1, 8), ...range(2, 8)]],
    ['S02E00', 2, 0, range(1, 8)],
    ['S03E00', 3, 0, [...range(1, 8), ...range(2, 8)]],
    ['S02E03', 2, 3, [...range(1, 8), ...range(2, 3)]],
  ];
  for (const [label, seasonsWatched, episodesWatched, expected] of cases) {
    const legacy = await addShow(`Legacy ${label}`, 5300 + seasonsWatched * 10 + episodesWatched, structuredClone(legacySeries), { seasonsWatched, episodesWatched, status: 'paused' });
    assert.deepEqual(await watchedKeys(legacy.id), expected, `${label} covers exactly what it always did`);
    assert.equal((await summary(legacy.id)).watchedCount, expected.length);
  }
  // S02E03 plus explicit records, then unwatch and re-watch around the saved position.
  const mixed = await addShow('Legacy Mixed', 5399, structuredClone(legacySeries), { seasonsWatched: 2, episodesWatched: 3, status: 'paused' });
  await prisma.episodeWatch.create({ data: { showId: mixed.id, season: 2, episode: 2 } });   // individually logged and covered ("both")
  await mark(mixed.id, 2, 5, true);                                                        // individually logged beyond the position
  const position = async () => { const r = await row(mixed.id); return [r.seasonsWatched, r.episodesWatched]; };
  assert.deepEqual(await position(), [2, 3], 'watching never moves the saved position');
  assert.deepEqual(await watchedKeys(mixed.id), [...range(1, 8), ...range(2, 3), 'S2E5']);
  let progress = (await summary(mixed.id)).progressPercent;
  // Unwatch an episode only the position covers: it really becomes unwatched, the position stays S02E03.
  const legacyUnwatch = await mark(mixed.id, 1, 4, false);
  assert.equal(legacyUnwatch.status, 200);
  assert.deepEqual(await position(), [2, 3]);
  assert.ok(!(await watchedKeys(mixed.id)).includes('S1E4'), 'unwatched although the position covers it');
  assert.ok((await summary(mixed.id)).progressPercent < progress, 'progress goes down');
  assert.equal(await prisma.episodeUnwatch.count({ where: { showId: mixed.id } }), 1);
  await mark(mixed.id, 1, 4, false);
  assert.equal(await prisma.episodeUnwatch.count({ where: { showId: mixed.id } }), 1, 'idempotent');
  // Watch it again: exactly the previous state, no new record.
  await mark(mixed.id, 1, 4, true);
  assert.equal(await prisma.episodeUnwatch.count({ where: { showId: mixed.id } }), 0);
  assert.equal(await prisma.episodeWatch.count({ where: { showId: mixed.id, season: 1, episode: 4 } }), 0, 'no duplicate watch record');
  assert.equal((await summary(mixed.id)).progressPercent, progress, 'back to the original progress');
  // "Both" (logged and covered): unwatching removes the record and the coverage.
  await mark(mixed.id, 2, 2, false);
  assert.ok(!(await watchedKeys(mixed.id)).includes('S2E2'));
  assert.equal(await prisma.episodeWatch.count({ where: { showId: mixed.id, season: 2, episode: 2 } }), 0);
  // Individually logged only: plain removal, no unwatch record.
  await mark(mixed.id, 2, 5, false);
  assert.ok(!(await watchedKeys(mixed.id)).includes('S2E5'));
  assert.equal(await prisma.episodeUnwatch.count({ where: { showId: mixed.id, season: 2, episode: 5 } }), 0);
  // Mark season 2: restores coverage where the position covers, records the rest.
  await markSeason(mixed.id, 2);
  assert.deepEqual(await watchedKeys(mixed.id), [...range(1, 8), ...range(2, 8)]);
  assert.equal(await prisma.episodeUnwatch.count({ where: { showId: mixed.id } }), 0);
  assert.deepEqual(await position(), [2, 3], 'the saved position was never rewritten');
  progress = (await summary(mixed.id)).progressPercent;
  assert.equal(typeof progress, 'number');
  // A watching show covered by S03E00 whose third season is out but unwatched stays Watching; with S3 unaired it completes.
  const legacyDone = series('Legacy Done', 7400, { 1: episodes(4, -400), 2: episodes(4, -300), 3: episodes(4, 60) });
  legacyDone.next = { season_number: 3, episode_number: 1, air_date: day(60) };
  const legacyDoneShow = await addShow('Legacy Done', 5400, legacyDone, { seasonsWatched: 3, episodesWatched: 0, status: 'watching' });
  assert.equal((await mark(legacyDoneShow.id, 2, 4, true)).json.statusChange?.to, 'completed', 'S03E00 with season 3 unaired: completed on the next action');
  assert.deepEqual([(await row(legacyDoneShow.id)).seasonsWatched, (await row(legacyDoneShow.id)).episodesWatched], [3, 0]);
  console.log('✓ legacy positions S02E08, S02E00, S03E00, S02E03 keep their meaning; unwatch/re-watch never rewrites them');

  // ===== 5. Read-only preview =====
  const snapshot = JSON.stringify(await prisma.show.findMany({ orderBy: { id: 'asc' } }));
  // A show finished long ago and left on Watching: only the preview mentions it; nothing changes on its own.
  const stale = await addShow('Finished Long Ago', 5500, series('Finished Long Ago', 7500, { 1: episodes(3, -200) }), { seasonsWatched: 2, episodesWatched: 0 });
  const snapshot2 = JSON.stringify(await prisma.show.findMany({ orderBy: { id: 'asc' } }));
  report = await runShowStatusMonitor(new Date(), { featureSince });
  assert.equal((await row(stale.id)).status, 'watching', 'never changed in bulk without approval');
  const preview = await call('GET', '/show/status-preview');
  assert.equal(preview.status, 200);
  const staleRow = preview.json.shows.find((r: { showId: string }) => r.showId === stale.id);
  assert.deepEqual([staleRow.retroactive?.to, staleRow.automatic], ['completed', null], 'listed as a retroactive change awaiting approval');
  assert.ok(preview.json.shows.filter((r: { status: string }) => ['dropped', 'paused', 'planned'].includes(r.status)).every((r: { automatic: unknown; retroactive: unknown }) => !r.automatic && !r.retroactive));
  assert.equal(JSON.stringify(await prisma.show.findMany({ orderBy: { id: 'asc' } })), snapshot2, 'the preview writes nothing');
  assert.ok(snapshot.length > 0);
  console.log('✓ status preview is read-only; shows finished before automatic statuses are only proposed, never changed');

  // ===== 6. Manual status edits still maintain the completion boundary (existing behavior) =====
  const repository = new ShowPrismaRepository();
  const manualShow = await addShow('Manual Edit', 5600, series('Manual Edit', 7600, { 1: episodes(2, -60) }));
  await repository.update(manualShow.id, { status: 'completed', completed: true }, user.id);
  const monitored = await row(manualShow.id);
  assert.ok(monitored.completedMonitorFrom instanceof Date);
  await repository.update(manualShow.id, { favorite: false }, user.id);
  assert.deepEqual((await row(manualShow.id)).completedMonitorFrom, monitored.completedMonitorFrom);
  await repository.update(manualShow.id, { status: 'dropped', completed: false }, user.id);
  assert.equal((await row(manualShow.id)).status, 'dropped');
  console.log('✓ manual status edits keep the completion boundary');

  server.close();
  await prisma.$executeRawUnsafe('TRUNCATE "EpisodeUnwatch", "EpisodeWatch", "Show", "User" CASCADE');
  console.log('Episode toggle integration tests passed');
  await prisma.$disconnect();
}
main().catch(error => { console.error(error); process.exit(1); });
