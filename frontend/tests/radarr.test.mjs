import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  addActionLabel, addErrorMessage, addOutcome, addRequest, availabilityLabels, badges, createLatest, createStatusCache, createSubmitGuard, displayYear, fileLabels, fill,
  formatFreeSpace, initialForm, isRequestable, panelView, queueLabels, reloadAfter, requestActionLabel, requestBody, requestErrorMessage, requestPlan, requestProblem,
  searchBlockMessages, setMonitored, statusFromView, validateForm,
} from '../src/lib/radarr.ts';

const movie = { title: 'The Matrix', year: 1999, tmdbId: 603, posterUrl: null, studio: 'Warner Bros. Pictures', runtime: 136 };
const options = {
  rootFolders: [{ id: 1, path: '/movies', accessible: true, freeSpace: 122800107520 }, { id: 3, path: '/offline', accessible: false, freeSpace: null }],
  qualityProfiles: [{ id: 1, name: 'Any' }, { id: 4, name: 'HD-1080p' }],
  minimumAvailability: ['announced', 'inCinemas', 'released'],
  defaults: { monitored: false, searchForMovie: false, minimumAvailability: 'released' },
};
const state = (overrides = {}) => ({ monitored: false, fileState: 'missing', queue: null, canSearch: true, ...overrides });
const view = (overrides = {}) => ({
  tmdbId: 603, movie, radarrUrl: 'https://radarr.example.test/movie/603', monitored: false, fileState: 'missing', queue: null,
  canMonitor: true, canSearch: true, searchBlock: null, checkedAt: '2026-11-19T12:00:00.000Z', ...overrides,
});
const phrases = JSON.parse(fs.readFileSync(new URL('../src/i18n/phrases.json', import.meta.url), 'utf8'));
const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
const SOURCES = ['../src/lib/radarr.ts', '../src/components/radarr-panel.tsx', '../src/components/radarr-request.tsx', '../src/components/radarr-badge.tsx', '../src/services/radarr.service.ts'];

test('panel: loading, hidden for other accounts, add, exists and non-blocking notices', () => {
  assert.deepEqual(panelView(null), { kind: 'loading' });
  assert.deepEqual(panelView({ state: 'forbidden' }), { kind: 'hidden' });
  assert.deepEqual(panelView({ state: 'available', movie }), { kind: 'add', movie });
  const exists = panelView({ state: 'exists', movie, radarrUrl: 'https://radarr.example.test/movie/603', radarr: state() });
  assert.equal(exists.kind, 'exists'); assert.equal(exists.requestable, true);
  for (const status of [{ state: 'not_configured' }, { state: 'no_tmdb_link' }, { state: 'unmatched', reason: 'not_found' }, { state: 'unmatched', reason: 'conflicting_ids' }]) {
    const notice = panelView(status);
    assert.equal(notice.kind, 'notice'); assert.equal(notice.retry, false, 'no add action without a verified match');
  }
  assert.deepEqual(panelView({ state: 'unavailable', reason: 'timeout' }), { kind: 'notice', message: 'Radarr is unavailable right now.', retry: true });
  assert.equal(panelView(null, true).retry, true);
});

test('Request movie is offered only when it can change something; never for a movie on disk', () => {
  assert.equal(isRequestable(state()), true, 'unmonitored + missing');
  assert.equal(isRequestable(state({ fileState: 'unreleased' })), true, 'unmonitored + not released: can be monitored');
  assert.equal(isRequestable(state({ monitored: true })), true, 'monitored + missing: can be searched');
  assert.equal(isRequestable(state({ monitored: true, fileState: 'unreleased', canSearch: false })), false);
  assert.equal(isRequestable(state({ monitored: true, queue: { state: 'downloading', progress: 5 }, canSearch: false })), false, 'already downloading');
  assert.equal(isRequestable(state({ monitored: true, canSearch: false })), false, 'searched minutes ago: nothing to request');
  assert.equal(isRequestable(state({ fileState: 'on_disk' })), false);
  assert.equal(isRequestable(state({ monitored: true, fileState: 'on_disk' })), false);
  assert.equal(isRequestable(state({ fileState: 'unknown' })), false);
});

test('badges show only what Radarr confirmed; downloaded is never "watched"', () => {
  assert.deepEqual(badges(state()).map(badge => badge.label), ['Not Monitored', 'Missing']);
  assert.deepEqual(badges(state({ monitored: true, fileState: 'on_disk' })).map(badge => badge.label), ['Monitored', 'On Disk']);
  assert.deepEqual(badges(state({ fileState: 'unreleased' })).map(badge => badge.label), ['Not Monitored', 'Not Released']);
  assert.deepEqual(badges(state({ fileState: 'unknown' })).map(badge => badge.label), ['Not Monitored'], 'unknown file state shows no guess');
  const queued = badges(state({ monitored: true, queue: { state: 'downloading', progress: 42 } }));
  assert.deepEqual(queued[2], { key: 'queue', label: 'Downloading', tone: 'primary', progress: 42 });
  assert.equal(badges(state({ monitored: true, queue: { state: 'queued', progress: null } }))[2].progress, null, 'no invented progress');
  for (const badge of badges(state({ monitored: true, fileState: 'on_disk' }))) assert.ok(!/watched/i.test(badge.label));
});

test('add form: monitoring and search OFF by default; never remembered', () => {
  const fresh = initialForm(options, null);
  assert.deepEqual(fresh, { rootFolderId: 1, qualityProfileId: null, minimumAvailability: 'released', monitored: false, searchForMovie: false });
  const rememberedForm = initialForm(options, { rootFolderId: 1, qualityProfileId: 4, monitored: true, searchForMovie: true });
  assert.equal(rememberedForm.qualityProfileId, 4); assert.equal(rememberedForm.monitored, false); assert.equal(rememberedForm.searchForMovie, false);
  assert.equal(initialForm({ ...options, rootFolders: [...options.rootFolders, { id: 9, path: '/m2', accessible: true, freeSpace: 1 }] }, { rootFolderId: 3 }).rootFolderId, null, 'an inaccessible remembered folder is not reused');
  assert.equal(initialForm(options, { qualityProfileId: 99 }).qualityProfileId, null);
});

test('add form: validation mirrors the server; search requires monitoring', () => {
  const ok = { rootFolderId: 1, qualityProfileId: 4, minimumAvailability: 'released', monitored: false, searchForMovie: false };
  assert.equal(validateForm(ok, null), 'Loading Radarr options…');
  assert.equal(validateForm({ ...ok, rootFolderId: 3 }, options), 'Choose a root folder.');
  assert.equal(validateForm({ ...ok, rootFolderId: null }, options), 'Choose a root folder.');
  assert.equal(validateForm({ ...ok, qualityProfileId: 99 }, options), 'Choose a quality profile.');
  assert.equal(validateForm(ok, { ...options, rootFolders: [] }), 'Radarr has no accessible root folder.');
  assert.equal(validateForm(ok, { ...options, qualityProfiles: [] }), 'Radarr has no quality profiles.');
  assert.equal(validateForm({ ...ok, minimumAvailability: 'tba' }, options), 'Choose a minimum availability.');
  assert.equal(validateForm({ ...ok, searchForMovie: true }, options), 'Searching needs a monitored movie.');
  assert.equal(validateForm(ok, options), null);
  // Turning monitoring off also clears the search.
  assert.deepEqual(setMonitored({ ...ok, monitored: true, searchForMovie: true }, false), { ...ok, monitored: false, searchForMovie: false });
  assert.equal(setMonitored(ok, true).searchForMovie, false, 'enabling monitoring never enables search by itself');
});

test('add request body and button say exactly what will happen', () => {
  const form = { rootFolderId: 1, qualityProfileId: 4, minimumAvailability: 'released', monitored: false, searchForMovie: false };
  assert.deepEqual(addRequest(form, 603), { tmdbId: 603, rootFolderId: 1, qualityProfileId: 4, minimumAvailability: 'released', monitored: false, searchForMovie: false });
  assert.equal(addRequest({ ...form, searchForMovie: true }, 603).searchForMovie, false, 'no search without monitoring');
  assert.equal(addActionLabel(form), 'Add to Radarr');
  assert.equal(addActionLabel({ ...form, monitored: true }), 'Add and monitor');
  assert.equal(addActionLabel({ ...form, monitored: true, searchForMovie: true }), 'Add, monitor and search');
});

test('add outcome reports only what Radarr confirmed, including partial failures', () => {
  const base = { added: true, monitored: false, monitoringAsRequested: true, search: 'not_requested', status: { state: 'exists' }, options: {} };
  assert.equal(addOutcome(base).tone, 'success');
  assert.match(addOutcome(base).lines[0], /nothing will download/);
  const started = addOutcome({ ...base, monitored: true, search: 'started' });
  assert.ok(started.lines.some(line => /only if it finds/.test(line)), 'a search is never presented as a download');
  assert.equal(addOutcome({ ...base, monitored: true, search: 'failed' }).tone, 'warning');
  assert.equal(addOutcome({ ...base, monitored: true, monitoringAsRequested: false }).tone, 'warning');
  for (const search of ['not_available', 'not_monitored']) assert.ok(addOutcome({ ...base, search }).lines.length === 2);
});

test('request plan: monitor by default, search only when explicitly chosen and allowed', () => {
  assert.deepEqual(requestPlan(view(), false), { monitor: true, search: false, nothing: false });
  assert.deepEqual(requestPlan(view(), true), { monitor: true, search: true, nothing: false });
  assert.deepEqual(requestPlan(view({ canSearch: false, searchBlock: 'unreleased' }), true), { monitor: true, search: false, nothing: false });
  const monitored = view({ monitored: true, canMonitor: false });
  assert.equal(requestPlan(monitored, false).nothing, true);
  assert.match(requestProblem(monitored, false), /Search now/);
  assert.equal(requestProblem(monitored, true), null);
  assert.equal(requestActionLabel(requestPlan(monitored, true)), 'Confirm and search');
  assert.equal(requestActionLabel(requestPlan(view(), false)), 'Confirm and monitor');
  assert.equal(requestActionLabel(requestPlan(view(), true)), 'Confirm, monitor and search');
  assert.equal(requestActionLabel(requestPlan(view({ monitored: true, canMonitor: false, canSearch: false }), false)), 'Nothing to request');
  assert.equal(requestProblem(null, false), 'Loading Radarr status…');
  const disk = view({ fileState: 'on_disk', canMonitor: false, canSearch: false, searchBlock: 'on_disk' });
  assert.match(requestProblem(disk, true), /already on disk/);
});

test('request body confirms the state the user saw; search is never sent when not allowed', () => {
  assert.deepEqual(requestBody(view(), false), { tmdbId: 603, search: false, expected: { monitored: false, fileState: 'missing' } });
  assert.equal(requestBody(view(), true).search, true);
  assert.equal(requestBody(view({ canSearch: false, searchBlock: 'queued' }), true).search, false);
  assert.deepEqual(statusFromView(view({ monitored: true })), { state: 'exists', movie, radarrUrl: 'https://radarr.example.test/movie/603', radarr: { monitored: true, fileState: 'missing', queue: null, canSearch: true } });
});

test('submission: one request at a time; stale responses are ignored', async () => {
  const guard = createSubmitGuard();
  let release; let calls = 0;
  const first = guard(() => { calls++; return new Promise(resolve => { release = resolve; }); });
  assert.deepEqual(await guard(async () => { calls++; }), { ran: false }, 'a double click does not submit twice');
  release('done');
  assert.deepEqual(await first, { ran: true, value: 'done' });
  await assert.rejects(guard(async () => { calls++; throw new Error('offline'); }));
  assert.deepEqual(await guard(async () => { calls++; return 'ok'; }), { ran: true, value: 'ok' });
  assert.equal(calls, 3);
  const latest = createLatest();
  const older = latest.next(); const newer = latest.next();
  assert.equal(latest.isLatest(older), false); assert.equal(latest.isLatest(newer), true);
});

test('status cache: confirmed changes update at once; unavailable answers are not cached', () => {
  let now = 0;
  const cache = createStatusCache(1000, () => now);
  cache.set('a', { state: 'available', movie });
  assert.equal(cache.get('a').state, 'available');
  now = 1001; assert.equal(cache.get('a'), null);
  cache.set('a', { state: 'exists', movie, radarrUrl: 'x', radarr: state() });
  assert.equal(cache.get('a').state, 'exists');
  cache.set('a', { state: 'unavailable', reason: 'timeout' });
  assert.equal(cache.get('a'), null);
});

test('errors: every server code has a clear message; stale states reload', () => {
  for (const code of ['already_exists', 'in_progress', 'identity_changed', 'unmatched', 'invalid_root_folder', 'invalid_quality_profile', 'uncertain', 'unverified', 'timeout', 'unavailable', 'rejected', 'not_configured', 'forbidden', 'invalid_request']) {
    assert.notEqual(addErrorMessage(code, 400), addErrorMessage(undefined, 400), code);
  }
  for (const code of ['state_changed', 'identity_changed', 'not_in_radarr', 'on_disk', 'nothing_to_do', 'search_unavailable', 'recently_searched', 'in_progress', 'not_applied', 'uncertain', 'unverified', 'search_failed', 'timeout', 'unavailable', 'not_configured', 'forbidden', 'invalid_request']) {
    assert.notEqual(requestErrorMessage(code, 409), requestErrorMessage(undefined, 409), code);
  }
  assert.match(addErrorMessage(undefined, 429), /Too many/);
  assert.match(addErrorMessage('uncertain', 504), /may still have been added/);
  assert.match(requestErrorMessage('search_failed', 502), /Monitoring is on/);
  assert.match(requestErrorMessage(undefined, undefined), /Nothing was changed in Cinetra/);
  assert.ok(reloadAfter('state_changed') && reloadAfter('recently_searched') && !reloadAfter('forbidden'));
});

test('helpers: year, free space, placeholders', () => {
  assert.equal(displayYear({ title: 'Dune (2021)', year: 2021 }), null);
  assert.equal(displayYear({ title: 'Dune', year: 2021 }), 2021);
  assert.equal(formatFreeSpace(122800107520), '114 GB');
  assert.equal(formatFreeSpace(null), null);
  assert.equal(fill('{n} left', { n: 2 }), '2 left');
});

test('translations: every Radarr phrase exists in French and Arabic', () => {
  const lib = read('../src/lib/radarr.ts');
  const ui = SOURCES.slice(1, 4).map(read).join('\n');
  const literals = new Set();
  for (const match of lib.matchAll(/(?:message|return|: |\? |push\()\s*"([A-Z][^"]{2,})"/g)) literals.add(match[1].replace(/\\"/g, '"'));
  for (const match of ui.matchAll(/<T>(?:\{")?([^<"]+?)(?:"\})?<\/T>/g)) literals.add(match[1]);
  for (const match of ui.matchAll(/phrase\(language, "([^"]+)"\)/g)) literals.add(match[1]);
  for (const match of ui.matchAll(/\? "([A-Z][^"]+)" : "([A-Z][^"]+)"/g)) { literals.add(match[1]); literals.add(match[2]); }
  for (const text of [...Object.values(fileLabels), ...Object.values(queueLabels), ...Object.values(availabilityLabels), ...Object.values(searchBlockMessages), 'Monitored', 'Not Monitored']) literals.add(text);
  const base = { added: true, monitored: true, monitoringAsRequested: false, status: {}, options: {} };
  for (const search of ['not_requested', 'started', 'failed', 'not_available', 'not_monitored']) for (const line of [...addOutcome({ ...base, search }).lines, addOutcome({ ...base, monitored: false, search }).lines[0], addOutcome({ ...base, search }).title]) literals.add(line);
  for (const code of ['already_exists', 'in_progress', 'identity_changed', 'unmatched', 'invalid_root_folder', 'invalid_quality_profile', 'uncertain', 'unverified', 'timeout', 'unavailable', 'rejected', 'not_configured', 'forbidden', 'invalid_request', undefined]) { literals.add(addErrorMessage(code, 500)); literals.add(addErrorMessage(code, 429)); }
  for (const code of ['state_changed', 'identity_changed', 'not_in_radarr', 'on_disk', 'nothing_to_do', 'search_unavailable', 'recently_searched', 'in_progress', 'not_applied', 'uncertain', 'unverified', 'search_failed', 'timeout', 'unavailable', 'not_configured', 'forbidden', 'invalid_request', undefined]) literals.add(requestErrorMessage(code, 500));
  for (const status of [{ state: 'not_configured' }, { state: 'no_tmdb_link' }, { state: 'unmatched', reason: 'not_found' }, { state: 'unmatched', reason: 'conflicting_ids' }, { state: 'unavailable', reason: 'unauthorized' }, { state: 'unavailable', reason: 'x' }]) literals.add(panelView(status).message);
  literals.add(panelView(null, true).message);
  const v = view({ monitored: true, canMonitor: false, canSearch: false });
  literals.add(requestProblem(v, false)); literals.add(requestProblem(view({ monitored: true, canMonitor: false }), false)); literals.add(requestProblem(view({ fileState: 'on_disk' }), false));
  literals.add(requestActionLabel(requestPlan(v, false)));
  for (const [form, plan] of [[null, requestPlan(view(), true)], [{ monitored: true, searchForMovie: false }, requestPlan(v, true)], [{ monitored: true, searchForMovie: true }, requestPlan(view(), false)]]) { literals.add(addActionLabel(form)); literals.add(requestActionLabel(plan)); }
  for (const text of ['Updating Radarr…', 'Adding…', 'Close', 'Cancel', '(opens in a new tab)']) literals.add(text);
  literals.delete(undefined); literals.delete(null);
  assert.ok(literals.size > 90, `only ${literals.size} literals found`);
  const missing = [...literals].filter(text => { const entry = phrases[text]; return !(Array.isArray(entry) && entry.length === 2 && entry.every(value => typeof value === 'string' && value.trim())); });
  assert.deepEqual(missing, [], 'missing translations');
});

test('security and separation: the browser never talks to Radarr or touches viewing data', () => {
  for (const file of SOURCES) {
    const source = read(file);
    assert.ok(!/X-Api-Key|apikey|RADARR_API_KEY|VITE_RADARR/i.test(source), `${file}: no Radarr credentials in frontend code`);
    assert.ok(!/\/api\/v3|radarr\.aniskh\.com/i.test(source), `${file}: no direct Radarr API access`);
    assert.ok(!/MovieService|ShowService|updateMovie|setEpisodeWatched|toggleFavorite|addWatch|rating:/.test(source), `${file}: Radarr UI must not change viewing data`);
    assert.ok(!/from "@\/(lib|components|services)\/sonarr/.test(source), `${file}: Radarr is independent of the Sonarr module`);
  }
  // The movie dialog only mounts the panel; its tracking controls are unchanged and it has no Sonarr actions.
  const modal = read('../src/modals/MovieModal.tsx');
  assert.ok(!/Sonarr/i.test(modal));
  assert.equal((modal.match(/<RadarrPanel /g) || []).length, 1);
  assert.ok(/saveMovie\(\{ status \}\)/.test(modal) && /saveMovie\(\{ rating: star \* 2 \}\)/.test(modal), 'tracking controls intact');
  // The TV dialog does not get Radarr.
  assert.ok(!/Radarr/i.test(read('../src/modals/ShowModal.tsx')));
});
