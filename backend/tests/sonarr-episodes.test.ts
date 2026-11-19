import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';

// Obviously fake values: every Sonarr call goes to an in-memory fake (or a mocked HTTP adapter). Nothing is downloaded.
const FAKE_KEY = 'f00dfeedf00dfeedf00dfeedf00dfeed';
const FAKE_URL = 'https://sonarr.example.test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'sonarr-test-only-secret';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://unused:unused@127.0.0.1:1/unused';

import { SonarrClient, SonarrError, readSonarrConfig, type SonarrEpisodeResource, type SonarrSeriesResource } from '../src/services/sonarr/sonarr-client';
import { episodeState, parseEpisodeRequest, planRequest, seasonPassBody, seasonViews, cleanEpisodes, type EpisodeRequest } from '../src/services/sonarr/sonarr-episodes.model';
import { createSonarrService, SonarrRequestError, type SonarrDeps } from '../src/services/sonarr/sonarr.service';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, run: () => Promise<void> | void) => tests.push([name, run]);

/* ---------- Fixtures ---------- */

const NOW = Date.parse('2026-11-19T12:00:00Z');
const PAST = '2026-01-10T02:00:00Z';
const FUTURE = '2027-03-01T02:00:00Z';
const SHOW_ID = '11111111-1111-4111-8111-111111111111';
const OWNER = 'owner-user';
const SERIES_ID = 53;

const LOOKUP: SonarrSeriesResource = { title: 'Breaking Bad', year: 2008, tvdbId: 81189, tmdbId: 1396, imdbId: 'tt0903747', titleSlug: 'breaking-bad', seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }, { seasonNumber: 2 }, { seasonNumber: 3 }] };
const ep = (id: number, seasonNumber: number, episodeNumber: number, extra: Partial<SonarrEpisodeResource> = {}): SonarrEpisodeResource =>
  ({ id, seriesId: SERIES_ID, seasonNumber, episodeNumber, title: `S${seasonNumber}E${episodeNumber}`, airDateUtc: PAST, hasFile: false, monitored: false, ...extra });

/**
 * Sonarr numbering intentionally differs from TMDB here (TMDB would split season 1 differently): the picker and the
 * requests only ever use Sonarr's IDs and numbers.
 */
function freshLibrary() {
  return {
    series: { ...LOOKUP, id: SERIES_ID, monitored: false, seasons: [0, 1, 2, 3].map(seasonNumber => ({ seasonNumber, monitored: false })) } as SonarrSeriesResource,
    episodes: [
      ep(900, 0, 1),                                   // special, aired, missing
      ep(1001, 1, 1, { hasFile: true }),               // downloaded
      ep(1002, 1, 2),                                  // missing
      ep(1003, 1, 3),                                  // missing
      ep(2001, 2, 1),                                  // missing
      ep(2002, 2, 2, { airDateUtc: FUTURE }),          // not released
      ep(3001, 3, 1, { airDateUtc: null }),            // TBA
    ],
  };
}

class FakeSonarr {
  readonly baseUrl = FAKE_URL;
  calls: string[] = [];
  lib = freshLibrary();
  inLibrary = true;
  failOn: Record<string, SonarrError> = {};
  /** Simulates Sonarr acknowledging a write without applying it. */
  ignoreMonitor = false;
  searched: number[][] = [];
  seasonPasses: unknown[] = [];
  monitorBodies: number[][] = [];
  delay = 0;
  private hit(name: string) { this.calls.push(name); const error = this.failOn[name]; if (error) throw error; }
  async lookup(kind: string, id: number) { this.hit(`lookup:${kind}:${id}`); return kind === 'tvdb' && id === 81189 ? [LOOKUP] : []; }
  async seriesByTvdbId(tvdbId: number) { this.hit('seriesByTvdb'); return this.inLibrary && tvdbId === 81189 ? [structuredClone(this.lib.series)] : []; }
  async seriesById(id: number) { this.hit('seriesById'); assert.equal(id, SERIES_ID); return structuredClone(this.lib.series); }
  async episodes(seriesId: number) { this.hit('episodes'); assert.equal(seriesId, SERIES_ID); return structuredClone(this.lib.episodes); }
  async monitorEpisodes(ids: number[]) {
    this.hit('monitorEpisodes');
    if (this.delay) await new Promise(resolve => setTimeout(resolve, this.delay));
    this.monitorBodies.push([...ids]);
    if (!this.ignoreMonitor) for (const episode of this.lib.episodes) if (ids.includes(episode.id as number)) episode.monitored = true;
    return this.lib.episodes.filter(episode => ids.includes(episode.id as number));
  }
  /** Sonarr v4 SeasonPassController without monitoringOptions: series/season flags only, no episode cascade. */
  async seasonPass(body: { series: Array<{ id: number; monitored?: boolean; seasons: Array<{ seasonNumber: number; monitored: boolean }> }> }) {
    this.hit('seasonPass');
    this.seasonPasses.push(structuredClone(body));
    assert.equal('monitoringOptions' in body, false, 'monitoringOptions would make Sonarr rewrite episode flags');
    for (const item of body.series) {
      assert.equal(item.id, SERIES_ID);
      if (item.monitored !== undefined) this.lib.series.monitored = item.monitored;
      for (const season of this.lib.series.seasons || []) {
        const change = item.seasons.find(entry => entry.seasonNumber === season.seasonNumber);
        if (change) season.monitored = change.monitored;
      }
    }
    return {};
  }
  async searchEpisodes(ids: number[]) { this.hit('searchEpisodes'); this.searched.push([...ids]); return { id: 1 }; }
  async rootFolders() { return [{ id: 2, path: '/tv', accessible: true }]; }
  async qualityProfiles() { return [{ id: 4, name: 'HD-1080p' }]; }
  monitoredIds() { return this.lib.episodes.filter(episode => episode.monitored).map(episode => episode.id).sort(); }
}

function setup(options: { fake?: FakeSonarr | null; allowed?: boolean } = {}) {
  const fake = options.fake === undefined ? new FakeSonarr() : options.fake;
  const deps: SonarrDeps = {
    client: () => (fake as unknown as SonarrClient) ?? null,
    externalIds: async () => ({ tvdbId: 81189, imdbId: 'tt0903747' }),
    findShow: async (showId, userId) => showId === SHOW_ID && userId === OWNER ? { id: SHOW_ID, name: 'Breaking Bad', tmdbId: 1396, posterURL: null } : null,
    isAllowed: async userId => options.allowed !== false && userId === OWNER,
    now: () => NOW,
  };
  if (fake === null) deps.client = () => null;
  return { svc: createSonarrService(deps), fake: fake as FakeSonarr };
}

/** Builds a request the way the dialog does: from the plan the user saw. */
function confirmed(fake: FakeSonarr, selection: Pick<EpisodeRequest, 'mode'> & Partial<Pick<EpisodeRequest, 'seasons' | 'episodeIds' | 'search'>>): EpisodeRequest {
  const request = { seasons: [], episodeIds: [], search: false, ...selection };
  const plan = planRequest(fake.lib.series, fake.lib.episodes, request, NOW);
  assert.ok(plan.ok, 'fixture selection should be valid');
  return { tvdbId: 81189, ...request, expected: { monitor: plan.monitorIds.length, seasons: plan.seasonNumbers.length, search: plan.searchIds.length, enableSeries: plan.enableSeries } };
}
const writes = (fake: FakeSonarr) => fake.calls.filter(call => ['monitorEpisodes', 'seasonPass', 'searchEpisodes'].includes(call));
async function rejects(promise: Promise<unknown>, status: number, code: string) {
  try { await promise; } catch (error) {
    assert.ok(error instanceof SonarrRequestError, `expected SonarrRequestError, got ${error}`);
    assert.equal(error.status, status); assert.equal(error.code, code); return error;
  }
  assert.fail(`expected ${status} ${code}`);
}

/* ---------- Model ---------- */

test('episode state: file, missing (released) and not yet released (future or TBA)', () => {
  assert.equal(episodeState({ hasFile: true, airDateUtc: FUTURE }, NOW), 'downloaded');
  assert.equal(episodeState({ hasFile: false, airDateUtc: PAST }, NOW), 'missing');
  assert.equal(episodeState({ hasFile: false, airDateUtc: FUTURE }, NOW), 'unreleased');
  assert.equal(episodeState({ hasFile: false, airDateUtc: null }, NOW), 'unreleased');
  assert.equal(episodeState({ hasFile: false, airDateUtc: 'garbage' }, NOW), 'unreleased');
});

test('season views: Sonarr numbering and flags, specials kept separate, foreign records ignored', () => {
  const { series, episodes } = freshLibrary();
  const clean = cleanEpisodes([...episodes, { ...ep(5, 1, 9), seriesId: 999 }, { seasonNumber: 1, episodeNumber: 4 } as SonarrEpisodeResource], SERIES_ID);
  assert.equal(clean.length, episodes.length, 'records of another series or without an id are dropped');
  const views = seasonViews(series, clean, NOW);
  assert.deepEqual(views.map(season => season.seasonNumber), [0, 1, 2, 3]);
  assert.deepEqual(views[1].episodes.map(episode => [episode.id, episode.state]), [[1001, 'downloaded'], [1002, 'missing'], [1003, 'missing']]);
  assert.deepEqual(views[2].episodes.map(episode => episode.state), ['missing', 'unreleased']);
  assert.equal(views[3].episodes[0].airDateUtc, null);
});

test('requests: strict validation per mode', () => {
  const expected = { monitor: 0, seasons: 0, search: 0, enableSeries: false };
  const ok = (body: Record<string, unknown>) => parseEpisodeRequest({ tvdbId: 81189, search: false, expected, ...body }).ok;
  assert.ok(ok({ mode: 'series' }));
  assert.ok(ok({ mode: 'seasons', seasons: [1, 3] }));
  assert.ok(ok({ mode: 'episodes', episodeIds: [1002] }));
  assert.equal(ok({ mode: 'series', seasons: [1] }), false);
  assert.equal(ok({ mode: 'seasons', seasons: [] }), false);
  assert.equal(ok({ mode: 'seasons', seasons: [1], episodeIds: [1002] }), false);
  assert.equal(ok({ mode: 'episodes', episodeIds: [] }), false);
  assert.equal(ok({ mode: 'episodes', episodeIds: [-1] }), false);
  assert.equal(ok({ mode: 'episodes', episodeIds: ['1002'] }), false);
  assert.equal(ok({ mode: 'seasons', seasons: [1.5] }), false);
  assert.equal(ok({ mode: 'everything' }), false);
  assert.equal(ok({ mode: 'series', monitored: false }), false, 'unknown fields (e.g. an unmonitor flag) are refused');
  assert.equal(ok({ mode: 'series', path: '/etc' }), false);
  assert.equal(parseEpisodeRequest({ tvdbId: 81189, mode: 'series', search: 'yes', expected }).ok, false);
  assert.equal(parseEpisodeRequest({ tvdbId: 81189, mode: 'series', search: false }).ok, false, 'the confirmation summary is required');
  assert.equal(parseEpisodeRequest({ tvdbId: 81189, mode: 'series', search: false, expected: { ...expected, search: 2 } }).ok, false, 'no search count without search');
  assert.equal(parseEpisodeRequest({ tvdbId: 81189, mode: 'series', search: false, expected: { ...expected, extra: 1 } }).ok, false);
  assert.equal(parseEpisodeRequest({ tvdbId: 81189, mode: 'series', search: false, expected: { ...expected, monitor: -1 } }).ok, false);
  const parsed = parseEpisodeRequest({ tvdbId: 81189, mode: 'episodes', episodeIds: [1002, 1002, 1003], search: false, expected });
  assert.ok(parsed.ok && parsed.value.episodeIds.length === 2, 'duplicates collapse');
  assert.equal(parseEpisodeRequest({ tvdbId: 81189, mode: 'episodes', episodeIds: Array.from({ length: 5001 }, (_, i) => i + 1), search: false, expected }).ok, false);
});

test('plan: entire series = every regular episode, never specials', () => {
  const { series, episodes } = freshLibrary();
  const plan = planRequest(series, episodes, { mode: 'series', seasons: [], episodeIds: [], search: true }, NOW);
  assert.ok(plan.ok);
  assert.deepEqual(plan.monitorIds.sort(), [1001, 1002, 1003, 2001, 2002, 3001]);
  assert.ok(!plan.selectedIds.includes(900));
  assert.deepEqual(plan.seasonNumbers, [1, 2, 3]);
  assert.equal(plan.enableSeries, true);
  assert.deepEqual(plan.searchIds.sort(), [1002, 1003, 2001], 'released and missing only');
  assert.deepEqual(plan.counts, { selected: 6, alreadyMonitored: 0, downloaded: 1, missing: 3, unreleased: 2 });
});

test('plan: unknown seasons or episodes are refused, never guessed', () => {
  const { series, episodes } = freshLibrary();
  assert.deepEqual(planRequest(series, episodes, { mode: 'seasons', seasons: [7], episodeIds: [], search: false }, NOW), { ok: false, code: 'unknown_season' });
  assert.deepEqual(planRequest(series, episodes, { mode: 'episodes', seasons: [], episodeIds: [1002, 424242], search: false }, NOW), { ok: false, code: 'unknown_episode' });
  const empty = { ...series, seasons: [...(series.seasons || []), { seasonNumber: 4, monitored: false }] };
  assert.deepEqual(planRequest(empty, episodes, { mode: 'seasons', seasons: [4], episodeIds: [], search: false }, NOW), { ok: false, code: 'empty_selection' });
});

test('plan: warns when enabling series monitoring activates episodes already flagged outside the selection', () => {
  const { series, episodes } = freshLibrary();
  episodes.find(episode => episode.id === 2001)!.monitored = true;
  const plan = planRequest(series, episodes, { mode: 'episodes', seasons: [], episodeIds: [1002], search: false }, NOW);
  assert.ok(plan.ok); assert.equal(plan.alsoActivated, 1);
  const monitoredSeries = planRequest({ ...series, monitored: true }, episodes, { mode: 'episodes', seasons: [], episodeIds: [1002], search: false }, NOW);
  assert.ok(monitoredSeries.ok); assert.equal(monitoredSeries.alsoActivated, 0); assert.equal(monitoredSeries.enableSeries, false);
});

test('season pass body: only changing flags, never monitoringOptions', () => {
  assert.deepEqual(seasonPassBody(53, { enableSeries: true, seasonNumbers: [1, 3] }), { series: [{ id: 53, monitored: true, seasons: [{ seasonNumber: 1, monitored: true }, { seasonNumber: 3, monitored: true }] }] });
  assert.deepEqual(seasonPassBody(53, { enableSeries: false, seasonNumbers: [] }), { series: [{ id: 53, seasons: [] }] }, 'series flag omitted when already on');
});

/* ---------- Service: reading episodes ---------- */

test('episodes: Sonarr seasons/episodes for an existing series; refusals for others', async () => {
  const { svc, fake } = setup();
  const view = await svc.episodes(SHOW_ID, OWNER);
  assert.equal(view.tvdbId, 81189); assert.equal(view.seriesMonitored, false); assert.equal(view.pending, false);
  assert.equal(view.sonarrUrl, `${FAKE_URL}/series/breaking-bad`);
  assert.deepEqual(view.seasons.map(season => [season.seasonNumber, season.episodes.length]), [[0, 1], [1, 3], [2, 2], [3, 1]]);
  assert.deepEqual(writes(fake), [], 'reading never writes');
  const notAdded = setup(); notAdded.fake.inLibrary = false;
  await rejects(notAdded.svc.episodes(SHOW_ID, OWNER), 409, 'not_in_sonarr');
  await rejects(setup().svc.episodes(SHOW_ID, 'someone-else'), 403, 'forbidden');
  await rejects(setup({ fake: null }).svc.episodes(SHOW_ID, OWNER), 503, 'not_configured');
  const loading = setup(); loading.fake.lib.episodes = [];
  assert.equal((await loading.svc.episodes(SHOW_ID, OWNER)).pending, true, 'right after adding, Sonarr has not loaded episodes yet');
  const down = setup(); down.fake.failOn.episodes = new SonarrError('timeout');
  await rejects(down.svc.episodes(SHOW_ID, OWNER), 504, 'timeout');
});

/* ---------- Service: the three modes ---------- */

test('mode 1, entire series: all regular episodes and seasons monitored, specials untouched, no search by default', async () => {
  const { svc, fake } = setup();
  const result = await svc.requestEpisodes(SHOW_ID, OWNER, confirmed(fake, { mode: 'series' }));
  assert.deepEqual(fake.monitoredIds(), [1001, 1002, 1003, 2001, 2002, 3001]);
  assert.equal(fake.lib.series.monitored, true);
  assert.deepEqual(fake.lib.series.seasons, [{ seasonNumber: 0, monitored: false }, { seasonNumber: 1, monitored: true }, { seasonNumber: 2, monitored: true }, { seasonNumber: 3, monitored: true }]);
  assert.deepEqual(fake.searched, [], 'search is off unless asked');
  assert.deepEqual(writes(fake), ['monitorEpisodes', 'seasonPass'], 'episodes first, then series/season flags');
  assert.equal(result.monitored, 6); assert.equal(result.searched, 0); assert.equal(result.seriesMonitoringEnabled, true);
  assert.equal(result.view.seriesMonitored, true);
});

test('mode 2, multiple seasons: only those seasons; other seasons and existing selections preserved', async () => {
  const { svc, fake } = setup();
  fake.lib.series.monitored = true;
  fake.lib.series.seasons!.find(season => season.seasonNumber === 2)!.monitored = true;
  fake.lib.episodes.find(episode => episode.id === 2002)!.monitored = true; // user's own Sonarr choice outside the request
  fake.lib.episodes.find(episode => episode.id === 900)!.monitored = true;  // a monitored special
  await svc.requestEpisodes(SHOW_ID, OWNER, confirmed(fake, { mode: 'seasons', seasons: [1, 3], search: true }));
  assert.deepEqual(fake.monitoredIds(), [1001, 1002, 1003, 2002, 3001, 900].sort(), 'season 2 E1 stays unmonitored; nothing was unmonitored');
  assert.deepEqual(fake.lib.series.seasons!.map(season => [season.seasonNumber, season.monitored]), [[0, false], [1, true], [2, true], [3, true]]);
  assert.deepEqual(fake.monitorBodies, [[1001, 1002, 1003, 3001]]);
  assert.deepEqual(fake.seasonPasses, [{ series: [{ id: SERIES_ID, seasons: [{ seasonNumber: 1, monitored: true }, { seasonNumber: 3, monitored: true }] }] }], 'series flag not re-sent when already on');
  assert.deepEqual(fake.searched, [[1002, 1003]], 'only released, missing episodes of the selected seasons');
});

test('mode 3, specific episodes: exactly those IDs, no season flags, series enabled, search strictly scoped', async () => {
  const { svc, fake } = setup();
  const result = await svc.requestEpisodes(SHOW_ID, OWNER, confirmed(fake, { mode: 'episodes', episodeIds: [1001, 1003, 2002], search: true }));
  assert.deepEqual(fake.monitoredIds(), [1001, 1003, 2002]);
  assert.ok(fake.lib.series.seasons!.every(season => season.monitored === false), 'season flags untouched: other episodes added later are not monitored');
  assert.equal(fake.lib.series.monitored, true);
  assert.deepEqual(fake.seasonPasses, [{ series: [{ id: SERIES_ID, monitored: true, seasons: [] }] }]);
  assert.deepEqual(fake.searched, [[1003]], 'not the downloaded 1001, not the unreleased 2002, nothing unselected');
  assert.equal(result.searched, 1);
  assert.deepEqual(writes(fake), ['monitorEpisodes', 'seasonPass', 'searchEpisodes'], 'search only after monitoring is verified');
});

test('specials: excluded by default but can be requested explicitly', async () => {
  const { svc, fake } = setup();
  await svc.requestEpisodes(SHOW_ID, OWNER, confirmed(fake, { mode: 'episodes', episodeIds: [900] }));
  assert.deepEqual(fake.monitoredIds(), [900]);
});

test('search: nothing searchable means no search command at all', async () => {
  const { svc, fake } = setup();
  await svc.requestEpisodes(SHOW_ID, OWNER, confirmed(fake, { mode: 'episodes', episodeIds: [1001, 2002, 3001], search: true }));
  assert.deepEqual(fake.searched, []);
  assert.equal(fake.calls.includes('searchEpisodes'), false);
});

test('idempotent: re-requesting a monitored selection writes nothing', async () => {
  const { svc, fake } = setup();
  await svc.requestEpisodes(SHOW_ID, OWNER, confirmed(fake, { mode: 'seasons', seasons: [1] }));
  fake.calls = [];
  const again = await svc.requestEpisodes(SHOW_ID, OWNER, confirmed(fake, { mode: 'seasons', seasons: [1] }));
  assert.deepEqual(writes(fake), []);
  assert.equal(again.monitored, 0); assert.equal(again.alreadyMonitored, 3);
});

/* ---------- Service: safety and failures ---------- */

test('confirmation mismatch: Sonarr changed since the summary, so nothing is written', async () => {
  const { svc, fake } = setup();
  const request = confirmed(fake, { mode: 'seasons', seasons: [1], search: true });
  fake.lib.episodes.push(ep(1004, 1, 4)); // Sonarr refreshed and found a new episode
  await rejects(svc.requestEpisodes(SHOW_ID, OWNER, request), 409, 'selection_changed');
  const stale = setup();
  await rejects(stale.svc.requestEpisodes(SHOW_ID, OWNER, { ...confirmed(stale.fake, { mode: 'episodes', episodeIds: [1002] }), episodeIds: [77] }), 409, 'selection_changed');
  assert.deepEqual([...writes(fake), ...writes(stale.fake)], []);
});

test('identity and access are re-verified before any write', async () => {
  const { svc, fake } = setup();
  await rejects(svc.requestEpisodes(SHOW_ID, OWNER, { ...confirmed(fake, { mode: 'series' }), tvdbId: 999001 }), 409, 'identity_changed');
  await rejects(svc.requestEpisodes(SHOW_ID, 'someone-else', confirmed(fake, { mode: 'series' })), 403, 'forbidden');
  const notAdded = setup(); notAdded.fake.inLibrary = false;
  await rejects(notAdded.svc.requestEpisodes(SHOW_ID, OWNER, confirmed(notAdded.fake, { mode: 'series' })), 409, 'not_in_sonarr');
  const loading = setup(); const request = confirmed(loading.fake, { mode: 'series' }); loading.fake.lib.episodes = [];
  await rejects(loading.svc.requestEpisodes(SHOW_ID, OWNER, request), 409, 'episodes_pending');
  assert.deepEqual([...writes(fake), ...writes(notAdded.fake), ...writes(loading.fake)], []);
});

test('failure: episode monitoring refused or timed out, so no flags and no search', async () => {
  const refused = setup(); refused.fake.failOn.monitorEpisodes = new SonarrError('rejected', 400);
  await rejects(refused.svc.requestEpisodes(SHOW_ID, OWNER, confirmed(refused.fake, { mode: 'series', search: true })), 502, 'not_applied');
  assert.deepEqual(writes(refused.fake), ['monitorEpisodes']);
  const slow = setup(); slow.fake.failOn.monitorEpisodes = new SonarrError('timeout');
  await rejects(slow.svc.requestEpisodes(SHOW_ID, OWNER, confirmed(slow.fake, { mode: 'series', search: true })), 504, 'uncertain');
  assert.deepEqual(slow.fake.searched, []);
});

test('failure: series/season flags refused, so no search; a retry completes only what is left', async () => {
  const { svc, fake } = setup(); fake.failOn.seasonPass = new SonarrError('unreachable');
  const error = await rejects(svc.requestEpisodes(SHOW_ID, OWNER, confirmed(fake, { mode: 'episodes', episodeIds: [1002], search: true })), 502, 'partial');
  assert.deepEqual(error.detail, { applied: { episodes: true, flags: false, search: false } });
  assert.deepEqual(fake.searched, []);
  delete fake.failOn.seasonPass; fake.monitorBodies = [];
  await svc.requestEpisodes(SHOW_ID, OWNER, confirmed(fake, { mode: 'episodes', episodeIds: [1002], search: true }));
  assert.deepEqual(fake.monitorBodies, [], 'already-monitored episodes are not re-sent');
  assert.deepEqual(fake.searched, [[1002]]);
});

test('failure: Sonarr acknowledges but does not apply, so verification fails and nothing is searched', async () => {
  const { svc, fake } = setup(); fake.ignoreMonitor = true;
  await rejects(svc.requestEpisodes(SHOW_ID, OWNER, confirmed(fake, { mode: 'episodes', episodeIds: [1002], search: true })), 502, 'unverified');
  assert.deepEqual(fake.searched, []);
  const unreadable = setup(); unreadable.fake.failOn.seriesById = new SonarrError('timeout');
  await rejects(unreadable.svc.requestEpisodes(SHOW_ID, OWNER, confirmed(unreadable.fake, { mode: 'episodes', episodeIds: [1002], search: true })), 502, 'unverified');
  assert.deepEqual(unreadable.fake.searched, []);
});

test('failure: search refused after monitoring is saved is reported as such', async () => {
  const { svc, fake } = setup(); fake.failOn.searchEpisodes = new SonarrError('unreachable');
  const error = await rejects(svc.requestEpisodes(SHOW_ID, OWNER, confirmed(fake, { mode: 'episodes', episodeIds: [1002], search: true })), 502, 'search_failed');
  assert.deepEqual(error.detail, { applied: { episodes: true, flags: true, search: false } });
  assert.deepEqual(fake.monitoredIds(), [1002]);
});

test('concurrency: one change per series at a time', async () => {
  const { svc, fake } = setup(); fake.delay = 30;
  const request = confirmed(fake, { mode: 'episodes', episodeIds: [1002] });
  const results = await Promise.allSettled([svc.requestEpisodes(SHOW_ID, OWNER, request), svc.requestEpisodes(SHOW_ID, OWNER, request)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'in_progress');
  assert.equal(fake.monitorBodies.length, 1);
});

/* ---------- Client: exact Sonarr calls ---------- */

test('client: monitor-on only, season pass without monitoringOptions, search by exact episode IDs', async () => {
  const seen: Array<{ method: string; url: string; body: unknown; params: unknown }> = [];
  const config = readSonarrConfig({ SONARR_URL: FAKE_URL, SONARR_API_KEY: FAKE_KEY }).config!;
  const client = new SonarrClient(config);
  const adapter: AxiosAdapter = async (request: InternalAxiosRequestConfig) => {
    seen.push({ method: String(request.method).toUpperCase(), url: String(request.url), body: request.data ? JSON.parse(request.data) : null, params: request.params });
    return { data: request.url === '/episode' ? [] : {}, status: 200, statusText: 'OK', headers: {}, config: request };
  };
  (client as unknown as { http: { defaults: { adapter: AxiosAdapter } } }).http.defaults.adapter = adapter;
  await client.episodes(53);
  await client.monitorEpisodes([1002, 1003]);
  await client.seasonPass(seasonPassBody(53, { enableSeries: true, seasonNumbers: [1] }));
  await client.searchEpisodes([1003]);
  await client.seriesById(53);
  assert.deepEqual(seen, [
    { method: 'GET', url: '/episode', body: null, params: { seriesId: 53 } },
    { method: 'PUT', url: '/episode/monitor', body: { episodeIds: [1002, 1003], monitored: true }, params: undefined },
    { method: 'POST', url: '/seasonpass', body: { series: [{ id: 53, monitored: true, seasons: [{ seasonNumber: 1, monitored: true }] }] }, params: undefined },
    { method: 'POST', url: '/command', body: { name: 'EpisodeSearch', episodeIds: [1003] }, params: undefined },
    { method: 'GET', url: '/series/53', body: null, params: undefined },
  ]);
  assert.ok(!seen.some(call => call.method === 'DELETE'), 'never deletes');
  await assert.rejects(client.monitorEpisodes([0]), (error: unknown) => error instanceof SonarrError);
  await assert.rejects(client.seriesById(-1), (error: unknown) => error instanceof SonarrError);
  assert.equal(seen.length, 5, 'invalid IDs never reach Sonarr');
});

test('source: the integration never unmonitors, deletes or sends full series updates', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.join(__dirname, '..', 'src', 'services', 'sonarr');
  for (const file of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(!/\.delete\(\s*['"`]\//.test(text), `${file} issues a Sonarr DELETE`);
    assert.ok(!/\.put\(\s*[`'"]\/series/.test(text), `${file} sends a full series update`);
    assert.ok(!/monitored:\s*false/.test(text.replace(/\/\/.*$/gm, '')) || file === 'sonarr-match.model.ts', `${file} unmonitors something`);
    assert.ok(!/deleteFiles|monitoringOptions\s*:/.test(text), `${file} uses a destructive or cascading option`);
  }
});

/* ---------- HTTP routes ---------- */

test('routes: authenticated, owner-only, JSON-only, strict bodies', async () => {
  const express = (await import('express')).default;
  const { protectedRoute } = await import('../src/middlewares/protectedRoute');
  const { createSonarrRouter } = await import('../src/api/v1/sonarr');
  const { securityModule } = await import('../src/modules/security');
  const { svc, fake } = setup();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/sonarr', protectedRoute, createSonarrRouter(svc));
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/sonarr`;
  const owner = `Bearer ${await securityModule.Commands.GenerateTokenCommand.execute(OWNER)}`;
  const other = `Bearer ${await securityModule.Commands.GenerateTokenCommand.execute('someone-else')}`;
  const call = async (path: string, init: { method?: string; auth?: string; body?: unknown; type?: string } = {}) => {
    const response = await fetch(base + path, { method: init.method || 'GET', headers: { ...(init.auth ? { Authorization: init.auth } : {}), 'Content-Type': init.type || 'application/json' }, body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body) });
    const text = await response.text();
    assert.ok(!text.includes(FAKE_KEY));
    let body: any = text; try { body = text ? JSON.parse(text) : null; } catch { /* plain */ }
    return { status: response.status, body };
  };
  try {
    const request = confirmed(fake, { mode: 'episodes', episodeIds: [1002], search: true });
    assert.equal((await call(`/shows/${SHOW_ID}/episodes`)).status, 401);
    assert.equal((await call(`/shows/${SHOW_ID}/episodes`, { method: 'POST', body: request })).status, 401);
    assert.equal((await call(`/shows/${SHOW_ID}/episodes`, { auth: other })).status, 403);
    assert.equal((await call(`/shows/${SHOW_ID}/episodes`, { method: 'POST', auth: other, body: request })).status, 403);
    assert.equal((await call('/shows/not-a-uuid/episodes', { auth: owner })).status, 404);
    const view = await call(`/shows/${SHOW_ID}/episodes`, { auth: owner });
    assert.equal(view.status, 200); assert.equal(view.body.seasons.length, 4);
    assert.equal((await call(`/shows/${SHOW_ID}/episodes`, { method: 'POST', auth: owner, body: 'mode=series', type: 'application/x-www-form-urlencoded' })).status, 415);
    assert.equal((await call(`/shows/${SHOW_ID}/episodes`, { method: 'POST', auth: owner, body: { ...request, monitored: false } })).status, 400);
    assert.deepEqual(writes(fake), []);
    const done = await call(`/shows/${SHOW_ID}/episodes`, { method: 'POST', auth: owner, body: request });
    assert.equal(done.status, 200); assert.equal(done.body.monitored, 1); assert.equal(done.body.searched, 1);
    assert.deepEqual(fake.searched, [[1002]]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

(async () => {
  let failed = 0;
  for (const [name, run] of tests) {
    try { await run(); console.log(`ok - ${name}`); }
    catch (error) { failed++; console.error(`not ok - ${name}`); console.error(error); }
  }
  console.log(`${tests.length - failed}/${tests.length} Sonarr episode tests passed`);
  process.exit(failed ? 1 : 0);
})();
