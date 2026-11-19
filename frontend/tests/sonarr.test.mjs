import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  addErrorMessage, addRequest, createStatusCache, createSubmitGuard, displayYear, formatFreeSpace, initialForm, mayDownload, monitorDescriptions,
  monitorLabels, panelView, validateForm, withMonitor,
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
  assert.deepEqual(fresh, { rootFolderId: 2, qualityProfileId: null, monitor: 'none', monitorNewItems: 'none', searchForMissingEpisodes: false });
  assert.equal(validateForm(fresh, options), 'Choose a quality profile.');
  const rememberedForm = initialForm(options, { rootFolderId: 2, qualityProfileId: 4, monitor: 'all' });
  assert.equal(rememberedForm.qualityProfileId, 4); assert.equal(rememberedForm.monitor, 'none');
  // A remembered folder that is now inaccessible or gone is not reused.
  assert.equal(initialForm({ ...options, rootFolders: [...options.rootFolders, { id: 9, path: '/tv2', accessible: true, freeSpace: 1 }] }, { rootFolderId: 3 }).rootFolderId, null);
  assert.equal(initialForm(options, { qualityProfileId: 99 }).qualityProfileId, null);
  assert.equal(validateForm({ ...fresh, qualityProfileId: 4 }, options), null);
});

test('form: validation mirrors the server', () => {
  const ok = { rootFolderId: 2, qualityProfileId: 4, monitor: 'none', monitorNewItems: 'none', searchForMissingEpisodes: false };
  assert.equal(validateForm(ok, null), 'Loading Sonarr options…');
  assert.equal(validateForm({ ...ok, rootFolderId: 3 }, options), 'Choose a root folder.');
  assert.equal(validateForm({ ...ok, monitor: 'bogus' }, options), 'Choose a monitoring option.');
  assert.equal(validateForm({ ...ok, searchForMissingEpisodes: true }, options), 'Searching needs monitored episodes.');
  assert.equal(validateForm(ok, { ...options, rootFolders: [] }), 'Sonarr has no accessible root folder.');
  assert.equal(validateForm(ok, { ...options, qualityProfiles: [] }), 'Sonarr has no quality profiles.');
});

test('monitoring selections: "none" turns searching off; download warning when anything is monitored', () => {
  const base = { rootFolderId: 2, qualityProfileId: 4, monitor: 'future', monitorNewItems: 'none', searchForMissingEpisodes: true };
  assert.equal(withMonitor(base, 'none').searchForMissingEpisodes, false);
  assert.equal(withMonitor(base, 'all').searchForMissingEpisodes, true);
  assert.equal(mayDownload({ ...base, monitor: 'none', searchForMissingEpisodes: false }), false);
  assert.equal(mayDownload({ ...base, monitor: 'none', searchForMissingEpisodes: false, monitorNewItems: 'all' }), true);
  assert.equal(mayDownload({ ...base, searchForMissingEpisodes: false }), true);
  assert.deepEqual(addRequest(base, 81189), { tvdbId: 81189, rootFolderId: 2, qualityProfileId: 4, monitor: 'future', monitorNewItems: 'none', searchForMissingEpisodes: true });
  for (const option of options.monitorOptions) { assert.ok(monitorLabels[option]); assert.ok(monitorDescriptions[option]); }
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
  const panel = fs.readFileSync(new URL('../src/components/sonarr-panel.tsx', import.meta.url), 'utf8');
  const literals = new Set();
  for (const match of lib.matchAll(/(?:message|return|: )\s*"([A-Z][^"]{2,})"/g)) literals.add(match[1]);
  for (const match of panel.matchAll(/<T>(?:\{")?([^<"]+?)(?:"\})?<\/T>/g)) literals.add(match[1]);
  for (const match of panel.matchAll(/phrase\(language, "([^"]+)"\)/g)) literals.add(match[1]);
  for (const text of [...Object.values(monitorLabels), ...Object.values(monitorDescriptions)]) literals.add(text);
  assert.ok(literals.size > 40);
  for (const text of literals) {
    const entry = phrases[text];
    assert.ok(Array.isArray(entry) && entry.length === 2 && entry.every(value => value.trim()), `missing translation: ${text}`);
  }
});

test('security and separation: the browser never talks to Sonarr or touches viewing data', () => {
  const files = ['../src/lib/sonarr.ts', '../src/components/sonarr-panel.tsx', '../src/services/sonarr.service.ts'].map(file => fs.readFileSync(new URL(file, import.meta.url), 'utf8'));
  for (const source of files) {
    assert.ok(!/X-Api-Key|apikey|SONARR_API_KEY|VITE_SONARR/i.test(source), 'no Sonarr credentials in frontend code');
    assert.ok(!/\/api\/v3|sonarr\.aniskh\.com/i.test(source), 'no direct Sonarr API access');
    assert.ok(!/ShowService|setEpisodeWatched|markSeasonWatched|updateShow|toggleFavorite|MovieService/.test(source), 'Sonarr UI must not change viewing data');
  }
  const modal = fs.readFileSync(new URL('../src/modals/MovieModal.tsx', import.meta.url), 'utf8');
  assert.ok(!/Sonarr/i.test(modal), 'no Sonarr actions on movies');
});
