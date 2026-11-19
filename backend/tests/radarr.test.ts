import assert from 'node:assert/strict';
import util from 'node:util';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';

// Obviously fake values: no real Radarr URL, key or library is used. Every Radarr call goes to an in-memory fake.
const FAKE_KEY = 'beadfacebeadfacebeadfacebeadface';
const FAKE_URL = 'https://radarr.example.test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'radarr-test-only-secret';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://unused:unused@127.0.0.1:1/unused';

import { RadarrClient, RadarrError, readRadarrConfig, type RadarrMovieResource, type RadarrQueueItem } from '../src/services/radarr/radarr-client';
import {
  SAFE_DEFAULTS, SEARCH_COOLDOWN_MS, buildAddPayload, checkLookup, fileState, findExisting, isAlreadyAddedRejection, movieLink, parseAddRequest, parseMovieRequest,
  planRequest, posterOf, queueView,
} from '../src/services/radarr/radarr-model';
import { createRadarrService, checkRadarrConnection, RadarrRequestError, type RadarrDeps } from '../src/services/radarr/radarr.service';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, run: () => Promise<void> | void) => tests.push([name, run]);

/* ---------- Fixtures ---------- */

const MATRIX: RadarrMovieResource = {
  title: 'The Matrix', year: 1999, tmdbId: 603, imdbId: 'tt0133093', titleSlug: '603', status: 'released', isAvailable: true, monitored: false, minimumAvailability: 'tba',
  studio: 'Warner Bros. Pictures', runtime: 136, images: [{ coverType: 'poster', url: '/MediaCover/poster.jpg', remoteUrl: 'https://image.tmdb.org/t/p/original/matrix.jpg' }],
};
// Same title, different movie: must never be confused with the original.
const REMAKE: RadarrMovieResource = { ...MATRIX, tmdbId: 999603, year: 2031, titleSlug: '999603' };
const MOVIE_ID = '22222222-2222-4222-8222-222222222222';
const OWNER = 'owner-user';

class FakeRadarr {
  calls: string[] = [];
  library: RadarrMovieResource[] = [];
  lookups: Record<number, RadarrMovieResource> = { 603: MATRIX };
  rootFolderList = [{ id: 1, path: '/movies', accessible: true, freeSpace: 1000 }, { id: 3, path: '/offline', accessible: false }];
  profiles = [{ id: 4, name: 'HD-1080p' }, { id: 1, name: 'Any' }];
  queue: Record<number, RadarrQueueItem[]> = {};
  failWith: RadarrError | null = null;
  addFailWith: RadarrError | null = null;
  monitorFailWith: RadarrError | null = null;
  searchFailWith: RadarrError | null = null;
  readFailWith: RadarrError | null = null;
  /** Simulates Radarr not applying monitoring (verification must catch it). */
  ignoreMonitor = false;
  addDelay = 0;
  posted: Record<string, unknown>[] = [];
  monitored: number[][] = [];
  searched: number[][] = [];
  readonly baseUrl = FAKE_URL;
  private guard(name: string) { this.calls.push(name); if (this.failWith) throw this.failWith; }
  async systemStatus() { this.guard('status'); return { appName: 'Radarr', version: '6.4.4.10685' }; }
  async rootFolders() { this.guard('rootfolder'); return this.rootFolderList; }
  async qualityProfiles() { this.guard('qualityprofile'); return this.profiles; }
  async lookupTmdb(tmdbId: number) { this.guard(`lookup:${tmdbId}`); const hit = this.lookups[tmdbId]; if (!hit) throw new RadarrError('not_found', 404); return { ...hit }; }
  async moviesByTmdbId(tmdbId: number) { this.guard(`movies:${tmdbId}`); return this.library.filter(item => item.tmdbId === tmdbId).map(item => ({ ...item })); }
  async movieById(id: number) { this.guard(`movie:${id}`); if (this.readFailWith) throw this.readFailWith; const hit = this.library.find(item => item.id === id); if (!hit) throw new RadarrError('not_found', 404); return { ...hit }; }
  async queueForMovie(id: number) { this.guard(`queue:${id}`); return this.queue[id] || []; }
  async addMovie(payload: Record<string, unknown>): Promise<RadarrMovieResource> {
    this.calls.push('add');
    if (this.addDelay) await new Promise(resolve => setTimeout(resolve, this.addDelay));
    if (this.addFailWith) throw this.addFailWith;
    if (this.library.some(item => item.tmdbId === payload.tmdbId)) throw new RadarrError('rejected', 400, ['This movie has already been added']);
    this.posted.push(payload);
    const created = { ...(payload as RadarrMovieResource), id: 100 + this.library.length, hasFile: false };
    delete (created as Record<string, unknown>).addOptions;
    this.library.push(created);
    return { ...created };
  }
  async monitorMovies(ids: number[]) {
    this.calls.push('monitor');
    if (this.monitorFailWith) throw this.monitorFailWith;
    this.monitored.push(ids);
    if (!this.ignoreMonitor) for (const item of this.library) if (ids.includes(item.id as number)) item.monitored = true;
    return this.library.filter(item => ids.includes(item.id as number));
  }
  async searchMovies(ids: number[]) {
    this.calls.push('search');
    if (this.searchFailWith) throw this.searchFailWith;
    this.searched.push(ids);
    return { id: 9000 + this.searched.length, name: 'MoviesSearch' };
  }
  writes() { return this.calls.filter(call => call === 'add' || call === 'monitor' || call === 'search'); }
}

function service(options: { fake?: FakeRadarr | null; tmdbId?: number | null; allowed?: boolean; now?: () => number } = {}) {
  const fake = options.fake === undefined ? new FakeRadarr() : options.fake;
  const deps: RadarrDeps = {
    client: () => fake as unknown as RadarrClient,
    findMovie: async (movieId, userId) => movieId === MOVIE_ID && userId === OWNER ? { id: MOVIE_ID, name: 'The Matrix', tmdbId: options.tmdbId === undefined ? 603 : options.tmdbId, posterURL: '/poster.jpg' } : null,
    isAllowed: async userId => options.allowed !== false && userId === OWNER,
    now: options.now,
  };
  if (fake === null) deps.client = () => null;
  return { svc: createRadarrService(deps), fake: fake as FakeRadarr };
}

const inLibrary = (overrides: Partial<RadarrMovieResource> = {}): RadarrMovieResource => ({ ...MATRIX, id: 77, monitored: false, hasFile: false, isAvailable: true, ...overrides });
const addBody = (overrides: Record<string, unknown> = {}) => ({ tmdbId: 603, rootFolderId: 1, qualityProfileId: 4, ...SAFE_DEFAULTS, ...overrides });
const parsed = (body: Record<string, unknown>) => { const result = parseAddRequest(body); assert.ok(result.ok, 'request should be valid'); return result.value; };
const req = (overrides: Record<string, unknown> = {}) => { const result = parseMovieRequest({ tmdbId: 603, search: false, expected: { monitored: false, fileState: 'missing' }, ...overrides }); assert.ok(result.ok, 'request should be valid'); return result.value; };
async function rejects(promise: Promise<unknown>, status: number, code: string) {
  try { await promise; } catch (error) {
    assert.ok(error instanceof RadarrRequestError, `expected RadarrRequestError, got ${error}`);
    assert.equal(error.status, status); assert.equal(error.code, code); return error;
  }
  assert.fail(`expected ${status} ${code}`);
}

/* ---------- Configuration ---------- */

test('configuration: missing, invalid and valid values; the key is never part of the base URL', () => {
  assert.deepEqual(readRadarrConfig({}), { config: null, error: 'missing' });
  assert.equal(readRadarrConfig({ RADARR_URL: FAKE_URL }).error, 'missing');
  assert.equal(readRadarrConfig({ RADARR_API_KEY: FAKE_KEY }).error, 'missing');
  assert.equal(readRadarrConfig({ RADARR_URL: 'not a url', RADARR_API_KEY: FAKE_KEY }).error, 'invalid_url');
  assert.equal(readRadarrConfig({ RADARR_URL: 'ftp://radarr.example.test', RADARR_API_KEY: FAKE_KEY }).error, 'invalid_url');
  assert.equal(readRadarrConfig({ RADARR_URL: 'https://user:pass@radarr.example.test', RADARR_API_KEY: FAKE_KEY }).error, 'invalid_url');
  assert.equal(readRadarrConfig({ RADARR_URL: `${FAKE_URL}/?apikey=x`, RADARR_API_KEY: FAKE_KEY }).error, 'invalid_url');
  assert.equal(readRadarrConfig({ RADARR_URL: FAKE_URL, RADARR_API_KEY: 'short' }).error, 'invalid_key');
  assert.deepEqual(readRadarrConfig({ RADARR_URL: `${FAKE_URL}/`, RADARR_API_KEY: ` ${FAKE_KEY} ` }), { config: { baseUrl: FAKE_URL, apiKey: FAKE_KEY }, error: null });
  assert.equal(readRadarrConfig({ RADARR_URL: `${FAKE_URL}/radarr/`, RADARR_API_KEY: FAKE_KEY }).config?.baseUrl, `${FAKE_URL}/radarr`);
  // Sonarr's variables never configure Radarr.
  assert.equal(readRadarrConfig({ SONARR_URL: FAKE_URL, SONARR_API_KEY: FAKE_KEY }).error, 'missing');
});

/* ---------- TMDB identity ---------- */

test('matching: exact TMDB ID only; same titles and remakes never match', () => {
  assert.deepEqual(checkLookup(603, MATRIX), { ok: true, movie: MATRIX });
  assert.deepEqual(checkLookup(603, REMAKE), { ok: false, reason: 'conflicting_ids' });
  assert.deepEqual(checkLookup(603, { ...MATRIX, tmdbId: 0 }), { ok: false, reason: 'not_found' });
  assert.deepEqual(checkLookup(603, null), { ok: false, reason: 'not_found' });
  assert.deepEqual(checkLookup(603, [MATRIX] as unknown as RadarrMovieResource), { ok: false, reason: 'not_found' });
  assert.ok(checkLookup(603, { ...MATRIX, title: 'マトリックス' }).ok, 'a translated title does not matter');
});

test('existing movies are detected by TMDB ID with a Radarr library ID', () => {
  assert.equal(findExisting([{ ...REMAKE, id: 5 }], 603), null);
  assert.equal(findExisting([{ ...MATRIX }], 603), null, 'a lookup record without a library id is not "existing"');
  assert.equal(findExisting([{ ...MATRIX, id: 53 }], 603)?.id, 53);
  assert.equal(findExisting(null, 603), null);
});

test('file state: on disk, missing, not released, or unknown — only what Radarr reports', () => {
  assert.equal(fileState({ hasFile: true, isAvailable: false }), 'on_disk');
  assert.equal(fileState({ hasFile: false, isAvailable: true }), 'missing');
  assert.equal(fileState({ hasFile: false, isAvailable: false }), 'unreleased');
  assert.equal(fileState({ isAvailable: true }), 'unknown');
  assert.equal(fileState({ hasFile: false }), 'unknown');
});

test('queue: Radarr\'s own state and sizes; no invented progress', () => {
  assert.equal(queueView([]), null);
  assert.deepEqual(queueView([{ status: 'downloading', trackedDownloadState: 'downloading', size: 1000, sizeleft: 250 }]), { state: 'downloading', progress: 75 });
  assert.deepEqual(queueView([{ status: 'queued', size: 0, sizeleft: 0 }]), { state: 'queued', progress: null });
  assert.deepEqual(queueView([{ status: 'downloading' }]), { state: 'downloading', progress: null });
  assert.equal(queueView([{ status: 'completed', trackedDownloadState: 'importPending', size: 10, sizeleft: 0 }])?.state, 'importing');
  assert.equal(queueView([{ status: 'warning', trackedDownloadStatus: 'warning' }])?.state, 'issue');
  assert.equal(queueView([{ status: 'paused', size: 10, sizeleft: 20 }])?.progress, null, 'inconsistent sizes give no percentage');
});

/* ---------- Request validation and payload ---------- */

test('add requests: strict validation with safe defaults (monitoring off, no search)', () => {
  assert.deepEqual(SAFE_DEFAULTS, { monitored: false, searchForMovie: false, minimumAvailability: 'released' });
  assert.ok(parseAddRequest(addBody()).ok);
  assert.equal(parseAddRequest(addBody({ rootFolderPath: '/etc' })).ok, false, 'paths are never accepted from the client');
  assert.equal(parseAddRequest(addBody({ url: 'https://evil.test' })).ok, false);
  assert.equal(parseAddRequest(addBody({ tmdbId: '603' })).ok, false);
  assert.equal(parseAddRequest(addBody({ tmdbId: -1 })).ok, false);
  assert.equal(parseAddRequest(addBody({ tmdbId: 1.5 })).ok, false);
  assert.equal(parseAddRequest(addBody({ rootFolderId: 0 })).ok, false);
  assert.equal(parseAddRequest(addBody({ qualityProfileId: null })).ok, false);
  assert.equal(parseAddRequest(addBody({ minimumAvailability: 'tba' })).ok, false);
  assert.equal(parseAddRequest(addBody({ monitored: 'yes' })).ok, false);
  assert.equal(parseAddRequest(addBody({ searchForMovie: true })).ok, false, 'search needs monitoring');
  assert.ok(parseAddRequest(addBody({ monitored: true, searchForMovie: true })).ok);
  assert.equal(parseAddRequest([]).ok, false);
  assert.equal(parseAddRequest(null).ok, false);
});

test('movie requests: strict validation; confirmed state is required', () => {
  assert.ok(parseMovieRequest({ tmdbId: 603, search: false, expected: { monitored: false, fileState: 'missing' } }).ok);
  assert.equal(parseMovieRequest({ tmdbId: 603, search: false }).ok, false);
  assert.equal(parseMovieRequest({ tmdbId: 603, search: 'yes', expected: { monitored: false, fileState: 'missing' } }).ok, false);
  assert.equal(parseMovieRequest({ tmdbId: 603, search: false, expected: { monitored: false, fileState: 'gone' } }).ok, false);
  assert.equal(parseMovieRequest({ tmdbId: 603, search: false, expected: { monitored: false, fileState: 'missing', x: 1 } }).ok, false);
  assert.equal(parseMovieRequest({ tmdbId: 603, search: false, expected: { monitored: false, fileState: 'missing' }, deleteFiles: true }).ok, false);
  assert.equal(parseMovieRequest({ tmdbId: 603, search: false, expected: { monitored: false, fileState: 'missing' }, movieIds: [1, 2] }).ok, false);
});

test('payload: Radarr\'s lookup record with only the confirmed options; search is never part of the add', () => {
  const payload = buildAddPayload({ ...MATRIX, id: 9, path: '/x', folderName: '/x', hasFile: true, movieFileId: 3 } as RadarrMovieResource, { rootFolderPath: '/movies', qualityProfileId: 4, minimumAvailability: 'released', monitored: false });
  assert.equal(payload.tmdbId, 603); assert.equal(payload.title, 'The Matrix');
  assert.equal(payload.monitored, false); assert.equal(payload.qualityProfileId, 4); assert.equal(payload.rootFolderPath, '/movies'); assert.equal(payload.minimumAvailability, 'released');
  assert.deepEqual(payload.addOptions, { monitor: 'none', searchForMovie: false });
  assert.deepEqual(payload.tags, []);
  for (const key of ['id', 'path', 'folderName', 'hasFile', 'movieFileId']) assert.ok(!(key in payload), `${key} must not be sent`);
  assert.deepEqual(buildAddPayload(MATRIX, { rootFolderPath: '/movies', qualityProfileId: 4, minimumAvailability: 'released', monitored: true }).addOptions, { monitor: 'movieOnly', searchForMovie: false });
});

test('posters and links: HTTPS posters only; links use the configured host and a validated slug', () => {
  assert.equal(posterOf(MATRIX), 'https://image.tmdb.org/t/p/original/matrix.jpg');
  assert.equal(posterOf({ images: [{ coverType: 'poster', remoteUrl: 'http://insecure.test/p.jpg' }] }), null);
  assert.equal(posterOf({ remotePoster: 'javascript:alert(1)' }), null);
  assert.equal(movieLink(FAKE_URL, { titleSlug: '603' }), `${FAKE_URL}/movie/603`);
  assert.equal(movieLink(FAKE_URL, { titleSlug: '../../admin' }), `${FAKE_URL}/`);
  assert.equal(movieLink(FAKE_URL, {}), `${FAKE_URL}/`);
  assert.ok(isAlreadyAddedRejection(['This movie has already been added']));
  assert.ok(!isAlreadyAddedRejection(['Root folder does not exist']));
});

test('request plan: on-disk movies are never monitored or searched; unreleased/queued/recent searches are blocked', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  assert.deepEqual(planRequest(inLibrary(), null, null, now), { monitored: false, fileState: 'missing', canMonitor: true, canSearch: true, searchBlock: null });
  const onDisk = planRequest(inLibrary({ hasFile: true }), null, null, now);
  assert.equal(onDisk.canMonitor, false); assert.equal(onDisk.canSearch, false); assert.equal(onDisk.searchBlock, 'on_disk');
  assert.equal(planRequest(inLibrary({ isAvailable: false }), null, null, now).searchBlock, 'unreleased');
  assert.equal(planRequest(inLibrary({ isAvailable: false }), null, null, now).canMonitor, true, 'an unreleased movie can be monitored');
  assert.equal(planRequest(inLibrary(), { state: 'downloading', progress: 10 }, null, now).searchBlock, 'queued');
  assert.equal(planRequest(inLibrary(), null, now - 60_000, now).searchBlock, 'recently_searched');
  assert.equal(planRequest(inLibrary(), null, now - SEARCH_COOLDOWN_MS - 1, now).canSearch, true);
  assert.equal(planRequest(inLibrary({ monitored: true }), null, null, now).canMonitor, false);
});

/* ---------- Status ---------- */

test('status: not configured, not allowed, not linked, unmatched', async () => {
  assert.deepEqual(await service({ fake: null }).svc.status(MOVIE_ID, OWNER), { state: 'not_configured' });
  const forbidden = service({ allowed: false });
  assert.deepEqual(await forbidden.svc.status(MOVIE_ID, OWNER), { state: 'forbidden' });
  assert.equal(forbidden.fake.calls.length, 0, 'no Radarr call for accounts that may not use it');
  assert.deepEqual(await service({ tmdbId: null }).svc.status(MOVIE_ID, OWNER), { state: 'no_tmdb_link' });
  const unknown = service({ tmdbId: 424242 });
  assert.deepEqual(await unknown.svc.status(MOVIE_ID, OWNER), { state: 'unmatched', reason: 'not_found' });
  const conflicting = service(); conflicting.fake.lookups[603] = REMAKE;
  assert.deepEqual(await conflicting.svc.status(MOVIE_ID, OWNER), { state: 'unmatched', reason: 'conflicting_ids' });
});

test('status: another user\'s movie is not found', async () => {
  const { svc, fake } = service();
  // Other accounts are refused before any movie or Radarr lookup.
  assert.deepEqual(await svc.status(MOVIE_ID, 'someone-else'), { state: 'forbidden' });
  assert.equal(fake.calls.length, 0);
  await rejects(service().svc.status('33333333-3333-4333-8333-333333333333', OWNER), 404, 'movie_not_found');
});

test('status: available vs already in Radarr (monitoring, file, queue), with caching', async () => {
  const { svc, fake } = service();
  const available = await svc.status(MOVIE_ID, OWNER);
  assert.equal(available.state, 'available');
  assert.deepEqual(available.state === 'available' && available.movie, { title: 'The Matrix', year: 1999, tmdbId: 603, posterUrl: 'https://image.tmdb.org/t/p/original/matrix.jpg', studio: 'Warner Bros. Pictures', runtime: 136 });
  const calls = fake.calls.length;
  await svc.status(MOVIE_ID, OWNER);
  assert.equal(fake.calls.length, calls, 'second status is served from the cache');
  assert.equal(fake.writes().length, 0, 'status never writes');

  const existing = service(); existing.fake.library.push(inLibrary({ monitored: true }));
  existing.fake.queue[77] = [{ status: 'downloading', size: 100, sizeleft: 40 }];
  const status = await existing.svc.status(MOVIE_ID, OWNER);
  assert.equal(status.state, 'exists');
  if (status.state === 'exists') {
    assert.equal(status.radarrUrl, `${FAKE_URL}/movie/603`);
    assert.deepEqual(status.radarr, { monitored: true, fileState: 'missing', queue: { state: 'downloading', progress: 60 }, canSearch: false });
  }
  assert.ok(!existing.fake.calls.some(call => call.startsWith('lookup')), 'existing movies need no metadata lookup');

  const onDisk = service(); onDisk.fake.library.push(inLibrary({ hasFile: true, monitored: true }));
  const disk = await onDisk.svc.status(MOVIE_ID, OWNER);
  assert.ok(disk.state === 'exists' && disk.radarr.fileState === 'on_disk' && disk.radarr.queue === null);
  assert.ok(!onDisk.fake.calls.some(call => call.startsWith('queue')), 'no queue call for a movie on disk');

  const searchable = service(); searchable.fake.library.push(inLibrary({ monitored: true }));
  const open = await searchable.svc.status(MOVIE_ID, OWNER);
  assert.ok(open.state === 'exists' && open.radarr.canSearch === true);
  const recent = service({ now: () => Date.parse('2026-11-19T12:00:00Z') }); recent.fake.library.push(inLibrary({ monitored: true, lastSearchTime: '2026-11-19T11:59:00Z' }));
  const blocked = await recent.svc.status(MOVIE_ID, OWNER);
  assert.ok(blocked.state === 'exists' && blocked.radarr.canSearch === false, 'a movie searched minutes ago is not offered a search');

  const unreleased = service(); unreleased.fake.library.push(inLibrary({ isAvailable: false, status: 'announced' }));
  const notOut = await unreleased.svc.status(MOVIE_ID, OWNER);
  assert.ok(notOut.state === 'exists' && notOut.radarr.fileState === 'unreleased');
});

test('status: Radarr failures are non-blocking states, never thrown; a queue failure hides only the queue', async () => {
  for (const code of ['unreachable', 'timeout', 'unauthorized', 'bad_response'] as const) {
    const { svc, fake } = service(); fake.failWith = new RadarrError(code);
    assert.deepEqual(await svc.status(MOVIE_ID, OWNER), { state: 'unavailable', reason: code });
  }
  const { svc, fake } = service(); fake.library.push(inLibrary());
  fake.queueForMovie = async () => { throw new RadarrError('timeout'); };
  const status = await svc.status(MOVIE_ID, OWNER);
  assert.ok(status.state === 'exists' && status.radarr.queue === null && status.radarr.fileState === 'missing');
});

test('options and connection: from Radarr, with safe defaults; owner only', async () => {
  const { svc } = service();
  const options = await svc.getOptions(OWNER);
  assert.deepEqual(options.rootFolders, [{ id: 1, path: '/movies', accessible: true, freeSpace: 1000 }, { id: 3, path: '/offline', accessible: false, freeSpace: null }]);
  assert.deepEqual(options.qualityProfiles, [{ id: 4, name: 'HD-1080p' }, { id: 1, name: 'Any' }]);
  assert.deepEqual(options.minimumAvailability, ['announced', 'inCinemas', 'released']);
  assert.deepEqual(options.defaults, { monitored: false, searchForMovie: false, minimumAvailability: 'released' });
  assert.deepEqual(await svc.connection(OWNER), { connected: true, version: '6.4.4.10685', rootFolders: 2, qualityProfiles: 2, radarrUrl: `${FAKE_URL}/` });
  await rejects(service({ allowed: false }).svc.getOptions(OWNER), 403, 'forbidden');
  await rejects(service({ allowed: false }).svc.connection(OWNER), 403, 'forbidden');
  await rejects(service({ fake: null }).svc.getOptions(OWNER), 503, 'not_configured');
  const down = service(); down.fake.failWith = new RadarrError('timeout');
  await rejects(down.svc.getOptions(OWNER), 504, 'timeout');
  down.fake.failWith = new RadarrError('unauthorized', 401);
  await rejects(down.svc.connection(OWNER), 502, 'unavailable');
});

/* ---------- Add ---------- */

test('add: safe defaults add the verified movie unmonitored and never search', async () => {
  const { svc, fake } = service();
  const result = await svc.add(MOVIE_ID, OWNER, parsed(addBody()));
  assert.equal(result.added, true); assert.equal(result.monitored, false); assert.equal(result.monitoringAsRequested, true); assert.equal(result.search, 'not_requested');
  assert.equal(result.status.state, 'exists');
  assert.equal(fake.posted.length, 1);
  const payload = fake.posted[0] as Record<string, any>;
  assert.equal(payload.tmdbId, 603); assert.equal(payload.monitored, false); assert.equal(payload.rootFolderPath, '/movies'); assert.equal(payload.qualityProfileId, 4);
  assert.deepEqual(payload.addOptions, { monitor: 'none', searchForMovie: false });
  assert.deepEqual(fake.writes(), ['add'], 'no monitoring call and no search');
  assert.deepEqual(result.options, { rootFolder: '/movies', qualityProfile: 'HD-1080p', minimumAvailability: 'released' });
});

test('add: confirmed monitoring and search — the search starts only after Radarr reports the movie monitored and missing', async () => {
  const { svc, fake } = service();
  const result = await svc.add(MOVIE_ID, OWNER, parsed(addBody({ monitored: true, searchForMovie: true })));
  assert.equal(result.monitored, true); assert.equal(result.search, 'started');
  assert.deepEqual(fake.writes(), ['add', 'search']);
  assert.deepEqual(fake.searched, [[100]]);
  assert.deepEqual((fake.posted[0] as Record<string, any>).addOptions, { monitor: 'movieOnly', searchForMovie: false });

  const unreleased = service(); unreleased.fake.lookups[603] = { ...MATRIX, isAvailable: false, status: 'announced' };
  assert.equal((await unreleased.svc.add(MOVIE_ID, OWNER, parsed(addBody({ monitored: true, searchForMovie: true })))).search, 'not_available');
  assert.deepEqual(unreleased.fake.writes(), ['add'], 'no search for an unreleased movie');

  const refused = service(); refused.fake.searchFailWith = new RadarrError('unreachable');
  const partial = await refused.svc.add(MOVIE_ID, OWNER, parsed(addBody({ monitored: true, searchForMovie: true })));
  assert.equal(partial.added, true); assert.equal(partial.search, 'failed', 'a failed search is reported, the addition is still confirmed');

  // Radarr not storing the requested monitoring is reported honestly and blocks the search.
  const ignored = service(); ignored.fake.addMovie = async payload => { ignored.fake.calls.push('add'); const created = { ...(payload as RadarrMovieResource), id: 120, monitored: false, hasFile: false }; ignored.fake.library.push(created); return created; };
  const mismatch = await ignored.svc.add(MOVIE_ID, OWNER, parsed(addBody({ monitored: true, searchForMovie: true })));
  assert.equal(mismatch.monitoringAsRequested, false); assert.equal(mismatch.search, 'not_monitored');
  assert.deepEqual(ignored.fake.writes(), ['add']);
});

test('add: duplicates are refused without a write and return the current status', async () => {
  const { svc, fake } = service(); fake.library.push(inLibrary({ monitored: true, hasFile: true }));
  const error = await rejects(svc.add(MOVIE_ID, OWNER, parsed(addBody())), 409, 'already_exists') as RadarrRequestError;
  assert.equal((error.detail?.status as { state: string }).state, 'exists');
  assert.equal(fake.posted.length, 0);

  // Radarr itself reporting a duplicate (race with Radarr's UI) also reloads the status instead of adding again.
  const race = service();
  race.fake.addMovie = async () => { race.fake.calls.push('add'); race.fake.library.push(inLibrary()); throw new RadarrError('rejected', 400, ['This movie has already been added']); };
  const raced = await rejects(race.svc.add(MOVIE_ID, OWNER, parsed(addBody())), 409, 'already_exists') as RadarrRequestError;
  assert.equal((raced.detail?.status as { state: string }).state, 'exists');
});

test('add: concurrent and repeated submissions add the movie once', async () => {
  const { svc, fake } = service(); fake.addDelay = 30;
  const results = await Promise.allSettled([svc.add(MOVIE_ID, OWNER, parsed(addBody())), svc.add(MOVIE_ID, OWNER, parsed(addBody())), svc.add(MOVIE_ID, OWNER, parsed(addBody()))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of results) if (result.status === 'rejected') assert.equal((result.reason as RadarrRequestError).code, 'in_progress');
  await rejects(svc.add(MOVIE_ID, OWNER, parsed(addBody())), 409, 'already_exists');
  assert.equal(fake.posted.length, 1);
});

test('add: identity, root folder and quality profile are re-validated server-side', async () => {
  await rejects(service().svc.add(MOVIE_ID, OWNER, parsed(addBody({ tmdbId: 604 }))), 409, 'identity_changed');
  await rejects(service({ tmdbId: null }).svc.add(MOVIE_ID, OWNER, parsed(addBody())), 409, 'no_tmdb_link');
  await rejects(service().svc.add(MOVIE_ID, OWNER, parsed(addBody({ rootFolderId: 3 }))), 400, 'invalid_root_folder');
  await rejects(service().svc.add(MOVIE_ID, OWNER, parsed(addBody({ rootFolderId: 99 }))), 400, 'invalid_root_folder');
  await rejects(service().svc.add(MOVIE_ID, OWNER, parsed(addBody({ qualityProfileId: 99 }))), 400, 'invalid_quality_profile');
  const conflicting = service(); conflicting.fake.lookups[603] = REMAKE;
  await rejects(conflicting.svc.add(MOVIE_ID, OWNER, parsed(addBody())), 422, 'unmatched');
  assert.equal(conflicting.fake.posted.length, 0);
  await rejects(service().svc.add(MOVIE_ID, 'someone-else', parsed(addBody())), 403, 'forbidden');
  await rejects(service({ fake: null }).svc.add(MOVIE_ID, OWNER, parsed(addBody())), 503, 'not_configured');
});

test('add: failures are reported clearly; a timeout is "uncertain"; the lock is released', async () => {
  const timeout = service(); timeout.fake.addFailWith = new RadarrError('timeout');
  await rejects(timeout.svc.add(MOVIE_ID, OWNER, parsed(addBody())), 504, 'uncertain');
  const rejected = service(); rejected.fake.addFailWith = new RadarrError('rejected', 400, ['Path is invalid']);
  await rejects(rejected.svc.add(MOVIE_ID, OWNER, parsed(addBody())), 422, 'rejected');
  const down = service(); down.fake.addFailWith = new RadarrError('unreachable', 503);
  await rejects(down.svc.add(MOVIE_ID, OWNER, parsed(addBody())), 502, 'unavailable');
  down.fake.addFailWith = null;
  assert.equal((await down.svc.add(MOVIE_ID, OWNER, parsed(addBody()))).added, true);
  // An unusable answer is verified against Radarr's library before success is reported.
  const odd = service(); odd.fake.addMovie = async () => { odd.fake.calls.push('add'); return {} as RadarrMovieResource; };
  await rejects(odd.svc.add(MOVIE_ID, OWNER, parsed(addBody())), 502, 'unverified');
  const late = service(); late.fake.addMovie = async payload => { late.fake.calls.push('add'); late.fake.library.push({ ...(payload as RadarrMovieResource), id: 300, hasFile: false }); return {} as RadarrMovieResource; };
  assert.equal((await late.svc.add(MOVIE_ID, OWNER, parsed(addBody()))).added, true);
});

/* ---------- Request Movie ---------- */

test('detail: fresh, read-only state for the request dialog', async () => {
  const { svc, fake } = service(); fake.library.push(inLibrary());
  const view = await svc.detail(MOVIE_ID, OWNER);
  assert.equal(view.monitored, false); assert.equal(view.fileState, 'missing'); assert.equal(view.canMonitor, true); assert.equal(view.canSearch, true); assert.equal(view.queue, null);
  assert.equal(view.radarrUrl, `${FAKE_URL}/movie/603`);
  assert.equal(fake.writes().length, 0, 'reading never monitors or searches');
  await rejects(service().svc.detail(MOVIE_ID, OWNER), 409, 'not_in_radarr');
});

test('request: monitoring only by default — no search', async () => {
  const { svc, fake } = service(); fake.library.push(inLibrary());
  const result = await svc.requestMovie(MOVIE_ID, OWNER, req());
  assert.equal(result.monitoringEnabled, true); assert.equal(result.searched, false);
  assert.deepEqual(fake.monitored, [[77]]); assert.deepEqual(fake.searched, []);
  assert.equal(result.view.monitored, true);
  assert.ok(fake.calls.indexOf('movie:77') > fake.calls.indexOf('monitor'), 'Radarr is re-read after the change');
});

test('request: explicit search runs after monitoring is verified; repeated searches are refused', async () => {
  let now = Date.parse('2026-11-19T12:00:00Z');
  const { svc, fake } = service({ now: () => now }); fake.library.push(inLibrary());
  const result = await svc.requestMovie(MOVIE_ID, OWNER, req({ search: true }));
  assert.equal(result.searched, true);
  assert.deepEqual(fake.writes(), ['monitor', 'search']);
  assert.equal(result.view.canSearch, false); assert.equal(result.view.searchBlock, 'recently_searched');
  await rejects(svc.requestMovie(MOVIE_ID, OWNER, req({ search: true, expected: { monitored: true, fileState: 'missing' } })), 429, 'recently_searched');
  assert.equal(fake.searched.length, 1, 'no second search');
  now += SEARCH_COOLDOWN_MS + 1;
  assert.equal((await svc.requestMovie(MOVIE_ID, OWNER, req({ search: true, expected: { monitored: true, fileState: 'missing' } }))).searched, true);
  assert.deepEqual(fake.writes(), ['monitor', 'search', 'search'], 'an already monitored movie is not re-monitored');

  // Radarr's own lastSearchTime counts too.
  const recent = service({ now: () => Date.parse('2026-11-19T12:00:00Z') }); recent.fake.library.push(inLibrary({ monitored: true, lastSearchTime: '2026-11-19T11:58:00Z' }));
  await rejects(recent.svc.requestMovie(MOVIE_ID, OWNER, req({ search: true, expected: { monitored: true, fileState: 'missing' } })), 429, 'recently_searched');
  assert.equal(recent.fake.writes().length, 0);
});

test('request: a movie on disk is never monitored, searched, replaced or re-downloaded', async () => {
  const { svc, fake } = service(); fake.library.push(inLibrary({ hasFile: true }));
  await rejects(svc.requestMovie(MOVIE_ID, OWNER, req({ expected: { monitored: false, fileState: 'on_disk' } })), 409, 'on_disk');
  await rejects(svc.requestMovie(MOVIE_ID, OWNER, req({ search: true, expected: { monitored: false, fileState: 'on_disk' } })), 409, 'on_disk');
  const view = await svc.detail(MOVIE_ID, OWNER);
  assert.equal(view.canMonitor, false); assert.equal(view.canSearch, false);
  assert.equal(fake.writes().length, 0);
});

test('request: unreleased movies can be monitored but not searched; queued movies are not searched again', async () => {
  const { svc, fake } = service(); fake.library.push(inLibrary({ isAvailable: false }));
  await rejects(svc.requestMovie(MOVIE_ID, OWNER, req({ search: true, expected: { monitored: false, fileState: 'unreleased' } })), 409, 'search_unavailable');
  assert.equal(fake.writes().length, 0, 'a refused search changes nothing, not even monitoring');
  assert.equal((await svc.requestMovie(MOVIE_ID, OWNER, req({ expected: { monitored: false, fileState: 'unreleased' } }))).monitoringEnabled, true);
  const queued = service(); queued.fake.library.push(inLibrary({ monitored: true })); queued.fake.queue[77] = [{ status: 'downloading', size: 10, sizeleft: 5 }];
  await rejects(queued.svc.requestMovie(MOVIE_ID, OWNER, req({ search: true, expected: { monitored: true, fileState: 'missing' } })), 409, 'search_unavailable');
  await rejects(queued.svc.requestMovie(MOVIE_ID, OWNER, req({ expected: { monitored: true, fileState: 'missing' } })), 422, 'nothing_to_do');
  assert.equal(queued.fake.writes().length, 0);
});

test('request: a changed Radarr state refuses the confirmation without writing', async () => {
  const { svc, fake } = service(); fake.library.push(inLibrary({ monitored: true }));
  await rejects(svc.requestMovie(MOVIE_ID, OWNER, req()), 409, 'state_changed');
  const file = service(); file.fake.library.push(inLibrary({ hasFile: true }));
  await rejects(file.svc.requestMovie(MOVIE_ID, OWNER, req()), 409, 'state_changed');
  await rejects(service().svc.requestMovie(MOVIE_ID, OWNER, req()), 409, 'not_in_radarr');
  await rejects(service().svc.requestMovie(MOVIE_ID, OWNER, req({ tmdbId: 604 })), 409, 'identity_changed');
  assert.equal(fake.writes().length + file.fake.writes().length, 0);
});

test('request: partial failures are honest and never search unverified monitoring', async () => {
  const timeout = service(); timeout.fake.library.push(inLibrary()); timeout.fake.monitorFailWith = new RadarrError('timeout');
  await rejects(timeout.svc.requestMovie(MOVIE_ID, OWNER, req({ search: true })), 504, 'uncertain');
  assert.deepEqual(timeout.fake.searched, []);
  const refused = service(); refused.fake.library.push(inLibrary()); refused.fake.monitorFailWith = new RadarrError('rejected', 400);
  await rejects(refused.svc.requestMovie(MOVIE_ID, OWNER, req({ search: true })), 502, 'not_applied');
  const ignored = service(); ignored.fake.library.push(inLibrary()); ignored.fake.ignoreMonitor = true;
  const unverified = await rejects(ignored.svc.requestMovie(MOVIE_ID, OWNER, req({ search: true })), 502, 'unverified') as RadarrRequestError;
  assert.deepEqual(unverified.detail?.applied, { monitored: true, search: false });
  assert.deepEqual(ignored.fake.searched, []);
  const unreadable = service(); unreadable.fake.library.push(inLibrary()); unreadable.fake.readFailWith = new RadarrError('unreachable');
  await rejects(unreadable.svc.requestMovie(MOVIE_ID, OWNER, req({ search: true })), 502, 'unverified');
  assert.deepEqual(unreadable.fake.searched, []);
  const search = service(); search.fake.library.push(inLibrary()); search.fake.searchFailWith = new RadarrError('unreachable');
  const failed = await rejects(search.svc.requestMovie(MOVIE_ID, OWNER, req({ search: true })), 502, 'search_failed') as RadarrRequestError;
  assert.deepEqual(failed.detail?.applied, { monitored: true, search: false });
  search.fake.searchFailWith = new RadarrError('timeout');
  await rejects(search.svc.requestMovie(MOVIE_ID, OWNER, req({ search: true, expected: { monitored: true, fileState: 'missing' } })), 504, 'search_failed');
  // After failures the lock is released.
  search.fake.searchFailWith = null;
  assert.equal((await search.svc.requestMovie(MOVIE_ID, OWNER, req({ search: true, expected: { monitored: true, fileState: 'missing' } }))).searched, true);
});

test('request: concurrent confirmations change Radarr once', async () => {
  const { svc, fake } = service(); fake.library.push(inLibrary());
  const slow = fake.monitorMovies.bind(fake);
  fake.monitorMovies = async ids => { await new Promise(resolve => setTimeout(resolve, 30)); return slow(ids); };
  const results = await Promise.allSettled([svc.requestMovie(MOVIE_ID, OWNER, req({ search: true })), svc.requestMovie(MOVIE_ID, OWNER, req({ search: true }))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(fake.monitored.length, 1); assert.equal(fake.searched.length, 1);
});

/* ---------- Client: headers, redirects and secret handling ---------- */

function clientWith(adapter: AxiosAdapter) {
  const config = readRadarrConfig({ RADARR_URL: FAKE_URL, RADARR_API_KEY: FAKE_KEY }).config!;
  const client = new RadarrClient(config);
  (client as unknown as { http: { defaults: { adapter: AxiosAdapter } } }).http.defaults.adapter = adapter;
  return client;
}
function assertNoSecret(value: unknown) {
  const renderings = [util.inspect(value, { depth: Infinity, showHidden: true }), util.format('%o', value), JSON.stringify(value), String(value), (value as Error)?.stack || ''];
  for (const text of renderings) assert.ok(!text.includes(FAKE_KEY), 'API key leaked');
}

test('client: key as a header to the configured host only, no redirects, exact write bodies', async () => {
  const seen: InternalAxiosRequestConfig[] = [];
  const client = clientWith(async config => { seen.push(config); return { data: config.method === 'post' && config.url === '/command' ? { id: 5 } : [{ id: 1, path: '/movies' }], status: 200, statusText: 'OK', headers: {}, config }; });
  assert.deepEqual(await client.rootFolders(), [{ id: 1, path: '/movies' }]);
  const request = seen[0];
  assert.equal(request.baseURL, `${FAKE_URL}/api/v3`);
  assert.equal(request.headers['X-Api-Key'], FAKE_KEY);
  assert.equal(request.maxRedirects, 0);
  assert.ok(!String(request.url).includes(FAKE_KEY) && !JSON.stringify(request.params || {}).includes(FAKE_KEY), 'key never in the URL');
  await client.lookupTmdb(603);
  assert.deepEqual([seen[1].url, seen[1].params], ['/movie/lookup/tmdb', { tmdbId: 603 }]);
  await client.moviesByTmdbId(603);
  assert.deepEqual([seen[2].method, seen[2].url, seen[2].params], ['get', '/movie', { tmdbId: 603 }]);
  await client.monitorMovies([77]);
  assert.equal(seen[3].method, 'put'); assert.equal(seen[3].url, '/movie/editor');
  assert.deepEqual(JSON.parse(seen[3].data), { movieIds: [77], monitored: true }, 'monitoring sends only the IDs and monitored: true');
  await client.searchMovies([77]);
  assert.deepEqual(JSON.parse(seen[4].data), { name: 'MoviesSearch', movieIds: [77] });
  await client.queueForMovie(77);
  assert.deepEqual([seen[5].url, seen[5].params], ['/queue/details', { movieId: 77 }]);
  for (const bad of [-5, 0, 1.5, Number.NaN]) {
    await assert.rejects(client.lookupTmdb(bad), (error: unknown) => error instanceof RadarrError);
    await assert.rejects(client.monitorMovies([bad]), (error: unknown) => error instanceof RadarrError);
    await assert.rejects(client.searchMovies([bad]), (error: unknown) => error instanceof RadarrError);
  }
  assert.equal(seen.length, 6, 'invalid IDs never reach Radarr');
  assert.ok(!seen.some(config => config.method === 'delete'), 'no delete call exists');
});

test('client: errors are sanitized and classified', async () => {
  const fail = (status: number | null, data: unknown = 'Internal error with X-Api-Key: ' + FAKE_KEY, code?: string): AxiosAdapter => async config => {
    if (status === null) throw new AxiosError('timeout of 10000ms exceeded', code || 'ECONNABORTED', config);
    throw new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, null, { data, status, statusText: 'x', headers: {}, config });
  };
  const cases: Array<[AxiosAdapter, string]> = [
    [fail(null), 'timeout'], [fail(null, undefined, 'ECONNREFUSED'), 'unreachable'], [fail(401), 'unauthorized'], [fail(403), 'unauthorized'],
    [fail(404), 'not_found'], [fail(500), 'unreachable'], [fail(302), 'bad_response'],
    [fail(400, [{ propertyName: 'TmdbId', errorMessage: 'This movie has already been added' }]), 'rejected'],
  ];
  for (const [adapter, code] of cases) {
    const error = await clientWith(adapter).systemStatus().then(() => null, (caught: unknown) => caught);
    assert.ok(error instanceof RadarrError, `expected RadarrError for ${code}`);
    assert.equal(error.code, code);
    assertNoSecret(error);
    assert.equal((error as unknown as { config?: unknown }).config, undefined);
    assert.equal((error as unknown as { cause?: unknown }).cause, undefined);
  }
  const html = clientWith(async config => ({ data: '<html>login</html>', status: 200, statusText: 'OK', headers: {}, config }));
  await assert.rejects(html.systemStatus(), (error: unknown) => error instanceof RadarrError && error.code === 'bad_response');
});

test('health check: counts only, never paths, names, version or the key', async () => {
  const fake = new FakeRadarr();
  const ok = await checkRadarrConnection(fake as unknown as RadarrClient, null);
  assert.deepEqual({ ...ok, checkedAt: null }, { configured: true, configError: null, connected: true, checkedAt: null, rootFolders: 2, qualityProfiles: 2, error: null });
  assert.ok(!JSON.stringify(ok).includes('/movies') && !JSON.stringify(ok).includes('HD-1080p') && !JSON.stringify(ok).includes('6.4'));
  fake.failWith = new RadarrError('unauthorized', 401);
  const failed = await checkRadarrConnection(fake as unknown as RadarrClient, null);
  assert.equal(failed.connected, false); assert.equal(failed.error, 'unauthorized');
  const missing = await checkRadarrConnection(null, 'missing');
  assert.equal(missing.configured, false); assert.equal(missing.connected, null);
  assert.equal(fake.writes().length, 0);
});

/* ---------- HTTP routes: authentication, validation and secret handling ---------- */

test('routes: authentication required, owner only, JSON-only writes, strict bodies, no secrets in responses', async () => {
  process.env.RADARR_URL = FAKE_URL; process.env.RADARR_API_KEY = FAKE_KEY;
  const express = (await import('express')).default;
  const { protectedRoute } = await import('../src/middlewares/protectedRoute');
  const { createRadarrRouter } = await import('../src/api/v1/radarr');
  const { securityModule } = await import('../src/modules/security');
  const { svc, fake } = service();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/radarr', protectedRoute, createRadarrRouter(svc));
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/radarr`;
  const owner = `Bearer ${await securityModule.Commands.GenerateTokenCommand.execute(OWNER)}`;
  const other = `Bearer ${await securityModule.Commands.GenerateTokenCommand.execute('someone-else')}`;
  const call = async (path: string, init: { method?: string; auth?: string; body?: string; type?: string } = {}) => {
    const response = await fetch(base + path, { method: init.method || 'GET', headers: { ...(init.auth ? { Authorization: init.auth } : {}), ...(init.type ? { 'Content-Type': init.type } : {}) }, body: init.body });
    const text = await response.text();
    assert.ok(!text.includes(FAKE_KEY), 'API key leaked in a response');
    let body: any = text; try { body = text ? JSON.parse(text) : null; } catch { /* plain text (e.g. 401) */ }
    return { status: response.status, body, cache: response.headers.get('cache-control') };
  };
  const json = (method: string, path: string, auth: string, body: unknown) => call(path, { method, auth, body: JSON.stringify(body), type: 'application/json' });
  const requestBody = (overrides: Record<string, unknown> = {}) => ({ tmdbId: 603, search: false, expected: { monitored: false, fileState: 'missing' }, ...overrides });
  try {
    for (const path of ['/status', '/options', `/movies/${MOVIE_ID}`, `/movies/${MOVIE_ID}/request`]) {
      assert.equal((await call(path)).status, 401, path);
      assert.equal((await call(path, { auth: 'Bearer not-a-token' })).status, 401, path);
    }
    assert.equal((await call(`/movies/${MOVIE_ID}`, { method: 'POST', body: JSON.stringify(addBody()), type: 'application/json' })).status, 401);
    assert.equal((await call(`/movies/${MOVIE_ID}/request`, { method: 'POST', body: JSON.stringify(requestBody()), type: 'application/json' })).status, 401);
    assert.equal(fake.calls.length, 0, 'no Radarr call before authentication');

    assert.deepEqual((await call(`/movies/${MOVIE_ID}`, { auth: other })).body, { state: 'forbidden' });
    assert.equal((await call('/options', { auth: other })).status, 403);
    assert.equal((await call('/status', { auth: other })).status, 403);
    assert.equal((await call(`/movies/${MOVIE_ID}/request`, { auth: other })).status, 403);
    assert.equal((await json('POST', `/movies/${MOVIE_ID}`, other, addBody())).status, 403);
    assert.equal((await json('POST', `/movies/${MOVIE_ID}/request`, other, requestBody())).status, 403);
    assert.equal(fake.calls.length, 0, 'no Radarr call for other accounts');

    const status = await call(`/movies/${MOVIE_ID}`, { auth: owner });
    assert.equal(status.status, 200); assert.equal(status.body.state, 'available'); assert.equal(status.cache, 'no-store');
    assert.equal((await call('/movies/not-a-uuid', { auth: owner })).status, 404);
    assert.equal((await call('/movies/..%2Fsystem', { auth: owner })).status, 404);
    assert.equal((await call('/options', { auth: owner })).body.rootFolders[0].path, '/movies');
    assert.equal((await call('/status', { auth: owner })).body.version, '6.4.4.10685');
    // No generic proxy: any other path is not served.
    assert.equal((await call('/api/v3/movie', { auth: owner })).status, 404);
    assert.equal((await call(`/movies/${MOVIE_ID}`, { method: 'DELETE', auth: owner })).status, 404);

    // Cross-site form posts cannot send JSON: refused before any work.
    assert.equal((await call(`/movies/${MOVIE_ID}`, { method: 'POST', auth: owner, body: 'tmdbId=603', type: 'application/x-www-form-urlencoded' })).status, 415);
    assert.equal((await call(`/movies/${MOVIE_ID}/request`, { method: 'POST', auth: owner, body: 'tmdbId=603', type: 'text/plain' })).status, 415);
    assert.equal((await json('POST', `/movies/${MOVIE_ID}`, owner, addBody({ rootFolderPath: '/etc' }))).status, 400);
    assert.equal((await json('POST', `/movies/${MOVIE_ID}`, owner, addBody({ searchForMovie: true }))).status, 400);
    assert.equal((await json('POST', `/movies/${MOVIE_ID}/request`, owner, requestBody({ deleteFiles: true }))).status, 400);
    assert.equal(fake.writes().length, 0);

    const added = await json('POST', `/movies/${MOVIE_ID}`, owner, addBody());
    assert.equal(added.status, 201); assert.equal(added.body.added, true); assert.equal(added.body.status.state, 'exists'); assert.equal(added.body.monitored, false);
    const duplicate = await json('POST', `/movies/${MOVIE_ID}`, owner, addBody());
    assert.equal(duplicate.status, 409); assert.equal(duplicate.body.code, 'already_exists'); assert.equal(duplicate.body.status.state, 'exists');
    assert.equal(fake.posted.length, 1);

    const detail = await call(`/movies/${MOVIE_ID}/request`, { auth: owner });
    assert.equal(detail.status, 200); assert.equal(detail.body.monitored, false); assert.equal(detail.body.fileState, 'missing');
    const requested = await json('POST', `/movies/${MOVIE_ID}/request`, owner, requestBody());
    assert.equal(requested.status, 200); assert.equal(requested.body.monitoringEnabled, true); assert.equal(requested.body.searched, false);
    assert.deepEqual(fake.writes(), ['add', 'monitor']);
  } finally {
    await new Promise(resolve => server.close(resolve));
    delete process.env.RADARR_URL; delete process.env.RADARR_API_KEY;
  }
});

/* ---------- Separation from Cinetra viewing data and from Sonarr ---------- */

test('source: no Radarr secret or host is hardcoded; Radarr code never writes Cinetra data', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const roots = [path.join(__dirname, '..', 'src'), path.join(__dirname, '..', '..', 'frontend', 'src')];
  const walk = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]) : [];
  for (const file of roots.flatMap(walk)) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!/radarr\.aniskh\.com/i.test(text), `${file} hardcodes the Radarr host`);
    assert.ok(!/RADARR_API_KEY\s*[:=]\s*['"][A-Za-z0-9]{16,}/.test(text), `${file} hardcodes a Radarr key`);
    if (file.includes(`${path.sep}frontend${path.sep}`)) assert.ok(!/RADARR_API_KEY|X-Api-Key/i.test(text), `${file} references the Radarr key`);
  }
  const radarrFiles = [path.join(__dirname, '..', 'src', 'api', 'v1', 'radarr.ts'), ...walk(path.join(__dirname, '..', 'src', 'services', 'radarr'))];
  for (const file of radarrFiles) {
    const text = fs.readFileSync(file, 'utf8');
    // Only read queries (findFirst) of users and movies; never a write, never watch history, notes, ratings or shows.
    assert.ok(!/prisma\.\w+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|\$executeRaw|\$queryRaw|\$transaction/.test(text), `${file} writes data`);
    assert.deepEqual([...text.matchAll(/prisma\.(\w+)\.(\w+)/g)].map(match => `${match[1]}.${match[2]}`).sort(), file.endsWith('radarr.ts') && file.includes('api') ? ['movie.findFirst', 'user.findFirst'] : [], `${file}: only read queries`);
    assert.ok(!/movieWatch|episode|prisma\.show|rating|favorite|notes/i.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), `${file} touches viewing data`);
    assert.ok(!/sonarr/i.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), `${file} depends on Sonarr code`);
  }
  // The add payload never sends deletion or file-move options.
  const client = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'radarr', 'radarr-client.ts'), 'utf8');
  assert.ok(!/http\.delete|deleteFiles|moveFiles|addImportExclusion/.test(client.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').replace(/^\s*\*.*$/gm, '')));
});

(async () => {
  let failed = 0;
  for (const [name, run] of tests) {
    try { await run(); console.log(`ok - ${name}`); }
    catch (error) { failed++; console.error(`not ok - ${name}`); console.error(error); }
  }
  console.log(`${tests.length - failed}/${tests.length} Radarr tests passed`);
  process.exit(failed ? 1 : 0);
})();
