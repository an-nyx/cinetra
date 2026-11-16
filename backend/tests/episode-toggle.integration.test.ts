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

if (!/^postgresql:\/\/postgres:status-test@127\.0\.0\.1:55439\/cinetra_status_test$/.test(process.env.DATABASE_URL ?? '')) throw new Error('Use the isolated episode toggle test database only.');
process.env.TV_STATUS_RECONCILIATION_MODE = 'full-library';
process.env.TV_STATUS_RECONCILIATION_ENABLED = 'true';
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
  let providerDelay = 0;
  stubbed.getShow = async (id: number) => { if (providerDelay) await new Promise(r => setTimeout(r, providerDelay)); const s = find(id); return { name: s.name, original_name: s.name, overview: '', first_air_date: s.seasons[0]?.air_date, status: s.status, in_production: s.status !== 'Ended', seasons: s.seasons, next_episode_to_air: s.next ?? null, poster_path: null }; };
  stubbed.getSeason = async (id: number, n: number) => ({ episodes: find(id).pages[n] || [] });
  stubbed.getExternalIds = async (id: number) => ({ tvdbId: find(id).tvdb, imdbId: null });

  const { prisma } = await import('../src/database/prisma');
  const { invalidateCatalog } = await import('../src/services/episode-guide.service');
  const { resetTvmazeCachesForTests } = await import('../src/services/tvmaze/tvmaze.service');
  const { runShowStatusMonitor, statusPreview, evaluateShow, applyTransition, startShowStatusMonitor, showStatusMonitorStatus, queueStatusReconciliation, reconcileAfterAction } = await import('../src/services/show-status.service');
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
    let json: any = null;
    if (text) { try { json = JSON.parse(text); } catch { json = { message: text }; } }
    return { status: res.status, json };
  };
  const mark = async (showId: string, season: number, episode: number, watched: boolean, who = user.id) => {
    await call('GET', `/show/${showId}/episodes?season=${season}`, undefined, who);
    const before = await prisma.show.findUnique({ where: { id: showId } });
    const result = await call('PUT', `/show/${showId}/episodes/${season}/${episode}`, { watched }, who);
    if (result.status !== 200) return result;
    assert.equal(result.json.saved, true);
    await queueStatusReconciliation(showId, who);
    const after = await prisma.show.findUniqueOrThrow({ where: { id: showId } });
    // Status now arrives separately, after the committed watch acknowledgement.
    return { ...result, json: { ...result.json, status: after.status, statusChange: before?.status !== after.status ? { to: after.status } : null } };
  };
  const markSeason = (showId: string, season: number) => call('POST', `/show/${showId}/seasons/${season}/watched`);
  const row = (id: string) => prisma.show.findUniqueOrThrow({ where: { id } });
  const summary = async (id: string) => (await call('GET', `/show/${id}/tracking`)).json;
  const providerChanged = (tmdbId: number) => { invalidateCatalog(tmdbId); resetTvmazeCachesForTests(); };
  const addShow = async (name: string, tmdbId: number, s: TmdbSeries, data: Record<string, unknown> = {}, tvmazeEpisodes: TvEpisode[] | null = tvFromTmdb(s)) => {
    tmdb.set(tmdbId, s);
    if (tvmazeEpisodes && s.tvdb) tvmaze.set(10_000 + tmdbId, { tvdb: s.tvdb, episodes: tvmazeEpisodes });
    const show = await prisma.show.create({ data: { userId: user.id, name, tmdbId, status: 'watching', favorite: true, ...data } });
    return show;
  };
  // Every field automatic statuses must never touch.
  const untouched = (s: Awaited<ReturnType<typeof row>>) => ({ seasonsWatched: s.seasonsWatched, episodesWatched: s.episodesWatched, favorite: s.favorite, tmdbId: s.tmdbId, name: s.name, posterURL: s.posterURL, overview: s.overview });

  // Reproduce the old critical path with an 11-second provider; compare the real fast HTTP save.
  const slow = await addShow('Slow provider', 4999, series('Slow provider', 6999, { 1: episodes(2, -50) }));
  await call('GET', `/show/${slow.id}/episodes?season=1`);
  providerDelay = 11_000;
  const oldStarted = performance.now();
  await reconcileAfterAction(slow.id, user.id);
  const beforeMs = performance.now() - oldStarted;
  const newStarted = performance.now();
  const fast = await call('PUT', `/show/${slow.id}/episodes/1/1`, { watched: true });
  const afterMs = performance.now() - newStarted;
  assert.equal(fast.status, 200);
  assert.ok(beforeMs >= 11_000);
  assert.ok(afterMs < 1000, `save waited ${afterMs}ms`);
  assert.equal(await prisma.episodeWatch.count({ where: { showId: slow.id } }), 1);
  providerDelay = 0;
  await queueStatusReconciliation(slow.id, user.id);
  console.log(`Latency with 11s TMDB: old reconciliation gate ${beforeMs.toFixed(1)}ms; new committed HTTP save ${afterMs.toFixed(1)}ms`);
  invalidateCatalog(4999);
  const coldStarted = performance.now();
  const cold = await call('PUT', `/show/${slow.id}/episodes/1/1`, { watched: false });
  assert.equal(cold.status, 409, 'cold metadata fails promptly instead of waiting on TMDB');
  assert.ok(performance.now() - coldStarted < 1000);
  assert.equal(await prisma.episodeWatch.count({ where: { showId: slow.id } }), 1);

  // ===== 1. Lifecycle: 7/8 Watching -> finale -> Completed -> S2 announced -> S2 premieres -> Watching -> Completed =====
  const life = series('Lifecycle', 7001, { 1: episodes(8, -80) }, { status: 'Returning Series' });
  const lifeShow = await addShow('Lifecycle', 5001, life);
  for (let n = 1; n <= 7; n++) assert.equal((await mark(lifeShow.id, 1, n, true)).status, 200);
  assert.equal((await row(lifeShow.id)).status, 'watching', '7 of 8 watched: still Watching');
  const before = untouched(await row(lifeShow.id));
  const finale = await mark(lifeShow.id, 1, 8, true);
  assert.deepEqual([finale.json.statusChange?.to, finale.json.status], ['completed', 'completed'], 'watching the finale completes it in the background');
  let s = await row(lifeShow.id);
  assert.deepEqual([s.status, s.completed, s.completedMonitorFrom instanceof Date], ['completed', true, true]);
  assert.deepEqual(untouched(s), before, 'only status fields changed');
  assert.equal((await mark(lifeShow.id, 1, 8, true)).json.statusChange, null, 'repeating the action changes nothing');

  // Season 2 announced (future dates, TMDB next episode, TVMaze future listings): stays Completed.
  life.pages[2] = episodes(6, 20); life.seasons.push({ season_number: 2, episode_count: 6, air_date: day(20) });
  life.next = { season_number: 2, episode_number: 1, air_date: day(20) };
  tvmaze.get(15001)!.episodes = tvFromTmdb(life);
  providerChanged(5001);
  let report = await runShowStatusMonitor(new Date());
  assert.equal(report.reopened, 0); assert.equal((await row(lifeShow.id)).status, 'completed', 'announced season: still Completed');

  // S2E1 premieres (TMDB date today, TVMaze aired 3 hours ago) after the show was completed.
  await prisma.show.update({ where: { id: lifeShow.id }, data: { completedMonitorFrom: new Date(Date.now() - 5 * DAY) } });   // completed 5 days ago
  life.pages[2] = [{ ...life.pages[2][0], air_date: day(0) }, ...episodes(5, 7, 7, 2)];
  life.next = { season_number: 2, episode_number: 2, air_date: day(7) };
  tvmaze.get(15001)!.episodes = [...tvFromTmdb({ ...life, pages: { 1: life.pages[1] } }), tvEp(2, 1, hoursAgo(3)), ...life.pages[2].slice(1).map(e => tvEp(2, e.episode_number, new Date(`${e.air_date}T02:00:00Z`)))];
  providerChanged(5001);
  const watchesBefore = await prisma.episodeWatch.count();
  report = await runShowStatusMonitor(new Date());
  assert.equal(report.reopened, 1, 'verified premiere reopens it in the background');
  s = await row(lifeShow.id);
  assert.deepEqual([s.status, s.completed, s.completedMonitorFrom], ['watching', false, null]);
  assert.deepEqual(untouched(s), before);
  assert.equal(await prisma.episodeWatch.count(), watchesBefore, 'no watch records created or removed');
  const stamp = s.updatedAt;
  report = await runShowStatusMonitor(new Date());   // a second pass, as after a restart
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
  assert.equal((await markSeason(unlisted.id, 1)).json.statusChange, null, 'scoped automation requires its approved verified TVMaze identity');
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

  // ===== 5. Read-only preview with every automatic write gated off =====
  process.env.TV_STATUS_RECONCILIATION_ENABLED = 'false';
  const snapshot = JSON.stringify(await prisma.show.findMany({ orderBy: { id: 'asc' } }));
  // A show finished long ago and left on Watching: only the preview mentions it; nothing changes on its own.
  const stale = await addShow('Finished Long Ago', 5500, series('Finished Long Ago', 7500, { 1: episodes(3, -200) }), { seasonsWatched: 2, episodesWatched: 0 });
  const historicalPreview = await addShow('Historical preview gaps', 5501, series('Historical preview gaps', 7501, { 1: episodes(3, -900) }), { status: 'completed', completed: true, seasonsWatched: 1, episodesWatched: 1 });
  // These are isolated provider fixtures, not production metadata for the named shows.
  const protectedShows: Awaited<ReturnType<typeof addShow>>[] = [];
  for (const [i, name] of ['Banshee', 'Sherlock', 'The Last Kingdom'].entries()) {
    protectedShows.push(await addShow(name, 5510 + i, series(name, 7510 + i, { 1: episodes(3, -900), 2: episodes(1, -10), 3: episodes(1, 30) }),
      { status: i === 1 ? null : 'completed', completed: true, completedMonitorFrom: i === 2 ? new Date('2020-01-01') : null }));
  }
  const protectionBefore = await prisma.show.findMany({ where: { id: { in: protectedShows.map(s => s.id) } } });
  const backfill = (await import('node:fs')).readFileSync('prisma/migrations/20261115160000_manual_completion_protection/migration.sql', 'utf8').split('UPDATE')[1].split('COMMIT')[0];
  await prisma.$executeRawUnsafe('UPDATE' + backfill);
  for (const before of protectionBefore) {
    const after = await row(before.id);
    assert.equal(after.statusAutomationProtected, true);
    assert.equal(after.status, before.status);
    assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime(), 'backfill changes only protection metadata');
  }
  const historySnapshot = JSON.stringify(await Promise.all([prisma.episodeWatch.findMany({ orderBy: { id: 'asc' } }), prisma.episodeUnwatch.findMany({ orderBy: { id: 'asc' } })]));
  const snapshot2 = JSON.stringify(await prisma.show.findMany({ orderBy: { id: 'asc' } }));
  startShowStatusMonitor();
  assert.equal(showStatusMonitorStatus().running, false, 'disabled monitor never arms timers');
  assert.equal(showStatusMonitorStatus().automaticWritesEnabled, false);
  assert.equal((await mark(stale.id, 1, 3, true)).json.statusChange, null, 'episode watch cannot complete while disabled');
  assert.equal((await mark(historicalPreview.id, 1, 2, false)).json.statusChange, null, 'episode unwatch cannot reopen while disabled');
  assert.equal((await markSeason(stale.id, 1)).json.statusChange, null, 'season watch cannot complete while disabled');
  const disabledEvaluation = await evaluateShow(await row(stale.id), { fresh: true });
  assert.ok(disabledEvaluation?.transition);
  assert.equal(await applyTransition(await row(stale.id), disabledEvaluation!.transition!, new Date(), disabledEvaluation!), false, 'writer itself refuses while disabled');
  report = await runShowStatusMonitor(new Date());
  assert.equal((await row(stale.id)).status, 'watching', 'never changed in bulk without approval');
  const preview = await call('GET', '/show/status-preview');
  assert.equal(preview.status, 200);
  assert.equal(preview.json.automaticWritesEnabled, false);
  const staleRow = preview.json.shows.find((r: { showId: string }) => r.showId === stale.id);
  assert.deepEqual([staleRow.retroactive?.to, staleRow.automatic], ['completed', null], 'listed as a retroactive change awaiting approval');
  assert.deepEqual([staleRow.released, staleRow.watched, staleRow.unwatched], [3, 3, []]);
  const historicalRow = preview.json.shows.find((r: { showId: string }) => r.showId === historicalPreview.id);
  assert.deepEqual([historicalRow.retroactive?.to, historicalRow.released, historicalRow.watched, historicalRow.unwatched], ['watching', 3, 1, ['S1E2', 'S1E3']]);
  for (const protectedShow of protectedShows) {
    const entry = preview.json.shows.find((r: { showId: string }) => r.showId === protectedShow.id);
    assert.deepEqual([entry.status, entry.legacyCompletion, entry.confirmationRequired, entry.watched, entry.unwatched, entry.retroactive, entry.automatic], ['completed', true, true, null, [], null, null]);
    assert.match(entry.explanation, /actual viewing is unknown/i);
    const confirmed = await call('POST', '/show/status-preview', { confirmedCompletionBaselines: { [protectedShow.id]: new Date(`${day(-100)}T12:00:00Z`).toISOString() } });
    const confirmedEntry = confirmed.json.shows.find((r: { showId: string }) => r.showId === protectedShow.id);
    assert.deepEqual([confirmedEntry.confirmationRequired, confirmedEntry.watched, confirmedEntry.unwatched, confirmedEntry.retroactive?.to], [false, null, ['S2E1'], 'watching'], 'only post-baseline verified premieres can be proposed');
    const afterAllPremieres = await call('POST', '/show/status-preview', { confirmedCompletionBaselines: { [protectedShow.id]: new Date(`${day(-1)}T12:00:00Z`).toISOString() } });
    assert.equal(afterAllPremieres.json.shows.find((r: { showId: string }) => r.showId === protectedShow.id).retroactive, null, 'future season never reopens');
  }
  for (const invalid of ['2020-01-01', 'invalid', new Date(Date.now() + DAY).toISOString(), '2026-02-31T00:00:00.000Z']) {
    assert.equal((await call('POST', '/show/status-preview', { confirmedCompletionBaselines: { [protectedShows[0].id]: invalid } })).status, 400);
  }
  const unowned = await call('POST', '/show/status-preview', { confirmedCompletionBaselines: { [protectedShows[0].id]: new Date('2020-01-01').toISOString() } }, other.id);
  assert.deepEqual(unowned.json.shows, [], 'confirmation remains account scoped');
  const nextPreview = await call('GET', '/show/status-preview');
  assert.equal(nextPreview.json.shows.find((r: { showId: string }) => r.showId === protectedShows[0].id).confirmationRequired, true, 'preview confirmation is never persisted');
  assert.equal(JSON.stringify(await Promise.all([prisma.episodeWatch.findMany({ orderBy: { id: 'asc' } }), prisma.episodeUnwatch.findMany({ orderBy: { id: 'asc' } })])), historySnapshot, 'no invented watch/unwatch records');
  assert.equal((await call('GET', '/show/status-preview', undefined, other.id)).json.shows.length, 0, 'preview is account scoped');
  assert.ok(preview.json.shows.filter((r: { status: string }) => ['dropped', 'paused', 'planned'].includes(r.status)).every((r: { automatic: unknown; retroactive: unknown }) => !r.automatic && !r.retroactive));
  assert.equal(JSON.stringify(await prisma.show.findMany({ orderBy: { id: 'asc' } })), snapshot2, 'the preview writes nothing');
  assert.ok(snapshot.length > 0);
  process.env.TV_STATUS_RECONCILIATION_ENABLED = 'true';
  const historical = await addShow('Historical manual Completed', 5591, series('Historical manual Completed', 7591, { 1: episodes(3, -900) }), { status: 'completed', completed: true, seasonsWatched: 1, episodesWatched: 1 });
  const oldLegacy = await addShow('Old legacy only', 5592, series('Old legacy only', 7592, { 1: episodes(3, -900) }), { seasonsWatched: 1, episodesWatched: 3 });
  await runShowStatusMonitor();
  assert.equal((await row(historical.id)).status, 'watching');
  for (const protectedShow of protectedShows) {
    assert.equal((await row(protectedShow.id)).status, protectedShow.status, 'even enabled monitor preserves untracked manual Completed');
    assert.equal((await row(protectedShow.id)).completed, true);
  }
  assert.equal((await row(oldLegacy.id)).status, 'completed');
  const manualResponse = await call('PUT', `/show/${historical.id}`, { status: 'completed', completed: true });
  assert.equal(manualResponse.json.status, 'watching', 'manual Completed uses the same verified gap rules');
  await prisma.show.update({ where: { id: historical.id }, data: { status: 'completed', completed: true } });
  const candidate = await row(historical.id);
  const evaluated = await evaluateShow(candidate, { fresh: true });
  assert.ok(evaluated?.transition);
  await prisma.episodeWatch.create({ data: { showId: candidate.id, season: 1, episode: 2, watchedAt: new Date('2020-01-01') } });
  assert.equal(await applyTransition(candidate, evaluated!.transition!, new Date(), evaluated!), false, 'concurrent watch changes invalidate evaluation');
  const fresh = await row(candidate.id);
  const evaluation2 = await evaluateShow(fresh, { fresh: true });
  await prisma.show.update({ where: { id: fresh.id }, data: { status: 'paused' } });
  assert.equal(await applyTransition(fresh, evaluation2!.transition!, new Date(), evaluation2!), false, 'concurrent status edits preserved');
  assert.equal((await row(fresh.id)).status, 'paused');
  const gapPreview = (await statusPreview(user.id)).find(r => r.showId === fresh.id)!;
  assert.equal(gapPreview.retroactive, null, 'paused never proposed');
  await prisma.episodeWatch.create({ data: { showId: oldLegacy.id, season: 9, episode: 99 } });
  await prisma.show.update({ where: { id: oldLegacy.id }, data: { status: 'watching', completed: false } });
  const uncertain = await evaluateShow(await row(oldLegacy.id));
  assert.equal(uncertain?.transition, null, 'unmapped saved identities block completion');
  assert.match(uncertain!.evidenceIssue!, /identity does not fit/);
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

  const legacyToProtect = await addShow('Unrecorded completion starts tracking', 5999, series('Unrecorded completion starts tracking', 7999, { 1: episodes(3, -900) }), { status: 'completed', completed: true });
  const legacyHistoryBefore = await prisma.episodeWatch.count({ where: { showId: legacyToProtect.id } });
  assert.equal((await mark(legacyToProtect.id, 1, 1, true)).json.statusChange, null, 'first tracking action cannot overwrite a legacy manual completion');
  assert.equal((await row(legacyToProtect.id)).status, 'completed');
  assert.equal((await row(legacyToProtect.id)).statusAutomationProtected, true, 'legacy protection persists after tracking starts');
  assert.equal(await prisma.episodeWatch.count({ where: { showId: legacyToProtect.id } }), legacyHistoryBefore + 1, 'only the explicitly requested watch is recorded');
  await runShowStatusMonitor();
  assert.equal((await row(legacyToProtect.id)).status, 'completed', 'full-library monitor honors durable legacy protection');
  console.log('✓ full-library behavior beyond the old six, including durable legacy protection after first tracking');

  server.close();
  await prisma.$executeRawUnsafe('TRUNCATE "EpisodeUnwatch", "EpisodeWatch", "Show", "User" CASCADE');
  console.log('Episode toggle integration tests passed');
  await prisma.$disconnect();
}
main().catch(error => { console.error(error); process.exit(1); });
