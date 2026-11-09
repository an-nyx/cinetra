import assert from 'node:assert/strict';
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';
import { releasedProgressPercent } from '../src/services/legacy-progress.model';
import { buildTrackingSummary, mergeShowEpisodes, type Catalog as ServiceCatalog } from '../src/services/tracking-summary.model';
import { needsTVMazeSupplement } from '../src/services/upcoming-schedule.model';
import type { TMDBApiService } from '../src/services/tmdb/tmdb-api.service';
import {
  attentionReason, auditShow, auditUpcoming, auditLibrarySurfaces, comparePreservation, expectedTracking, inContinueWatching, preservationRecord, showCardLabel,
  type Catalog, type ExplicitRecord, type GuidePage, type RawShow, type Summary, type TMDBFacts, type UpcomingRelease,
} from '../scripts/audit/tracking-audit.model';
import { readOnlyClient, runAudit, renderMarkdown, login, resolveOutputDir, shareableSummary, assertSecureURL } from '../scripts/audit-tracking';
import { ISSUE_CATEGORY } from '../scripts/audit/tracking-audit.model';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every issue code the audit can emit has a category (defect / insufficient metadata / saved-data conflict / informational).
{
  const sources = ['../scripts/audit/tracking-audit.model.ts', '../scripts/audit-tracking.ts'].map(file => fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\n');
  const emitted = new Set([...sources.matchAll(/(?:add\(\s*(?:[\w.!]+,\s*)?|code:\s*(?:\w+\s*\?\s*)?)'([a-z0-9_]+)'/g)].map(m => m[1]));
  for (const [code] of sources.matchAll(/(?<=\? ')[a-z0-9]+_[a-z0-9_]+(?=' :)|(?<=: ')[a-z0-9]+_[a-z0-9_]+(?=', (?:'(?:error|warning|info)'|severity))/g)) emitted.add(code);
  for (const code of ['canceled_series_not_final', 'not_started_reported_in_progress', 'future_season_count_mismatch', 'tvmaze_queried_for_final_series']) assert.ok(emitted.has(code), `scan missed ${code}`);
  const missing = [...emitted].filter(code => !ISSUE_CATEGORY[code]);
  assert.deepEqual(missing, [], `issue codes without a category: ${missing.join(', ')}`);
  assert.ok(emitted.size >= 40);
}

const today = '2026-11-09';
const codes = (issues: { code: string }[]) => issues.map(i => i.code);
const issueFree = (issues: { code: string }[], ...allowed: string[]) => codes(issues).filter(code => !allowed.includes(code));

/** A synthetic catalog: counts per season, all aired unless overridden. No real show data. */
function catalog(counts: number[], override: Record<string, string | null> = {}): Catalog {
  const seasons = counts.map((episodeCount, i) => ({ number: i + 1, episodeCount }));
  const episodes = seasons.flatMap(s => Array.from({ length: s.episodeCount }, (_, i) => {
    const key = `${s.number}:${i + 1}`;
    return { season: s.number, number: i + 1, airDate: key in override ? override[key] : '2024-01-01' };
  }));
  return { seasons, episodes };
}
function show(id: string, seasonsWatched: number, episodesWatched: number, extra: Partial<RawShow> = {}): RawShow {
  return { id, name: `Show ${id}`, seasonsWatched, episodesWatched, completed: false, favorite: false, status: 'watching', tmdbId: 1000 + id.length, ...extra };
}
function facts(c: Catalog, status: string, extra: Partial<TMDBFacts> = {}): TMDBFacts {
  return { ...c, status, inProduction: status === 'Ended' || status === 'Canceled' ? false : true, nextEpisodeAnnounced: false, nextEpisode: null, ...extra };
}

/**
 * What production returns for a show, produced by the REAL service code: buildTrackingSummary (GET /show/tracking and
 * /show/:id/tracking) and mergeShowEpisodes (GET /show/:id/episodes checkmarks). Only database and TMDB I/O are replaced.
 */
function production(s: RawShow, c: Catalog, explicit: ExplicitRecord[], f: TMDBFacts) {
  const tracked = { ...s, posterURL: null, status: s.status ?? null };
  const serviceCatalog: ServiceCatalog = { ...c, episodes: c.episodes.map(e => ({ ...e, name: '', airTimestamp: null, runtime: null })), source: 'TMDB', broadcastStatus: f.status, inProduction: f.inProduction, nextEpisodeAnnounced: f.nextEpisodeAnnounced };
  const watches = explicit.map((r, i) => ({ season: r.season, episode: r.episode, watchedAt: new Date(Date.UTC(2025, 0, 1 + i)) }));
  const built = buildTrackingSummary(tracked, serviceCatalog, null, watches, today);
  const summary = JSON.parse(JSON.stringify(built)) as Summary; // as served over HTTP
  const { episodes } = mergeShowEpisodes(tracked, serviceCatalog, watches, today);
  const guides: GuidePage[] = c.seasons.map(season => ({
    seasons: c.seasons, season: season.number, watched: explicit,
    episodes: episodes.filter(e => e.season === season.number).sort((a, b) => a.number - b.number).map(e => ({ number: e.number, airDate: e.airDate, watched: e.watched, watchSource: e.watchSource })),
  }));
  return { summary, guides };
}
function audit(s: RawShow, c: Catalog, explicit: ExplicitRecord[], tmdbStatus: string, extra: Partial<TMDBFacts> = {}, upcoming: UpcomingRelease[] = []) {
  const f = facts(c, tmdbStatus, extra);
  const { summary, guides } = production(s, c, explicit, f);
  return { result: auditShow({ show: s, summary, detail: summary, guides, facts: f, upcoming, today }), summary };
}

// Preserved behaviour: legacy + explicit union without double counting, checkmarks, exact 100%.
{
  const c = catalog([10, 10]);
  const { result, summary } = audit(show('a', 2, 3), c, [{ season: 1, episode: 2 }, { season: 2, episode: 3 }, { season: 2, episode: 5 }], 'Returning Series');
  assert.equal(result.effectiveWatched.expected, 14); // 10 + 3 from the position, + S2E5 explicit; S1E2 and S2E3 overlap
  assert.equal(result.effectiveWatched.production, 14);
  assert.equal(result.effectiveWatched.coveredByBoth, 2);
  assert.equal(result.checkmarksMatch, true);
  assert.deepEqual(codes(result.issues), []);
  assert.equal(showCardLabel(summary), 'In progress · Saved S02E03 · Next S02E04'); // both facts, each labelled

  const ended = audit(show('b', 3, 6, { status: 'completed', completed: true }), catalog([6, 6, 6]), [], 'Ended').result;
  assert.equal(ended.percent.production, 100);
  assert.equal(ended.classification.production, 'fully_watched');
  assert.deepEqual(codes(ended.issues), []);
}

// Fix 1: nothing watched is Not Started, and it is not offered under Continue watching.
{
  const { result, summary } = audit(show('c', 0, 0, { status: null }), catalog([8]), [], 'Ended');
  assert.equal(result.classification.production, 'not_started');
  assert.deepEqual(codes(result.issues), []);
  assert.equal(inContinueWatching(summary), false);
  assert.equal(summary.progressPercent, 0);
  // An individual record that matches no episode is still activity: never "not started".
  const orphanOnly = audit(show('c2', 0, 0), catalog([8]), [{ season: 9, episode: 1 }], 'Ended').result;
  assert.notEqual(orphanOnly.classification.production, 'not_started');
}

// Fix 2: a fully watched Canceled series is Fully Watched once finality and coverage are established; not otherwise.
{
  const canceled = audit(show('d', 2, 10), catalog([10, 10]), [], 'Canceled').result;
  assert.equal(canceled.classification.production, 'fully_watched');
  assert.deepEqual(codes(canceled.issues), []);
  const stillProducing = audit(show('d2', 2, 10), catalog([10, 10]), [], 'Canceled', { inProduction: true }).result;
  assert.notEqual(stillProducing.classification.production, 'fully_watched');
  const undatedLeft = audit(show('d3', 2, 10), catalog([10, 11], { '2:11': null }), [], 'Canceled').result;
  assert.notEqual(undatedLeft.classification.production, 'fully_watched'); // finality not established
}

// Fix 7: rounding on 200+ episode shows. 100% only when every released episode is watched; never 0% once one is.
{
  assert.equal(releasedProgressPercent(199, 200), 99);
  assert.equal(releasedProgressPercent(200, 200), 100);
  assert.equal(releasedProgressPercent(1, 250), 1);
  assert.equal(releasedProgressPercent(0, 250), 0);
  assert.equal(releasedProgressPercent(0, 0), null);
  for (const released of [200, 201, 399, 1000]) assert.equal(releasedProgressPercent(released - 1, released), 99);
  const almost = audit(show('e', 1, 199), catalog([200]), [], 'Ended').result;
  assert.equal(almost.percent.production, 99);
  assert.deepEqual(codes(almost.issues), []);
  const longRunner = audit(show('e2', 3, 79), catalog([120, 120, 80]), [], 'Returning Series').result; // 319 of 320
  assert.equal(longRunner.percent.production, 99);
  assert.deepEqual(codes(longRunner.issues), []);
  const complete = audit(show('e3', 3, 80), catalog([120, 120, 80]), [], 'Ended').result;
  assert.equal(complete.percent.production, 100);
  assert.equal(complete.classification.production, 'fully_watched');
}

// Fix 8: announced episodes without air dates do not invalidate released progress.
{
  const { result, summary } = audit(show('f', 2, 4), catalog([10, 8], { '2:8': null }), [], 'Returning Series', { nextEpisodeAnnounced: true });
  assert.equal(result.percent.production, 82); // 14 of 17 released
  assert.equal(summary.nextEpisode?.season, 2); assert.equal(summary.nextEpisode?.number, 5);
  assert.equal(summary.countDataAvailable, true);
  assert.deepEqual(issueFree(result.issues, 'undated_future_episodes'), []); // informational note only
  // Caught up while a dated-later or undated episode is announced.
  const caught = audit(show('f2', 2, 7), catalog([10, 9], { '2:8': '2026-12-01', '2:9': null }), [], 'Returning Series', { nextEpisodeAnnounced: true }, [{ showId: 'f2', season: 2, number: 8, name: '', airDate: '2026-12-01', scheduleSource: 'TMDB' }]);
  assert.equal(caught.result.classification.production, 'caught_up');
  assert.equal(caught.result.percent.production, 100);
  assert.deepEqual(issueFree(caught.result.issues, 'undated_future_episodes'), []);
  // An undated episode BEFORE aired ones still makes released counts unreliable, with a stated cause.
  const gap = audit(show('f3', 1, 2), catalog([10], { '1:3': null }), [], 'Returning Series').result;
  assert.equal(gap.percent.production, null);
  assert.ok(codes(gap.issues).includes('undated_before_released'));
}

// Fixes 3 and 4: caught-up shows, Continue watching and review cases.
{
  const withPosition = audit(show('g1', 1, 10), catalog([10]), [], 'Returning Series', { nextEpisodeAnnounced: true });
  const withRecords = audit(show('g2', 0, 0), catalog([3]), [1, 2, 3].map(episode => ({ season: 1, episode })), 'Returning Series');
  for (const { result, summary } of [withPosition, withRecords]) {
    assert.equal(summary.viewingState, 'caught_up');
    assert.equal(inContinueWatching(summary), false); // nothing to play, regardless of how progress was recorded
    assert.deepEqual(codes(result.issues), []);
  }
  assert.deepEqual(codes(auditLibrarySurfaces([withPosition.summary, withRecords.summary], 2)), []);
  // Home totals: verified shows are summed and the partial coverage is stated; nothing verified means "—".
  const unverified: Summary = { showId: 'u', countDataAvailable: false, progressPercent: null };
  assert.deepEqual(codes(auditLibrarySurfaces([withPosition.summary, unverified], 2)), ['home_totals_partial']);
  assert.deepEqual(codes(auditLibrarySurfaces([unverified], 1)), ['home_totals_hidden']);

  for (const s of [show('h1', 1, 9), show('h2', 0, 5)]) { // exceeds a 6-episode season; names season 0
    const { result, summary } = audit(s, catalog([6]), [], 'Ended');
    assert.equal(summary.viewingState, 'needs_review');
    assert.equal(summary.progressPercent, null);
    assert.equal(inContinueWatching(summary), false);
    assert.ok(attentionReason(summary));
    assert.equal(summary.legacyPosition?.fullSeasons, s.seasonsWatched); // preserved, not rewritten
    assert.equal(summary.legacyPosition?.episodesInNextSeason, s.episodesWatched);
    assert.deepEqual(issueFree(result.issues, 'position_exceeds_season', 'position_season_zero'), []);
  }

  const inProgress = audit(show('h3', 1, 2), catalog([6]), [], 'Ended');
  assert.equal(inContinueWatching(inProgress.summary), true);
}

// Genuinely unavailable percentages are reported with their cause, never invented.
{
  const seasonZero = expectedTracking(show('i1', 0, 5), catalog([10]), [], today);
  assert.equal(seasonZero.exactPercent, null);
  assert.ok(codes(seasonZero.issues).includes('position_season_zero'));
  assert.ok(seasonZero.unavailableReasons.length > 0);

  const broken = catalog([10, 10]);
  broken.episodes = broken.episodes.filter(e => !(e.season === 1 && e.number === 4)); // provider dropped an aired episode
  const mismatch = expectedTracking(show('i2', 2, 2), broken, [], today);
  assert.equal(mismatch.exactPercent, null);
  assert.ok(codes(mismatch.issues).includes('season_count_mismatch'));

  const orphan = expectedTracking(show('i3', 0, 0), catalog([5]), [{ season: 9, episode: 1 }, { season: 1, episode: 1 }], today);
  assert.equal(orphan.watchedReleased.length, 1);
  assert.ok(codes(orphan.issues).includes('explicit_records_not_in_catalog'));
}

// The audit still catches regressions: checkmarks, Details/list drift, manual status (fix 9).
{
  const c = catalog([6]);
  const s = show('j', 1, 3);
  const f = facts(c, 'Ended');
  const { summary, guides } = production(s, c, [], f);
  guides[0].episodes[4].watched = true; // a checkmark that no record or position supports
  const wrong = auditShow({ show: s, summary, detail: { ...summary, progressPercent: 1 }, guides, facts: f, upcoming: [], today });
  assert.ok(codes(wrong.issues).includes('checkmark_mismatch'));
  assert.ok(codes(wrong.issues).includes('details_differ_from_list'));
  assert.ok(!codes(wrong.issues).includes('card_hides_next_episode'));
  const hidden = auditShow({ show: s, summary: { ...summary, viewingState: 'caught_up' }, detail: { ...summary, viewingState: 'caught_up' }, guides: production(s, c, [], f).guides, facts: f, upcoming: [], today });
  assert.ok(!codes(hidden.issues).includes('card_hides_next_episode')); // label carries the next episode even then

  const manual = audit(show('k', 1, 2, { status: 'completed', completed: false }), catalog([6]), [], 'Ended');
  assert.equal(manual.result.classification.production, 'in_progress'); // Completed status is not proof
  assert.equal(manual.summary.status, 'completed'); // and it is reported unchanged
  assert.ok(codes(manual.result.issues).includes('manual_completed_not_verified'));
  assert.ok(codes(manual.result.issues).includes('completed_flags_disagree'));
}

// Fixes 5 and 6: when TVMaze is consulted.
{
  const base = { tmdbResponded: true, tmdbFailed: false, tmdbSeasonFailures: 0, scheduleMetadataIncomplete: false, tmdbReleaseCount: 0, inProduction: false, nextEpisodeAnnounced: false };
  assert.equal(needsTVMazeSupplement({ ...base, broadcastStatus: 'Ended' }), false);
  assert.equal(needsTVMazeSupplement({ ...base, broadcastStatus: 'Canceled', scheduleMetadataIncomplete: true }), false);
  assert.equal(needsTVMazeSupplement({ ...base, broadcastStatus: 'Ended', nextEpisodeAnnounced: true }), true); // evidence of more
  assert.equal(needsTVMazeSupplement({ ...base, broadcastStatus: 'Ended', inProduction: null }), true); // finality not established
  assert.equal(needsTVMazeSupplement({ ...base, tmdbResponded: false, tmdbFailed: true, broadcastStatus: null, inProduction: null }), true); // TMDB down
  assert.equal(needsTVMazeSupplement({ ...base, broadcastStatus: 'Returning Series', inProduction: true }), true); // TMDB has no dates
  assert.equal(needsTVMazeSupplement({ ...base, broadcastStatus: 'Returning Series', inProduction: true, tmdbReleaseCount: 3 }), false);
}

// TVMaze-only schedule gap: TMDB knows the show returns but dates nothing; TVMaze supplies the schedule.
{
  const shows = [show('t1', 1, 1)];
  const undatedSeason = catalog([6, 6], Object.fromEntries([1, 2, 3, 4, 5, 6].map(n => [`2:${n}`, null])));
  const result = auditUpcoming(shows, {
    releases: [{ showId: 't1', season: 2, number: 1, name: 'a', airDate: '2026-12-05', scheduleSource: 'TVMaze' }, { showId: 't1', season: null, number: null, name: 'b', airDate: '2026-12-12', scheduleSource: 'TVMaze' }],
    returningTba: [], tmdbFailureTypes: {}, tvmazeQueriedShows: 1,
  }, new Map([['t1', facts(undatedSeason, 'Returning Series')]]), today);
  assert.deepEqual(result.coverage, { tmdbOnly: 0, tvmazeOnly: 1, both: 0, none: 0, noTmdbId: 0 });
  assert.deepEqual(codes(result.perShow.t1), ['tvmaze_supplement']);
  assert.deepEqual(codes(result.library), []);
}

// Upcoming diagnostics: unlinked shows are not TMDB failures; finished series do not need TVMaze.
{
  const shows = [show('v1', 1, 1, { tmdbId: null }), show('v2', 1, 1)];
  const map = new Map<string, TMDBFacts | null>([['v1', null], ['v2', facts(catalog([4]), 'Ended')]]);
  const before = auditUpcoming(shows, { releases: [], returningTba: [], tmdbFailureTypes: { catalog_404: 1 }, tvmazeVerifiedShows: 2 }, map, today);
  assert.deepEqual(codes(before.library), ['unlinked_shows_counted_as_tmdb_failures', 'tvmaze_queried_for_final_series']);
  const after = auditUpcoming(shows, { releases: [], returningTba: [], tmdbFailureTypes: {}, tvmazeQueriedShows: 0, tvmazeVerifiedShows: 0 }, map, today);
  assert.deepEqual(codes(after.library), []);
}

// Upcoming: TMDB primary, TVMaze schedule-only.
{
  const shows = [show('u1', 1, 1), show('u2', 1, 1), show('u3', 1, 1, { tmdbId: null })];
  const c1 = catalog([4], { '1:3': '2026-11-20', '1:4': '2026-11-27' });
  const result = auditUpcoming(shows, {
    releases: [
      { showId: 'u1', season: 1, number: 3, name: 'x', airDate: '2026-11-20', scheduleSource: 'TMDB' },
      { showId: 'u1', season: 1, number: 4, name: 'y', airDate: '2026-11-27', scheduleSource: 'TVMaze' },
      { showId: 'u3', season: null, number: null, name: 'z', airDate: '2026-12-01', scheduleSource: 'TVMaze' },
    ], returningTba: [],
  }, new Map([['u1', facts(c1, 'Returning Series')], ['u2', facts(catalog([4]), 'Returning Series')], ['u3', null]]), today);
  assert.ok(codes(result.perShow.u1).includes('tvmaze_replaced_tmdb'));
  assert.ok(codes(result.perShow.u2).includes('returning_show_missing'));
  assert.ok(codes(result.perShow.u3).includes('upcoming_without_tmdb_identity'));
  assert.deepEqual(result.coverage, { tmdbOnly: 0, tvmazeOnly: 0, both: 1, none: 1, noTmdbId: 1 });
}

// Preservation comparison.
{
  const before = [preservationRecord(show('p', 2, 3, { favorite: true }), [{ season: 1, episode: 1, watchedAt: '2025-01-01T00:00:00.000Z' }], 1)];
  assert.deepEqual(comparePreservation(before, before), []);
  const after = [preservationRecord(show('p', 2, 4, { favorite: true }), [], 0)];
  assert.equal(comparePreservation(before, after).length, 3);
}

// Unavailable percentages must explain themselves; unlinked schedules must declare how they were matched.
{
  const s = show('w1', 1, 2, { tmdbId: null });
  const base: Summary = { showId: 'w1', status: 'watching', guideAvailable: false, countDataAvailable: false, legacyPosition: { fullSeasons: 1, episodesInNextSeason: 2 }, watchedCount: 0, explicitWatchedCount: 0, legacyInferredCount: 0, releasedCount: 0, remainingCount: 0, progressPercent: null, viewingState: 'unknown', metadataError: 'TMDB match required', nextEpisode: null, upcomingEpisode: null, newEpisodes: 0, error: null };
  const run = (summary: Summary) => codes(auditShow({ show: s, summary, detail: summary, guides: [], facts: null, upcoming: [], today }).issues);
  assert.ok(run(base).includes('percent_unavailable_without_reason'));
  assert.ok(run({ ...base, progressUnavailable: { code: 'tmdb_unavailable', label: '', detail: '' } }).includes('percent_reason_mismatch'));
  assert.ok(!run({ ...base, progressUnavailable: { code: 'no_tmdb_association', label: 'No TMDB match', detail: '' } }).some(c => c.startsWith('percent_')));

  const shows = [show('x1', 1, 1, { tmdbId: null }), show('x2', 1, 1, { tmdbId: null })];
  const result = auditUpcoming(shows, { releases: [
    { showId: 'x1', season: 2, number: 1, name: 'a', airDate: '2026-12-05', scheduleSource: 'TMDB', scheduleIdentity: 'schedule_match' },
    { showId: 'x2', season: null, number: null, name: 'b', airDate: '2026-12-06', scheduleSource: 'TVMaze' },
  ], returningTba: [] }, new Map([['x1', null], ['x2', null]]), today);
  assert.deepEqual(codes(result.perShow.x1), ['unlinked_schedule_match']);
  assert.deepEqual(codes(result.perShow.x2), ['upcoming_without_tmdb_identity']);
}

// Runner: GET only, token never in output, failures recorded per show.
async function runner() {
  const TOKEN = 'fake.session.token-for-tests-only';
  const methods: string[] = [];
  const c = catalog([3]);
  const s = show('r1', 1, 2);
  const { summary, guides } = production(s, c, [], facts(c, 'Ended'));
  const routes: Record<string, unknown> = {
    '/show': [s, show('r2', 0, 0, { tmdbId: 77 })], '/show/tracking': [summary, { showId: 'r2', error: 'Episode guide unavailable' }],
    '/show/upcoming': { releases: [], returningTba: [] }, '/show/r1/tracking': summary, '/show/r1/episodes?season=1': guides[0],
  };
  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    methods.push(config.method || '');
    const data = routes[config.url || ''];
    if (data === undefined) {
      const { AxiosError } = await import('axios');
      throw new AxiosError('fail', 'ERR_BAD_RESPONSE', config, {}, { status: 502, statusText: 'Bad Gateway', headers: {}, config, data: { message: `upstream rejected ${TOKEN}` } });
    }
    return { status: 200, statusText: 'OK', headers: {}, config, data };
  };
  const fakeTmdb = { getShow: async () => ({ status: 'Ended', in_production: false, next_episode_to_air: null, seasons: [{ season_number: 1, episode_count: 3 }] }), getSeason: async () => ({ episodes: c.episodes.map(e => ({ episode_number: e.number, name: '', air_date: e.airDate, runtime: null })) }) } as unknown as TMDBApiService;
  const report = await runAudit({ get: readOnlyClient('https://example.invalid/', TOKEN, adapter), tmdb: fakeTmdb, today });
  assert.ok(methods.length > 0 && methods.every(m => m === 'get'));
  assert.equal(report.totals.shows, 2);
  const r1 = report.shows.find(a => a.showId === 'r1')!;
  assert.deepEqual(codes(r1.issues), []); // saved S1E2 of 3: the card now shows both the saved position and next S01E03
  const r2 = report.shows.find(a => a.showId === 'r2')!;
  assert.ok(codes(r2.issues).includes('summary_error') && codes(r2.issues).includes('details_unavailable') && codes(r2.issues).includes('episode_guide_unavailable'));
  const rendered = JSON.stringify(report) + renderMarkdown(report, []);
  assert.ok(!rendered.includes(TOKEN), 'session token leaked into the report');
  assert.ok(rendered.includes('[REDACTED]'));
  assert.equal(report.issueCounts.card_hides_next_episode, undefined); // fixed: the card labels both facts
  assert.equal(report.issueCounts.no_tmdb_id, undefined); // r2 has a TMDB id; its failures are availability issues
  assert.equal(report.issueCounts.episode_guide_unavailable.category, 'insufficient_metadata');

  // The shareable summary holds counts only: no names, IDs, positions or watch history.
  const shared = JSON.stringify(shareableSummary(report, []));
  for (const personal of ['Show r1', 'Show r2', 'r1', 'r2', 'S01E', TOKEN]) assert.ok(!shared.includes(`"${personal}`) && !shared.includes(personal === TOKEN ? TOKEN : `"${personal}"`), `summary exposes ${personal}`);
  assert.ok(!/Show r[12]/.test(shared));

  // Login: the only non-GET request; failures never echo the password; plain http refused except localhost.
  const PASSWORD = 'fake-password-for-tests';
  const seen: { method?: string; url?: string }[] = [];
  const loginAdapter = (status: number): AxiosAdapter => async config => {
    seen.push({ method: config.method, url: config.url });
    if (status !== 200) { const { AxiosError } = await import('axios'); throw new AxiosError('fail', 'ERR_BAD_REQUEST', config, {}, { status, statusText: '', headers: {}, config, data: `bad ${PASSWORD}` }); }
    return { status, statusText: 'OK', headers: {}, config, data: { token: 'fake-issued-token' } };
  };
  assert.equal(await login('https://example.invalid', 'me@example.invalid', PASSWORD, loginAdapter(200)), 'fake-issued-token');
  assert.deepEqual(seen[0], { method: 'post', url: 'https://example.invalid/api/v1/auth/login' });
  for (const status of [401, 500]) {
    try { await login('https://example.invalid', 'me@example.invalid', PASSWORD, loginAdapter(status)); assert.fail('login should fail'); }
    catch (error) { assert.ok(error instanceof Error && !error.message.includes(PASSWORD) && /Login failed/.test(error.message)); }
  }
  assert.throws(() => assertSecureURL('http://cinetra.example.invalid'));
  assert.doesNotThrow(() => assertSecureURL('http://localhost:3000'));

  // Reports can never be written inside the repository.
  const repo = path.resolve(__dirname, '..', '..');
  assert.throws(() => resolveOutputDir(path.join(repo, 'docs', 'audit-out')), /outside the repository/);
  assert.throws(() => resolveOutputDir(repo), /outside the repository/);
  const outside = resolveOutputDir(path.join(os.tmpdir(), `cinetra-audit-test-${process.pid}`));
  assert.ok(fs.existsSync(outside));
  fs.rmSync(outside, { recursive: true, force: true });
  assert.ok(!fs.existsSync(path.join(repo, 'docs', 'audit-out')));
}

runner().then(() => console.log('tracking audit tests passed')).catch(error => {
  console.error(error instanceof Error ? error.message : 'tracking audit tests failed');
  process.exitCode = 1;
});
