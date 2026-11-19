import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  addErrorMessage, addRequest, createStatusCache, createSubmitGuard, displayYear, episodeRequest, fill, formatFreeSpace, initialForm, modeDescriptions, modeLabels,
  panelView, planIsEmpty, planSelection, reloadAfter, requestErrorMessage, seasonSelection, selectionProblem, stateLabels, toggle, toggleMany, validateForm,
  visibleSeasons, withoutSpecials,
} from '../src/lib/sonarr.ts';

const series = { title: 'Breaking Bad', year: 2008, tvdbId: 81189, posterUrl: null, network: 'AMC', seasonCount: 5, source: 'tmdb_external_ids' };
const options = {
  rootFolders: [{ id: 2, path: '/tv', accessible: true, freeSpace: 205028159488 }, { id: 3, path: '/offline', accessible: false, freeSpace: null }],
  qualityProfiles: [{ id: 1, name: 'Any' }, { id: 4, name: 'HD-1080p' }],
  monitorOptions: ['none', 'future', 'missing', 'existing', 'recent', 'pilot', 'firstSeason', 'lastSeason', 'all'],
  defaults: { monitor: 'none', monitorNewItems: 'none', searchForMissingEpisodes: false },
};
const phrases = JSON.parse(fs.readFileSync(new URL('../src/i18n/phrases.json', import.meta.url), 'utf8'));

test('panel: loading, hidden, add, exists and non-blocking notices', () => {
  assert.deepEqual(panelView(null), { kind: 'loading' });
  assert.deepEqual(panelView({ state: 'forbidden' }), { kind: 'hidden' });
  assert.deepEqual(panelView({ state: 'available', series }), { kind: 'add', series });
  assert.deepEqual(panelView({ state: 'exists', series, sonarrUrl: 'https://sonarr.example.test/series/breaking-bad' }), { kind: 'exists', series, sonarrUrl: 'https://sonarr.example.test/series/breaking-bad' });
  const notConfigured = panelView({ state: 'not_configured' });
  assert.equal(notConfigured.kind, 'notice'); assert.equal(notConfigured.retry, false);
  assert.equal(panelView({ state: 'no_tmdb_link' }).kind, 'notice');
  for (const reason of ['no_tvdb_mapping', 'not_found', 'ambiguous', 'conflicting_ids']) {
    const view = panelView({ state: 'unmatched', reason });
    assert.equal(view.kind, 'notice'); assert.equal(view.retry, false, 'an unverified match offers no add action');
  }
  assert.deepEqual(panelView({ state: 'unavailable', reason: 'timeout' }), { kind: 'notice', message: 'Sonarr is unavailable right now.', retry: true });
  assert.equal(panelView(null, true).retry, true, 'a failed status request offers a retry');
});

test('form: safe defaults, remembered folder/profile, never remembered monitoring', () => {
  const fresh = initialForm(options, null);
  assert.deepEqual(fresh, { rootFolderId: 2, qualityProfileId: null, monitorNewItems: 'none' });
  assert.equal(validateForm(fresh, options), 'Choose a quality profile.');
  const rememberedForm = initialForm(options, { rootFolderId: 2, qualityProfileId: 4, monitor: 'all' });
  assert.equal(rememberedForm.qualityProfileId, 4); assert.equal('monitor' in rememberedForm, false);
  // A remembered folder that is now inaccessible or gone is not reused.
  assert.equal(initialForm({ ...options, rootFolders: [...options.rootFolders, { id: 9, path: '/tv2', accessible: true, freeSpace: 1 }] }, { rootFolderId: 3 }).rootFolderId, null);
  assert.equal(initialForm(options, { qualityProfileId: 99 }).qualityProfileId, null);
  assert.equal(validateForm({ ...fresh, qualityProfileId: 4 }, options), null);
});

test('form: validation mirrors the server', () => {
  const ok = { rootFolderId: 2, qualityProfileId: 4, monitorNewItems: 'none' };
  assert.equal(validateForm(ok, null), 'Loading Sonarr options…');
  assert.equal(validateForm({ ...ok, rootFolderId: 3 }, options), 'Choose a root folder.');
  assert.equal(validateForm(ok, { ...options, rootFolders: [] }), 'Sonarr has no accessible root folder.');
  assert.equal(validateForm(ok, { ...options, qualityProfiles: [] }), 'Sonarr has no quality profiles.');
  assert.equal(validateForm(ok, options), null);
});

test('adding never monitors or searches: the request step decides', () => {
  assert.deepEqual(addRequest({ rootFolderId: 2, qualityProfileId: 4, monitorNewItems: 'all' }, 81189), { tvdbId: 81189, rootFolderId: 2, qualityProfileId: 4, monitor: 'none', monitorNewItems: 'all', searchForMissingEpisodes: false });
});

test('submission: one request at a time; a retry works after failure', async () => {
  const guard = createSubmitGuard();
  let release; let calls = 0;
  const first = guard(() => { calls++; return new Promise(resolve => { release = resolve; }); });
  assert.deepEqual(await guard(async () => { calls++; }), { ran: false });
  release('done');
  assert.deepEqual(await first, { ran: true, value: 'done' });
  await assert.rejects(guard(async () => { calls++; throw new Error('offline'); }));
  assert.deepEqual(await guard(async () => { calls++; return 'ok'; }), { ran: true, value: 'ok' });
  assert.equal(calls, 3);
});

test('status cache: success updates at once; unavailable answers are not cached', () => {
  let now = 0;
  const cache = createStatusCache(1000, () => now);
  cache.set('a', { state: 'available', series });
  assert.equal(cache.get('a').state, 'available');
  now = 1001; assert.equal(cache.get('a'), null);
  cache.set('a', { state: 'exists', series, sonarrUrl: 'https://x.test/' });
  now = 20_000; assert.equal(cache.get('a').state, 'exists');
  cache.set('a', { state: 'unavailable', reason: 'timeout' });
  assert.equal(cache.get('a'), null);
});

test('errors: every server code has a clear message; HTTP status never leaks a Sonarr body', () => {
  for (const code of ['already_exists', 'in_progress', 'identity_changed', 'unmatched', 'invalid_root_folder', 'invalid_quality_profile', 'uncertain', 'timeout', 'rejected', 'not_configured', 'forbidden', 'invalid_request']) {
    assert.ok(addErrorMessage(code, 400).length > 10, code);
  }
  assert.match(addErrorMessage(undefined, 429), /Too many/);
  assert.match(addErrorMessage(undefined, undefined), /Nothing was changed in Cinetra/);
  assert.match(addErrorMessage('uncertain', 504), /may still have been added/);
});

test('year is not repeated when Sonarr already puts it in the title', () => {
  assert.equal(displayYear({ title: 'Dark Matter (2024)', year: 2024 }), null);
  assert.equal(displayYear({ title: 'Dark Matter', year: 2024 }), 2024);
  assert.equal(displayYear({ title: 'Doctor Who (2005)', year: 2023 }), 2023);
  assert.equal(displayYear({ title: 'Untitled', year: null }), null);
});

test('free space formatting', () => {
  assert.equal(formatFreeSpace(205028159488), '191 GB');
  assert.equal(formatFreeSpace(1536), '1.5 KB');
  assert.equal(formatFreeSpace(null), null);
  assert.equal(formatFreeSpace(-1), null);
});

test('translations exist for every Sonarr message', () => {
  const lib = fs.readFileSync(new URL('../src/lib/sonarr.ts', import.meta.url), 'utf8');
  const panel = ['../src/components/sonarr-panel.tsx', '../src/components/sonarr-episodes.tsx'].map(file => fs.readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
  const literals = new Set();
  for (const match of lib.matchAll(/(?:message|return|: )\s*"([A-Z][^"]{2,})"/g)) literals.add(match[1]);
  for (const match of panel.matchAll(/<T>(?:\{")?([^<"]+?)(?:"\})?<\/T>/g)) literals.add(match[1]);
  for (const match of panel.matchAll(/phrase\(language, "([^"]+)"\)/g)) literals.add(match[1]);
  for (const match of panel.matchAll(/\? "([A-Z][^"]+)" : "([A-Z][^"]+)"/g)) { literals.add(match[1]); literals.add(match[2]); }
  for (const text of [...Object.values(modeLabels), ...Object.values(modeDescriptions), ...Object.values(stateLabels)]) literals.add(text);
  for (const code of ['selection_changed', 'identity_changed', 'not_in_sonarr', 'episodes_pending', 'empty_selection', 'in_progress', 'not_applied', 'uncertain', 'partial', 'unverified', 'search_failed', 'unmatched', 'timeout', 'unavailable', 'not_configured', 'forbidden', 'invalid_request', undefined]) literals.add(requestErrorMessage(code, 500));
  assert.ok(literals.size > 80);
  for (const text of literals) {
    const entry = phrases[text];
    assert.ok(Array.isArray(entry) && entry.length === 2 && entry.every(value => value.trim()), `missing translation: ${text}`);
  }
});

test('security and separation: the browser never talks to Sonarr or touches viewing data', () => {
  const files = ['../src/lib/sonarr.ts', '../src/components/sonarr-panel.tsx', '../src/components/sonarr-episodes.tsx', '../src/services/sonarr.service.ts'].map(file => fs.readFileSync(new URL(file, import.meta.url), 'utf8'));
  for (const source of files) {
    assert.ok(!/X-Api-Key|apikey|SONARR_API_KEY|VITE_SONARR/i.test(source), 'no Sonarr credentials in frontend code');
    assert.ok(!/\/api\/v3|sonarr\.aniskh\.com/i.test(source), 'no direct Sonarr API access');
    assert.ok(!/ShowService|setEpisodeWatched|markSeasonWatched|updateShow|toggleFavorite|MovieService/.test(source), 'Sonarr UI must not change viewing data');
  }
  const modal = fs.readFileSync(new URL('../src/modals/MovieModal.tsx', import.meta.url), 'utf8');
  assert.ok(!/Sonarr/i.test(modal), 'no Sonarr actions on movies');
});

/* ---------- Episode requests ---------- */

const PAST = '2026-01-10T02:00:00.000Z';
const e = (id, seasonNumber, episodeNumber, state = 'missing', monitored = false) => ({ id, seasonNumber, episodeNumber, title: `S${seasonNumber}E${episodeNumber}`, airDateUtc: state === 'unreleased' ? null : PAST, monitored, state });
const view = (overrides = {}) => ({
  tvdbId: 81189, seriesMonitored: false, sonarrUrl: 'https://sonarr.example.test/series/breaking-bad', pending: false, checkedAt: PAST,
  seasons: [
    { seasonNumber: 0, monitored: false, flag: true, episodes: [e(900, 0, 1)] },
    { seasonNumber: 1, monitored: false, flag: true, episodes: [e(1001, 1, 1, 'downloaded'), e(1002, 1, 2), e(1003, 1, 3)] },
    { seasonNumber: 2, monitored: false, flag: true, episodes: [e(2001, 2, 1), e(2002, 2, 2, 'unreleased')] },
    { seasonNumber: 3, monitored: false, flag: true, episodes: [e(3001, 3, 1, 'unreleased')] },
  ],
  ...overrides,
});
const sel = (overrides) => ({ mode: 'seasons', seasons: [], episodeIds: [], search: false, ...overrides });

test('plan: entire series excludes specials; search off by default', () => {
  const plan = planSelection(view(), sel({ mode: 'series' }));
  assert.deepEqual(plan.monitorIds.sort(), [1001, 1002, 1003, 2001, 2002, 3001]);
  assert.deepEqual(plan.seasonNumbers, [1, 2, 3]);
  assert.equal(plan.enableSeries, true);
  assert.deepEqual(plan.searchIds, []);
  assert.equal(plan.searchable, 3);
  assert.deepEqual(planSelection(view(), sel({ mode: 'series', search: true })).searchIds.sort(), [1002, 1003, 2001]);
});

test('plan: multiple seasons; existing monitoring is counted, never removed', () => {
  const v = view({ seriesMonitored: true });
  v.seasons[1].monitored = true; v.seasons[1].episodes[0].monitored = true;
  v.seasons[2].episodes[1].monitored = true; // outside the selection
  const plan = planSelection(v, sel({ seasons: [1, 3], search: true }));
  assert.deepEqual(plan.monitorIds, [1002, 1003, 3001]);
  assert.deepEqual(plan.seasonNumbers, [3], 'season 1 flag is already on');
  assert.equal(plan.enableSeries, false); assert.equal(plan.alsoActivated, 0);
  assert.deepEqual(plan.searchIds, [1002, 1003]);
  assert.equal(plan.counts.monitored, 1);
});

test('plan: specific episodes search only selected, released, missing ones', () => {
  const v = view(); v.seasons[2].episodes[0].monitored = true;
  const plan = planSelection(v, sel({ mode: 'episodes', episodeIds: [1001, 1003, 2002], search: true }));
  assert.deepEqual(plan.monitorIds, [1001, 1003, 2002]);
  assert.deepEqual(plan.seasonNumbers, [], 'no season flags for single episodes');
  assert.deepEqual(plan.searchIds, [1003]);
  assert.equal(plan.alsoActivated, 1, 'warns about the already-flagged episode that series monitoring would activate');
  const request = episodeRequest(v, sel({ mode: 'episodes', episodeIds: [1001, 1003, 2002], search: true }), plan);
  assert.deepEqual(request, { tvdbId: 81189, mode: 'episodes', episodeIds: [1001, 1003, 2002], search: true, expected: { monitor: 3, seasons: 0, search: 1, enableSeries: true } });
});

test('requests: mode-specific bodies and an honest confirmation', () => {
  const v = view();
  const series = sel({ mode: 'series', seasons: [1], episodeIds: [1002] });
  assert.deepEqual(episodeRequest(v, series, planSelection(v, series)), { tvdbId: 81189, mode: 'series', search: false, expected: { monitor: 6, seasons: 3, search: 0, enableSeries: true } }, 'leftover picks of other modes are not sent');
  const seasons = sel({ seasons: [3, 1], episodeIds: [1002] });
  assert.deepEqual(episodeRequest(v, seasons, planSelection(v, seasons)).seasons, [1, 3]);
  const noSearchable = sel({ mode: 'episodes', episodeIds: [1001], search: true });
  assert.equal(episodeRequest(v, noSearchable, planSelection(v, noSearchable)).search, false, 'search is not requested when nothing is searchable');
});

test('selection problems block confirmation', () => {
  const v = view();
  assert.equal(selectionProblem(null, sel({}), null), 'Loading episodes…');
  assert.equal(selectionProblem({ ...v, pending: true }, sel({}), null), 'Sonarr is still loading episodes.');
  assert.equal(selectionProblem(v, sel({}), planSelection(v, sel({}))), 'Choose at least one season.');
  assert.equal(selectionProblem(v, sel({ mode: 'episodes' }), planSelection(v, sel({ mode: 'episodes' }))), 'Choose at least one episode.');
  const done = view({ seriesMonitored: true }); for (const season of done.seasons) { season.monitored = true; for (const episode of season.episodes) episode.monitored = true; }
  const plan = planSelection(done, sel({ seasons: [1] }));
  assert.ok(planIsEmpty(plan));
  assert.equal(selectionProblem(done, sel({ seasons: [1] }), plan), 'Everything selected is already monitored.');
  assert.equal(selectionProblem(done, sel({ seasons: [1], search: true }), planSelection(done, sel({ seasons: [1], search: true }))), null, 'searching an already-monitored selection is allowed');
});

test('picker helpers: specials hidden by default, tri-state seasons, toggles', () => {
  const v = view();
  assert.deepEqual(visibleSeasons(v, false).map(season => season.seasonNumber), [1, 2, 3]);
  assert.deepEqual(visibleSeasons(v, true).map(season => season.seasonNumber), [0, 1, 2, 3]);
  assert.deepEqual(withoutSpecials(v, sel({ seasons: [0, 1], episodeIds: [900, 1002] })), sel({ seasons: [1], episodeIds: [1002] }));
  assert.equal(seasonSelection(v.seasons[1], []), 'none');
  assert.equal(seasonSelection(v.seasons[1], [1002]), 'some');
  assert.equal(seasonSelection(v.seasons[1], [1001, 1002, 1003]), 'all');
  assert.deepEqual(toggle([1, 2], 2, false), [1]);
  assert.deepEqual(toggle([1], 1, true), [1]);
  assert.deepEqual(toggleMany([1], [2, 3], true), [1, 2, 3]);
  assert.equal(fill('Season {n}', { n: 2 }), 'Season 2');
  assert.equal(fill('{x} stays', {}), '{x} stays');
});

test('request errors: clear messages; stale states reload before retrying', () => {
  assert.match(requestErrorMessage('selection_changed', 409), /Nothing was changed/);
  assert.match(requestErrorMessage('search_failed', 502), /Monitoring is saved/);
  assert.match(requestErrorMessage(undefined, 429), /Too many/);
  assert.ok(reloadAfter('selection_changed') && reloadAfter('partial') && !reloadAfter('forbidden'));
});
