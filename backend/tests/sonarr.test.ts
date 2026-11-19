import assert from 'node:assert/strict';
import util from 'node:util';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import axios, { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';

// Obviously fake values: no real Sonarr URL, key or library is used. Every Sonarr call goes to an in-memory fake.
const FAKE_KEY = 'f00dfeedf00dfeedf00dfeedf00dfeed';
const FAKE_URL = 'https://sonarr.example.test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'sonarr-test-only-secret';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://unused:unused@127.0.0.1:1/unused';

import { SonarrClient, SonarrError, readSonarrConfig, type SonarrSeriesResource } from '../src/services/sonarr/sonarr-client';
import { buildAddPayload, chooseSonarrMatch, findExisting, parseAddRequest, posterOf, seriesLink, isAlreadyAddedRejection, SAFE_DEFAULTS } from '../src/services/sonarr/sonarr-match.model';
import { createSonarrService, checkSonarrConnection, SonarrRequestError, type SonarrDeps } from '../src/services/sonarr/sonarr.service';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, run: () => Promise<void> | void) => tests.push([name, run]);

/* ---------- Fixtures ---------- */

const BREAKING_BAD: SonarrSeriesResource = { title: 'Breaking Bad', year: 2008, tvdbId: 81189, tmdbId: 1396, imdbId: 'tt0903747', titleSlug: 'breaking-bad', seriesType: 'standard', remotePoster: 'https://artworks.thetvdb.com/banners/posters/81189-10.jpg', seasons: [{ seasonNumber: 0, monitored: false }, { seasonNumber: 1, monitored: true }, { seasonNumber: 2, monitored: true }], images: [] };
// Same English title, different series (a remake): must never be confused with the original.
const REMAKE: SonarrSeriesResource = { title: 'Breaking Bad', year: 2030, tvdbId: 999001, tmdbId: 777001, imdbId: 'tt9999999', titleSlug: 'breaking-bad-2030', seasons: [] };
const SHOW_ID = '11111111-1111-4111-8111-111111111111';
const OWNER = 'owner-user';

class FakeSonarr {
  calls: string[] = [];
  library: SonarrSeriesResource[] = [];
  lookups: Record<string, SonarrSeriesResource[]> = { 'tvdb:81189': [BREAKING_BAD], 'tmdb:1396': [BREAKING_BAD] };
  rootFolderList = [{ id: 2, path: '/tv', accessible: true, freeSpace: 1000 }, { id: 3, path: '/offline', accessible: false }];
  profiles = [{ id: 4, name: 'HD-1080p' }, { id: 1, name: 'Any' }];
  failWith: SonarrError | null = null;
  addFailWith: SonarrError | null = null;
  addDelay = 0;
  posted: Record<string, unknown>[] = [];
  readonly baseUrl = FAKE_URL;
  private guard(name: string) { this.calls.push(name); if (this.failWith) throw this.failWith; }
  async systemStatus() { this.guard('status'); return { version: '4.0.20' }; }
  async rootFolders() { this.guard('rootfolder'); return this.rootFolderList; }
  async qualityProfiles() { this.guard('qualityprofile'); return this.profiles; }
  async lookup(kind: 'tvdb' | 'tmdb', id: number) { this.guard(`lookup:${kind}:${id}`); return this.lookups[`${kind}:${id}`] || []; }
  async seriesByTvdbId(tvdbId: number) { this.guard(`series:${tvdbId}`); return this.library.filter(item => item.tvdbId === tvdbId); }
  async addSeries(payload: Record<string, unknown>) {
    this.calls.push('add');
    if (this.addDelay) await new Promise(resolve => setTimeout(resolve, this.addDelay));
    if (this.addFailWith) throw this.addFailWith;
    if (this.library.some(item => item.tvdbId === payload.tvdbId)) throw new SonarrError('rejected', 400, ['This series has already been added']);
    this.posted.push(payload);
    const created = { ...(payload as SonarrSeriesResource), id: 100 + this.library.length };
    this.library.push(created);
    return created;
  }
}

function service(options: { fake?: FakeSonarr | null; external?: { tvdbId: number | null; imdbId: string | null }; tmdbId?: number | null; allowed?: boolean } = {}) {
  const fake = options.fake === undefined ? new FakeSonarr() : options.fake;
  const viewingWrites: string[] = [];
  const deps: SonarrDeps = {
    client: () => fake as unknown as SonarrClient,
    externalIds: async () => options.external || { tvdbId: 81189, imdbId: 'tt0903747' },
    findShow: async (showId, userId) => showId === SHOW_ID && userId === OWNER ? { id: SHOW_ID, name: 'Breaking Bad', tmdbId: options.tmdbId === undefined ? 1396 : options.tmdbId, posterURL: '/poster.jpg' } : null,
    isAllowed: async userId => options.allowed !== false && userId === OWNER,
  };
  if (fake === null) deps.client = () => null;
  return { svc: createSonarrService(deps), fake: fake as FakeSonarr, viewingWrites };
}

const addBody = (overrides: Record<string, unknown> = {}) => ({ tvdbId: 81189, rootFolderId: 2, qualityProfileId: 4, ...SAFE_DEFAULTS, ...overrides });
const parsed = (body: Record<string, unknown>) => { const result = parseAddRequest(body); assert.ok(result.ok, 'request should be valid'); return result.value; };
async function rejects(promise: Promise<unknown>, status: number, code: string) {
  try { await promise; } catch (error) {
    assert.ok(error instanceof SonarrRequestError, `expected SonarrRequestError, got ${error}`);
    assert.equal(error.status, status); assert.equal(error.code, code); return error;
  }
  assert.fail(`expected ${status} ${code}`);
}

/* ---------- Configuration ---------- */

test('configuration: missing, invalid and valid values; the key is never part of the base URL', () => {
  assert.deepEqual(readSonarrConfig({}), { config: null, error: 'missing' });
  assert.equal(readSonarrConfig({ SONARR_URL: FAKE_URL }).error, 'missing');
  assert.equal(readSonarrConfig({ SONARR_API_KEY: FAKE_KEY }).error, 'missing');
  assert.equal(readSonarrConfig({ SONARR_URL: 'not a url', SONARR_API_KEY: FAKE_KEY }).error, 'invalid_url');
  assert.equal(readSonarrConfig({ SONARR_URL: 'ftp://sonarr.example.test', SONARR_API_KEY: FAKE_KEY }).error, 'invalid_url');
  assert.equal(readSonarrConfig({ SONARR_URL: 'https://user:pass@sonarr.example.test', SONARR_API_KEY: FAKE_KEY }).error, 'invalid_url');
  assert.equal(readSonarrConfig({ SONARR_URL: `${FAKE_URL}/?apikey=x`, SONARR_API_KEY: FAKE_KEY }).error, 'invalid_url');
  assert.equal(readSonarrConfig({ SONARR_URL: FAKE_URL, SONARR_API_KEY: 'short' }).error, 'invalid_key');
  assert.equal(readSonarrConfig({ SONARR_URL: FAKE_URL, SONARR_API_KEY: 'has spaces in it 1234567890' }).error, 'invalid_key');
  const ok = readSonarrConfig({ SONARR_URL: `${FAKE_URL}/`, SONARR_API_KEY: ` ${FAKE_KEY} ` });
  assert.deepEqual(ok, { config: { baseUrl: FAKE_URL, apiKey: FAKE_KEY }, error: null });
  assert.equal(readSonarrConfig({ SONARR_URL: `${FAKE_URL}/sonarr/`, SONARR_API_KEY: FAKE_KEY }).config?.baseUrl, `${FAKE_URL}/sonarr`);
});

/* ---------- TMDB -> TVDB identity ---------- */

test('matching: TMDB external IDs name the TVDB series and Sonarr confirms it', () => {
  const match = chooseSonarrMatch({ tmdbId: 1396, external: { tvdbId: 81189, imdbId: 'tt0903747' }, byTvdb: [BREAKING_BAD] });
  assert.ok(match.ok); assert.equal(match.tvdbId, 81189); assert.equal(match.source, 'tmdb_external_ids');
});

test('matching: duplicate titles and remakes are separated by identifier, never by title', () => {
  const match = chooseSonarrMatch({ tmdbId: 1396, external: { tvdbId: 81189, imdbId: null }, byTvdb: [REMAKE, BREAKING_BAD] });
  assert.ok(match.ok); assert.equal(match.series.year, 2008);
  // A lookup that only returns a same-titled series never matches.
  assert.deepEqual(chooseSonarrMatch({ tmdbId: 1396, external: { tvdbId: 81189, imdbId: null }, byTvdb: [REMAKE] }), { ok: false, reason: 'not_found' });
  // Different-language titles do not matter: identifiers agree, so it matches.
  assert.ok(chooseSonarrMatch({ tmdbId: 1396, external: { tvdbId: 81189, imdbId: null }, byTvdb: [{ ...BREAKING_BAD, title: 'ブレイキング・バッド' }] }).ok);
});

test('matching: missing TVDB mapping falls back only to an exact single Sonarr TMDB mapping', () => {
  const fallback = chooseSonarrMatch({ tmdbId: 1396, external: { tvdbId: null, imdbId: 'tt0903747' }, byTmdb: [BREAKING_BAD] });
  assert.ok(fallback.ok); assert.equal(fallback.source, 'sonarr_tmdb_mapping'); assert.equal(fallback.tvdbId, 81189);
  assert.deepEqual(chooseSonarrMatch({ tmdbId: 1396, external: { tvdbId: null, imdbId: null }, byTmdb: [] }), { ok: false, reason: 'no_tvdb_mapping' });
  assert.deepEqual(chooseSonarrMatch({ tmdbId: 1396, external: { tvdbId: null, imdbId: null }, byTmdb: [REMAKE] }), { ok: false, reason: 'no_tvdb_mapping' });
  assert.deepEqual(chooseSonarrMatch({ tmdbId: 1396, external: { tvdbId: null, imdbId: null }, byTmdb: [{ ...BREAKING_BAD, tvdbId: 0 }] }), { ok: false, reason: 'no_tvdb_mapping' });
  assert.deepEqual(chooseSonarrMatch({ tmdbId: 1396, external: { tvdbId: null, imdbId: 'tt0903747' }, byTmdb: [{ ...BREAKING_BAD, imdbId: 'tt1111111' }] }), { ok: false, reason: 'conflicting_ids' });
});

test('matching: ambiguous and contradictory candidates are rejected', () => {
  assert.deepEqual(chooseSonarrMatch({ tmdbId: 1396, external: { tvdbId: 81189, imdbId: null }, byTvdb: [BREAKING_BAD, { ...BREAKING_BAD }] }), { ok: false, reason: 'ambiguous' });
  assert.deepEqual(chooseSonarrMatch({ tmdbId: 1396, external: { tvdbId: null, imdbId: null }, byTmdb: [BREAKING_BAD, { ...REMAKE, tmdbId: 1396 }] }), { ok: false, reason: 'ambiguous' });
  assert.deepEqual(chooseSonarrMatch({ tmdbId: 1396, external: { tvdbId: 81189, imdbId: null }, byTvdb: [{ ...BREAKING_BAD, tmdbId: 5555 }] }), { ok: false, reason: 'conflicting_ids' });
  assert.deepEqual(chooseSonarrMatch({ tmdbId: 1396, external: { tvdbId: 81189, imdbId: 'tt0903747' }, byTvdb: [{ ...BREAKING_BAD, imdbId: 'tt0000001' }] }), { ok: false, reason: 'conflicting_ids' });
  // Sonarr not knowing the TMDB/IMDb ID is not a contradiction.
  assert.ok(chooseSonarrMatch({ tmdbId: 1396, external: { tvdbId: 81189, imdbId: 'tt0903747' }, byTvdb: [{ ...BREAKING_BAD, tmdbId: 0, imdbId: '' }] }).ok);
  assert.deepEqual(chooseSonarrMatch({ tmdbId: 1396, external: { tvdbId: 81189, imdbId: null }, byTvdb: null }), { ok: false, reason: 'not_found' });
});

test('existing series are detected by TVDB ID with a Sonarr library ID', () => {
  assert.equal(findExisting([{ ...REMAKE, id: 5 }], 81189), null);
  assert.equal(findExisting([{ ...BREAKING_BAD }], 81189), null, 'a lookup record without a library id is not "existing"');
  assert.equal(findExisting([{ ...BREAKING_BAD, id: 53 }], 81189)?.id, 53);
});

/* ---------- Request validation and payload ---------- */

test('add requests: strict validation with safe defaults', () => {
  assert.deepEqual(parsed(addBody()), { tvdbId: 81189, rootFolderId: 2, qualityProfileId: 4, monitor: 'none', monitorNewItems: 'none', searchForMissingEpisodes: false });
  assert.equal(parseAddRequest(addBody({ rootFolderPath: '/etc' })).ok, false, 'client paths are refused');
  assert.equal(parseAddRequest(addBody({ url: 'https://evil.example' })).ok, false);
  assert.equal(parseAddRequest(addBody({ monitor: 'everything' })).ok, false);
  assert.equal(parseAddRequest(addBody({ monitor: 'latestSeason' })).ok, false, 'deprecated options are not offered');
  assert.equal(parseAddRequest(addBody({ monitorNewItems: 'some' })).ok, false);
  assert.equal(parseAddRequest(addBody({ searchForMissingEpisodes: 'true' })).ok, false);
  assert.equal(parseAddRequest(addBody({ searchForMissingEpisodes: true })).ok, false, 'search requires monitored episodes');
  assert.ok(parseAddRequest(addBody({ monitor: 'future', searchForMissingEpisodes: true })).ok);
  assert.equal(parseAddRequest(addBody({ tvdbId: -1 })).ok, false);
  assert.equal(parseAddRequest(addBody({ rootFolderId: '2' })).ok, false);
  assert.equal(parseAddRequest(addBody({ qualityProfileId: 1.5 })).ok, false);
  assert.equal(parseAddRequest(null).ok, false);
  assert.equal(parseAddRequest([]).ok, false);
});

test('payload: monitoring "none" monitors nothing and never searches', () => {
  const payload = buildAddPayload({ ...BREAKING_BAD, id: 9, path: '/somewhere' } as SonarrSeriesResource, { rootFolderPath: '/tv', qualityProfileId: 4, monitor: 'none', monitorNewItems: 'none', searchForMissingEpisodes: false });
  assert.equal(payload.monitored, false);
  assert.ok(payload.seasons.every(season => season.monitored === false));
  assert.deepEqual(payload.addOptions, { monitor: 'none', searchForMissingEpisodes: false, searchForCutoffUnmetEpisodes: false, ignoreEpisodesWithFiles: false, ignoreEpisodesWithoutFiles: false });
  assert.equal(payload.monitorNewItems, 'none');
  assert.equal(payload.rootFolderPath, '/tv'); assert.equal(payload.qualityProfileId, 4); assert.equal(payload.tvdbId, 81189);
  assert.equal('id' in payload, false); assert.equal('path' in payload, false);
  const monitored = buildAddPayload(BREAKING_BAD, { rootFolderPath: '/tv', qualityProfileId: 4, monitor: 'future', monitorNewItems: 'all', searchForMissingEpisodes: true });
  assert.equal(monitored.monitored, true); assert.equal(monitored.addOptions.monitor, 'future'); assert.equal(monitored.addOptions.searchForMissingEpisodes, true); assert.equal(monitored.monitorNewItems, 'all');
  assert.equal(buildAddPayload({ ...BREAKING_BAD, seriesType: 'weird' }, { rootFolderPath: '/tv', qualityProfileId: 4, monitor: 'none', monitorNewItems: 'none', searchForMissingEpisodes: false }).seriesType, 'standard');
});

test('posters and links: HTTPS posters only; links use the configured host and a validated slug', () => {
  assert.equal(posterOf(BREAKING_BAD), BREAKING_BAD.remotePoster);
  assert.equal(posterOf({ remotePoster: 'http://insecure.example/p.jpg' }), null);
  assert.equal(posterOf({ images: [{ coverType: 'poster', remoteUrl: 'javascript:alert(1)' }] }), null);
  assert.equal(seriesLink(FAKE_URL, BREAKING_BAD), `${FAKE_URL}/series/breaking-bad`);
  assert.equal(seriesLink(FAKE_URL, { titleSlug: '../../admin' }), `${FAKE_URL}/`);
  assert.ok(isAlreadyAddedRejection(['This series has already been added']));
  assert.ok(!isAlreadyAddedRejection(['Root folder does not exist']));
});

/* ---------- Service: status ---------- */

test('status: not configured, not allowed, not linked, unmatched', async () => {
  assert.deepEqual(await service({ fake: null }).svc.status(SHOW_ID, OWNER), { state: 'not_configured' });
  assert.deepEqual(await service().svc.status(SHOW_ID, 'someone-else'), { state: 'forbidden' });
  assert.deepEqual(await service({ allowed: false }).svc.status(SHOW_ID, OWNER), { state: 'forbidden' });
  assert.deepEqual(await service({ tmdbId: null }).svc.status(SHOW_ID, OWNER), { state: 'no_tmdb_link' });
  const { svc, fake } = service({ external: { tvdbId: null, imdbId: null } });
  fake.lookups['tmdb:1396'] = [];
  assert.deepEqual(await svc.status(SHOW_ID, OWNER), { state: 'unmatched', reason: 'no_tvdb_mapping' });
  const ambiguous = service(); ambiguous.fake.lookups['tvdb:81189'] = [BREAKING_BAD, { ...BREAKING_BAD }];
  assert.deepEqual(await ambiguous.svc.status(SHOW_ID, OWNER), { state: 'unmatched', reason: 'ambiguous' });
});

test('status: another user\'s show is not found', async () => {
  // Same show id, different (allowed) user: the library record lookup is scoped by user.
  const fake = new FakeSonarr();
  const svc = createSonarrService({ client: () => fake as unknown as SonarrClient, externalIds: async () => ({ tvdbId: 81189, imdbId: null }), findShow: async () => null, isAllowed: async () => true });
  await rejects(svc.status(SHOW_ID, 'intruder'), 404, 'show_not_found');
  assert.deepEqual(fake.calls, []);
});

test('status: available vs already in Sonarr, with caching', async () => {
  const { svc, fake } = service();
  const available = await svc.status(SHOW_ID, OWNER);
  assert.equal(available.state, 'available');
  assert.ok(available.state === 'available' && available.series.tvdbId === 81189 && available.series.title === 'Breaking Bad' && available.series.year === 2008 && available.series.seasonCount === 2);
  await svc.status(SHOW_ID, OWNER);
  assert.equal(fake.calls.filter(call => call.startsWith('lookup')).length, 1, 'lookups are cached');
  assert.equal(fake.calls.filter(call => call.startsWith('series')).length, 1, 'existence is cached briefly');
  const existing = service(); existing.fake.library.push({ ...BREAKING_BAD, id: 53 });
  const status = await existing.svc.status(SHOW_ID, OWNER);
  assert.equal(status.state, 'exists');
  assert.ok(status.state === 'exists' && status.sonarrUrl === `${FAKE_URL}/series/breaking-bad`);
});

test('status: Sonarr failures are non-blocking states, never thrown', async () => {
  for (const code of ['timeout', 'unreachable', 'unauthorized', 'bad_response'] as const) {
    const { svc, fake } = service(); fake.failWith = new SonarrError(code);
    assert.deepEqual(await svc.status(SHOW_ID, OWNER), { state: 'unavailable', reason: code });
  }
  const tmdbDown = createSonarrService({ client: () => new FakeSonarr() as unknown as SonarrClient, externalIds: async () => { throw new Error('TMDB down'); }, findShow: async () => ({ id: SHOW_ID, name: 'x', tmdbId: 1396, posterURL: null }), isAllowed: async () => true });
  assert.deepEqual(await tmdbDown.status(SHOW_ID, OWNER), { state: 'unavailable', reason: 'tmdb_unavailable' });
  await rejects(tmdbDown.add(SHOW_ID, OWNER, parsed(addBody())), 502, 'tmdb_unavailable');
  // A failed lookup is not cached: the next request retries and succeeds.
  const { svc, fake } = service(); fake.failWith = new SonarrError('timeout');
  await svc.status(SHOW_ID, OWNER); fake.failWith = null;
  assert.equal((await svc.status(SHOW_ID, OWNER)).state, 'available');
});

/* ---------- Service: options ---------- */

test('options: root folders and quality profiles come from Sonarr with safe defaults', async () => {
  const { svc } = service();
  const options = await svc.getOptions(OWNER);
  assert.deepEqual(options.rootFolders, [{ id: 2, path: '/tv', accessible: true, freeSpace: 1000 }, { id: 3, path: '/offline', accessible: false, freeSpace: null }]);
  assert.deepEqual(options.qualityProfiles, [{ id: 4, name: 'HD-1080p' }, { id: 1, name: 'Any' }]);
  assert.deepEqual(options.defaults, { monitor: 'none', monitorNewItems: 'none', searchForMissingEpisodes: false });
  assert.ok(options.monitorOptions.includes('none') && options.monitorOptions.includes('all'));
  await rejects(service({ fake: null }).svc.getOptions(OWNER), 503, 'not_configured');
  await rejects(service().svc.getOptions('someone-else'), 403, 'forbidden');
  const down = service(); down.fake.failWith = new SonarrError('unreachable');
  await rejects(down.svc.getOptions(OWNER), 502, 'unavailable');
  const slow = service(); slow.fake.failWith = new SonarrError('timeout');
  await rejects(slow.svc.getOptions(OWNER), 504, 'timeout');
  const badKey = service(); badKey.fake.failWith = new SonarrError('unauthorized', 401);
  const error = await rejects(badKey.svc.getOptions(OWNER), 502, 'unavailable');
  assert.notEqual(error.status, 401, 'a Sonarr 401 must never log the Cinetra user out');
});

/* ---------- Service: add ---------- */

test('add: verified series with selected options; nothing monitored by default', async () => {
  const { svc, fake } = service();
  const result = await svc.add(SHOW_ID, OWNER, parsed(addBody()));
  assert.equal(result.added, true);
  assert.equal(result.status.state, 'exists');
  assert.ok(result.status.state === 'exists' && result.status.sonarrUrl === `${FAKE_URL}/series/breaking-bad`);
  assert.equal(fake.posted.length, 1);
  const payload = fake.posted[0] as ReturnType<typeof buildAddPayload>;
  assert.equal(payload.tvdbId, 81189); assert.equal(payload.rootFolderPath, '/tv'); assert.equal(payload.qualityProfileId, 4);
  assert.equal(payload.monitored, false); assert.equal(payload.addOptions.monitor, 'none'); assert.equal(payload.addOptions.searchForMissingEpisodes, false);
  // The UI reflects the new state immediately (status is re-read, not cached as "available").
  assert.equal((await svc.status(SHOW_ID, OWNER)).state, 'exists');
});

test('add: monitoring selections are passed through exactly', async () => {
  for (const monitor of ['future', 'missing', 'existing', 'recent', 'pilot', 'firstSeason', 'lastSeason', 'all'] as const) {
    const { svc, fake } = service();
    await svc.add(SHOW_ID, OWNER, parsed(addBody({ monitor, monitorNewItems: 'all', searchForMissingEpisodes: monitor === 'missing', qualityProfileId: 1 })));
    const payload = fake.posted[0] as ReturnType<typeof buildAddPayload>;
    assert.equal(payload.addOptions.monitor, monitor); assert.equal(payload.monitored, true); assert.equal(payload.monitorNewItems, 'all');
    assert.equal(payload.addOptions.searchForMissingEpisodes, monitor === 'missing'); assert.equal(payload.qualityProfileId, 1);
  }
});

test('add: duplicates are refused without a write', async () => {
  const { svc, fake } = service();
  fake.library.push({ ...BREAKING_BAD, id: 53 });
  const error = await rejects(svc.add(SHOW_ID, OWNER, parsed(addBody())), 409, 'already_exists');
  assert.equal((error.detail?.status as { state: string }).state, 'exists');
  assert.equal(fake.calls.includes('add'), false);
  // Second submission after a success is a duplicate too.
  const again = service();
  await again.svc.add(SHOW_ID, OWNER, parsed(addBody()));
  await rejects(again.svc.add(SHOW_ID, OWNER, parsed(addBody())), 409, 'already_exists');
  assert.equal(again.fake.posted.length, 1);
});

test('add: concurrent submissions add the series once', async () => {
  const { svc, fake } = service(); fake.addDelay = 30;
  const results = await Promise.allSettled([svc.add(SHOW_ID, OWNER, parsed(addBody())), svc.add(SHOW_ID, OWNER, parsed(addBody())), svc.add(SHOW_ID, OWNER, parsed(addBody()))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter(result => result.status === 'rejected').every(result => (result as PromiseRejectedResult).reason.code === 'in_progress'));
  assert.equal(fake.posted.length, 1);
  // Sonarr's own duplicate refusal (e.g. added from Sonarr's UI meanwhile) is reported as "already in Sonarr".
  const race = service(); race.fake.addFailWith = new SonarrError('rejected', 400, ['This series has already been added']);
  await rejects(race.svc.add(SHOW_ID, OWNER, parsed(addBody())), 409, 'already_exists');
});

test('add: identity, root folder and quality profile are re-validated server-side', async () => {
  await rejects(service().svc.add(SHOW_ID, OWNER, parsed(addBody({ tvdbId: 999001 }))), 409, 'identity_changed');
  await rejects(service().svc.add(SHOW_ID, OWNER, parsed(addBody({ rootFolderId: 77 }))), 400, 'invalid_root_folder');
  await rejects(service().svc.add(SHOW_ID, OWNER, parsed(addBody({ rootFolderId: 3 }))), 400, 'invalid_root_folder');
  await rejects(service().svc.add(SHOW_ID, OWNER, parsed(addBody({ qualityProfileId: 77 }))), 400, 'invalid_quality_profile');
  const unmatched = service(); unmatched.fake.lookups['tvdb:81189'] = [{ ...BREAKING_BAD, tmdbId: 5555 }];
  await rejects(unmatched.svc.add(SHOW_ID, OWNER, parsed(addBody())), 422, 'unmatched');
  assert.equal(unmatched.fake.calls.includes('add'), false);
  await rejects(service({ tmdbId: null }).svc.add(SHOW_ID, OWNER, parsed(addBody())), 409, 'no_tmdb_link');
  await rejects(service().svc.add(SHOW_ID, 'someone-else', parsed(addBody())), 403, 'forbidden');
  await rejects(service({ fake: null }).svc.add(SHOW_ID, OWNER, parsed(addBody())), 503, 'not_configured');
});

test('add: failures are reported clearly; a timeout is "uncertain"', async () => {
  const timeout = service(); timeout.fake.addFailWith = new SonarrError('timeout');
  await rejects(timeout.svc.add(SHOW_ID, OWNER, parsed(addBody())), 504, 'uncertain');
  const rejected = service(); rejected.fake.addFailWith = new SonarrError('rejected', 400, ['Path is invalid']);
  const error = await rejects(rejected.svc.add(SHOW_ID, OWNER, parsed(addBody())), 422, 'rejected');
  assert.ok(!error.message.includes('Path is invalid'), 'Sonarr messages are not forwarded');
  const down = service(); down.fake.addFailWith = new SonarrError('unreachable');
  await rejects(down.svc.add(SHOW_ID, OWNER, parsed(addBody())), 502, 'unavailable');
  // After a failure the lock is released: a retry works.
  down.fake.addFailWith = null;
  assert.equal((await down.svc.add(SHOW_ID, OWNER, parsed(addBody()))).added, true);
});

/* ---------- Client: headers, redirects and secret handling ---------- */

function clientWith(adapter: AxiosAdapter) {
  const config = readSonarrConfig({ SONARR_URL: FAKE_URL, SONARR_API_KEY: FAKE_KEY }).config!;
  const client = new SonarrClient(config);
  (client as unknown as { http: { defaults: { adapter: AxiosAdapter } } }).http.defaults.adapter = adapter;
  return client;
}
function assertNoSecret(value: unknown) {
  const renderings = [util.inspect(value, { depth: Infinity, showHidden: true }), util.format('%o', value), JSON.stringify(value), String(value), (value as Error)?.stack || ''];
  for (const text of renderings) assert.ok(!text.includes(FAKE_KEY), 'API key leaked');
}

test('client: sends the key as a header to the configured host only, without following redirects', async () => {
  let seen: InternalAxiosRequestConfig | null = null;
  const client = clientWith(async config => { seen = config; return { data: [{ id: 2, path: '/tv' }], status: 200, statusText: 'OK', headers: {}, config }; });
  assert.deepEqual(await client.rootFolders(), [{ id: 2, path: '/tv' }]);
  const request = seen as unknown as InternalAxiosRequestConfig;
  assert.equal(request.baseURL, `${FAKE_URL}/api/v3`);
  assert.equal(request.headers['X-Api-Key'], FAKE_KEY);
  assert.equal(request.maxRedirects, 0);
  assert.ok(!String(request.url).includes(FAKE_KEY) && !JSON.stringify(request.params || {}).includes(FAKE_KEY), 'key never in the URL');
  await assert.rejects(client.lookup('tvdb', -5), (error: unknown) => error instanceof SonarrError);
});

test('client: errors are sanitized and classified', async () => {
  const fail = (status: number | null, data: unknown = 'Internal error with X-Api-Key: ' + FAKE_KEY, code?: string): AxiosAdapter => async config => {
    if (status === null) throw new AxiosError('timeout of 10000ms exceeded', code || 'ECONNABORTED', config);
    throw new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, null, { data, status, statusText: 'x', headers: {}, config });
  };
  const cases: Array<[AxiosAdapter, string]> = [
    [fail(null), 'timeout'], [fail(null, undefined, 'ECONNREFUSED'), 'unreachable'], [fail(401), 'unauthorized'], [fail(403), 'unauthorized'],
    [fail(404), 'not_found'], [fail(500), 'unreachable'], [fail(302), 'bad_response'],
    [fail(400, [{ propertyName: 'TvdbId', errorMessage: 'This series has already been added' }]), 'rejected'],
  ];
  for (const [adapter, code] of cases) {
    const error = await clientWith(adapter).systemStatus().then(() => null, (caught: unknown) => caught);
    assert.ok(error instanceof SonarrError, `expected SonarrError for ${code}`);
    assert.equal(error.code, code);
    assertNoSecret(error);
    assert.equal((error as unknown as { config?: unknown }).config, undefined);
    assert.equal((error as unknown as { cause?: unknown }).cause, undefined);
  }
  const html = clientWith(async config => ({ data: '<html>login</html>', status: 200, statusText: 'OK', headers: {}, config }));
  await assert.rejects(html.systemStatus(), (error: unknown) => error instanceof SonarrError && error.code === 'bad_response');
});

test('health check: counts only, never paths, names or the key', async () => {
  const fake = new FakeSonarr();
  const ok = await checkSonarrConnection(fake as unknown as SonarrClient, null);
  assert.deepEqual({ ...ok, checkedAt: null }, { configured: true, configError: null, connected: true, checkedAt: null, rootFolders: 2, qualityProfiles: 2, error: null });
  assert.ok(!JSON.stringify(ok).includes('/tv') && !JSON.stringify(ok).includes('HD-1080p'));
  fake.failWith = new SonarrError('unauthorized', 401);
  const failed = await checkSonarrConnection(fake as unknown as SonarrClient, null);
  assert.equal(failed.connected, false); assert.equal(failed.error, 'unauthorized');
  const missing = await checkSonarrConnection(null, 'missing');
  assert.equal(missing.configured, false); assert.equal(missing.connected, null);
});

/* ---------- HTTP routes: authentication, validation and secret handling ---------- */

test('routes: authentication required, JSON-only writes, strict bodies, no secrets in responses', async () => {
  process.env.SONARR_URL = FAKE_URL; process.env.SONARR_API_KEY = FAKE_KEY;
  const express = (await import('express')).default;
  const { protectedRoute } = await import('../src/middlewares/protectedRoute');
  const { createSonarrRouter } = await import('../src/api/v1/sonarr');
  const { securityModule } = await import('../src/modules/security');
  const { svc, fake } = service();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/sonarr', protectedRoute, createSonarrRouter(svc));
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/sonarr`;
  const owner = `Bearer ${await securityModule.Commands.GenerateTokenCommand.execute(OWNER)}`;
  const other = `Bearer ${await securityModule.Commands.GenerateTokenCommand.execute('someone-else')}`;
  const call = async (path: string, init: { method?: string; auth?: string; body?: string; type?: string } = {}) => {
    const response = await fetch(base + path, { method: init.method || 'GET', headers: { ...(init.auth ? { Authorization: init.auth } : {}), ...(init.type ? { 'Content-Type': init.type } : {}) }, body: init.body });
    const text = await response.text();
    assert.ok(!text.includes(FAKE_KEY), 'API key leaked in a response');
    let body: any = text; try { body = text ? JSON.parse(text) : null; } catch { /* plain text (e.g. 401) */ }
    return { status: response.status, body, cache: response.headers.get('cache-control') };
  };
  try {
    assert.equal((await call(`/shows/${SHOW_ID}`)).status, 401);
    assert.equal((await call(`/shows/${SHOW_ID}`, { auth: 'Bearer not-a-token' })).status, 401);
    assert.equal((await call('/options')).status, 401);
    assert.equal((await call(`/shows/${SHOW_ID}`, { method: 'POST', body: JSON.stringify(addBody()), type: 'application/json' })).status, 401);
    assert.equal(fake.calls.length, 0, 'no Sonarr call before authentication');

    assert.deepEqual((await call(`/shows/${SHOW_ID}`, { auth: other })).body, { state: 'forbidden' });
    assert.equal((await call('/options', { auth: other })).status, 403);
    assert.equal((await call(`/shows/${SHOW_ID}`, { method: 'POST', auth: other, body: JSON.stringify(addBody()), type: 'application/json' })).status, 403);

    const status = await call(`/shows/${SHOW_ID}`, { auth: owner });
    assert.equal(status.status, 200); assert.equal(status.body.state, 'available'); assert.equal(status.cache, 'no-store');
    assert.equal((await call('/shows/not-a-uuid', { auth: owner })).status, 404);
    assert.equal((await call('/options', { auth: owner })).body.rootFolders[0].path, '/tv');

    // Cross-site form posts cannot send JSON: refused before any work.
    assert.equal((await call(`/shows/${SHOW_ID}`, { method: 'POST', auth: owner, body: 'tvdbId=81189', type: 'application/x-www-form-urlencoded' })).status, 415);
    assert.equal((await call(`/shows/${SHOW_ID}`, { method: 'POST', auth: owner, body: JSON.stringify(addBody({ rootFolderPath: '/etc' })), type: 'application/json' })).status, 400);
    assert.equal((await call(`/shows/${SHOW_ID}`, { method: 'POST', auth: owner, body: JSON.stringify(addBody({ searchForMissingEpisodes: true })), type: 'application/json' })).status, 400);
    assert.equal(fake.posted.length, 0);

    const added = await call(`/shows/${SHOW_ID}`, { method: 'POST', auth: owner, body: JSON.stringify(addBody()), type: 'application/json' });
    assert.equal(added.status, 201); assert.equal(added.body.added, true); assert.equal(added.body.status.state, 'exists');
    const duplicate = await call(`/shows/${SHOW_ID}`, { method: 'POST', auth: owner, body: JSON.stringify(addBody()), type: 'application/json' });
    assert.equal(duplicate.status, 409); assert.equal(duplicate.body.code, 'already_exists'); assert.equal(duplicate.body.status.state, 'exists');
    assert.equal(fake.posted.length, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    delete process.env.SONARR_URL; delete process.env.SONARR_API_KEY;
  }
});

test('source: no Sonarr secret or Sonarr URL is hardcoded in the backend or frontend', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const roots = [path.join(__dirname, '..', 'src'), path.join(__dirname, '..', '..', 'frontend', 'src')];
  const walk = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]) : [];
  for (const file of roots.flatMap(walk)) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!/sonarr\.aniskh\.com/i.test(text), `${file} hardcodes the Sonarr host`);
    assert.ok(!/SONARR_API_KEY\s*[:=]\s*['"][A-Za-z0-9]{16,}/.test(text), `${file} hardcodes a Sonarr key`);
    if (file.includes(`${path.sep}frontend${path.sep}`)) assert.ok(!/SONARR_API_KEY|X-Api-Key/i.test(text), `${file} references the Sonarr key`);
  }
});

(async () => {
  let failed = 0;
  for (const [name, run] of tests) {
    try { await run(); console.log(`ok - ${name}`); }
    catch (error) { failed++; console.error(`not ok - ${name}`); console.error(error); }
  }
  console.log(`${tests.length - failed}/${tests.length} Sonarr tests passed`);
  process.exit(failed ? 1 : 0);
})();
