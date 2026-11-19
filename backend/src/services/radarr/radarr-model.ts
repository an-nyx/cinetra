import type { RadarrMovieResource, RadarrQualityProfile, RadarrQueueItem, RadarrRootFolder } from './radarr-client';

/**
 * Rules for sending a Cinetra movie to Radarr. Radarr identifies movies by TMDB ID, the same canonical ID Cinetra stores,
 * so matching is an exact ID comparison: titles, years and descriptions are never used. Anything else is rejected.
 */
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;

export type MatchRejection = 'not_found' | 'conflicting_ids';
export type RadarrMatch = { ok: true; movie: RadarrMovieResource } | { ok: false; reason: MatchRejection };

/** Radarr's lookup record must carry exactly the Cinetra movie's TMDB ID. */
export function checkLookup(tmdbId: number, record: RadarrMovieResource | null | undefined): RadarrMatch {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { ok: false, reason: 'not_found' };
  if (!positive(record.tmdbId)) return { ok: false, reason: 'not_found' };
  if (record.tmdbId !== tmdbId) return { ok: false, reason: 'conflicting_ids' };
  return { ok: true, movie: record };
}

/** The Radarr library entry for this TMDB ID, if any (Radarr's own identifier and a library ID; never the title). */
export function findExisting(movies: RadarrMovieResource[] | null | undefined, tmdbId: number) {
  if (!Array.isArray(movies)) return null;
  return movies.find(item => item && item.tmdbId === tmdbId && positive(item.id)) || null;
}

/* ---------- State, exactly as Radarr reports it ---------- */

/** on_disk: Radarr has a file. missing: no file and Radarr considers it available. unreleased: no file, not available yet. */
export type FileState = 'on_disk' | 'missing' | 'unreleased' | 'unknown';
export function fileState(movie: RadarrMovieResource): FileState {
  if (movie.hasFile === true) return 'on_disk';
  if (movie.hasFile !== false) return 'unknown';
  if (movie.isAvailable === true) return 'missing';
  if (movie.isAvailable === false) return 'unreleased';
  return 'unknown';
}

export type QueueState = 'downloading' | 'queued' | 'paused' | 'importing' | 'issue';
export type QueueView = { state: QueueState; progress: number | null } | null;
/** Radarr's own queue entry for the movie (first record), if any. Progress only when Radarr reports both sizes. */
export function queueView(items: RadarrQueueItem[] | null | undefined): QueueView {
  const item = Array.isArray(items) ? items.find(entry => entry && typeof entry === 'object') : null;
  if (!item) return null;
  const status = String(item.status || '').toLowerCase();
  const tracked = String(item.trackedDownloadState || '').toLowerCase();
  const trackedStatus = String(item.trackedDownloadStatus || '').toLowerCase();
  let state: QueueState;
  if (status === 'failed' || status === 'warning' || tracked === 'failed' || tracked === 'failedpending' || trackedStatus === 'error' || trackedStatus === 'warning' || status === 'downloadclientunavailable') state = 'issue';
  else if (tracked === 'importpending' || tracked === 'importing' || tracked === 'imported' || status === 'completed') state = 'importing';
  else if (status === 'paused') state = 'paused';
  else if (status === 'downloading') state = 'downloading';
  else state = 'queued';
  const size = typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : 0;
  const left = typeof item.sizeleft === 'number' && Number.isFinite(item.sizeleft) ? item.sizeleft : null;
  const progress = size > 0 && left !== null && left >= 0 && left <= size ? Math.floor(((size - left) / size) * 100) : null;
  return { state, progress };
}

/* ---------- Add requests ---------- */

/** Radarr's minimum availability values a user may choose (Radarr's own enum, minus the legacy "tba"/"deleted"). */
export const MINIMUM_AVAILABILITY = ['announced', 'inCinemas', 'released'] as const;
export type MinimumAvailability = typeof MINIMUM_AVAILABILITY[number];
export const SAFE_DEFAULTS = { monitored: false, searchForMovie: false, minimumAvailability: 'released' as MinimumAvailability };

export type AddRequest = { tmdbId: number; rootFolderId: number; qualityProfileId: number; minimumAvailability: MinimumAvailability; monitored: boolean; searchForMovie: boolean };

const only = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const isObject = (body: unknown): body is Record<string, unknown> => !!body && typeof body === 'object' && !Array.isArray(body);

/** Strict shape check of the client's request. Unknown fields (e.g. a path or URL) are rejected, not ignored. */
export function parseAddRequest(body: unknown): { ok: true; value: AddRequest } | { ok: false; message: string } {
  if (!isObject(body)) return { ok: false, message: 'Invalid request.' };
  if (!only(body, ['tmdbId', 'rootFolderId', 'qualityProfileId', 'minimumAvailability', 'monitored', 'searchForMovie'])) return { ok: false, message: 'Unexpected field in request.' };
  const { tmdbId, rootFolderId, qualityProfileId, minimumAvailability, monitored, searchForMovie } = body;
  if (!positive(tmdbId)) return { ok: false, message: 'Missing confirmed movie.' };
  if (!positive(rootFolderId)) return { ok: false, message: 'Choose a root folder.' };
  if (!positive(qualityProfileId)) return { ok: false, message: 'Choose a quality profile.' };
  if (typeof minimumAvailability !== 'string' || !(MINIMUM_AVAILABILITY as readonly string[]).includes(minimumAvailability)) return { ok: false, message: 'Choose a supported minimum availability.' };
  if (typeof monitored !== 'boolean') return { ok: false, message: 'Choose whether the movie is monitored.' };
  if (typeof searchForMovie !== 'boolean') return { ok: false, message: 'Choose whether to search for the movie.' };
  // A search only makes sense for a monitored movie; refusing it keeps "Add" from ever downloading something unmonitored.
  if (searchForMovie && !monitored) return { ok: false, message: 'Searching needs a monitored movie.' };
  return { ok: true, value: { tmdbId, rootFolderId, qualityProfileId, minimumAvailability: minimumAvailability as MinimumAvailability, monitored, searchForMovie } };
}

export function chooseRootFolder(folders: RadarrRootFolder[], id: number) {
  const folder = (folders || []).find(item => item && item.id === id && typeof item.path === 'string' && item.path.length > 0);
  return folder && folder.accessible !== false ? folder : null;
}
export function chooseQualityProfile(profiles: RadarrQualityProfile[], id: number) {
  return (profiles || []).find(item => item && item.id === id) || null;
}

/**
 * The POST /api/v3/movie body: Radarr's own lookup record for the verified TMDB ID, with only the selected options
 * applied. The root folder path comes from Radarr's root folder list, never from the client. The search is never part
 * of the add (`searchForMovie: false`): Cinetra starts it separately, only after Radarr confirms the movie is monitored.
 */
export function buildAddPayload(movie: RadarrMovieResource, options: { rootFolderPath: string; qualityProfileId: number; minimumAvailability: MinimumAvailability; monitored: boolean }) {
  const { id: _id, path: _path, folderName: _folder, statistics: _statistics, added: _added, movieFile: _file, movieFileId: _fileId, hasFile: _hasFile, ...lookup } = movie as RadarrMovieResource & Record<string, unknown>;
  return {
    ...lookup,
    qualityProfileId: options.qualityProfileId,
    rootFolderPath: options.rootFolderPath,
    minimumAvailability: options.minimumAvailability,
    monitored: options.monitored,
    tags: [],
    addOptions: { monitor: options.monitored ? 'movieOnly' : 'none', searchForMovie: false },
  };
}

/* ---------- Request (monitor / search) for a movie already in Radarr ---------- */

export type MovieRequest = { tmdbId: number; search: boolean; expected: { monitored: boolean; fileState: FileState } };
const FILE_STATES: FileState[] = ['on_disk', 'missing', 'unreleased', 'unknown'];

export function parseMovieRequest(body: unknown): { ok: true; value: MovieRequest } | { ok: false; message: string } {
  if (!isObject(body)) return { ok: false, message: 'Invalid request.' };
  if (!only(body, ['tmdbId', 'search', 'expected'])) return { ok: false, message: 'Unexpected field in request.' };
  const { tmdbId, search, expected } = body;
  if (!positive(tmdbId)) return { ok: false, message: 'Missing confirmed movie.' };
  if (typeof search !== 'boolean') return { ok: false, message: 'Choose whether to search now.' };
  if (!isObject(expected) || !only(expected, ['monitored', 'fileState']) || typeof expected.monitored !== 'boolean' || typeof expected.fileState !== 'string' || !FILE_STATES.includes(expected.fileState as FileState)) {
    return { ok: false, message: 'Missing confirmed state.' };
  }
  return { ok: true, value: { tmdbId, search, expected: { monitored: expected.monitored, fileState: expected.fileState as FileState } } };
}

/** Searches Cinetra refuses so that one confirmation can't trigger repeated searches. */
export const SEARCH_COOLDOWN_MS = 10 * 60_000;

/**
 * What a request may do, from Radarr's fresh state: turn monitoring on when it is off, and search only a released,
 * missing movie that is not already in the download queue and was not searched moments ago. A movie on disk is never
 * monitored (that would allow quality upgrades) or searched (that could re-download it).
 */
export function planRequest(movie: RadarrMovieResource, queue: QueueView, lastSearchAt: number | null, now: number) {
  const state = fileState(movie);
  const monitored = movie.monitored === true;
  const recentlySearched = lastSearchAt !== null && now - lastSearchAt < SEARCH_COOLDOWN_MS;
  const searchBlock: null | 'on_disk' | 'unreleased' | 'unknown' | 'queued' | 'recently_searched' =
    state === 'on_disk' ? 'on_disk' : state === 'unreleased' ? 'unreleased' : state === 'unknown' ? 'unknown' : queue ? 'queued' : recentlySearched ? 'recently_searched' : null;
  return {
    monitored,
    fileState: state,
    canMonitor: state !== 'on_disk' && !monitored,
    canSearch: searchBlock === null,
    searchBlock,
  };
}

/** Latest of Radarr's own lastSearchTime and the last search Cinetra started, in ms. */
export function lastSearchAt(movie: RadarrMovieResource, cinetraSearch: number | undefined) {
  const radarr = typeof movie.lastSearchTime === 'string' ? Date.parse(movie.lastSearchTime) : NaN;
  const values = [Number.isFinite(radarr) ? radarr : null, cinetraSearch ?? null].filter((value): value is number => value !== null);
  return values.length ? Math.max(...values) : null;
}

/* ---------- Presentation helpers ---------- */

/** Radarr's poster for the confirmation dialog: HTTPS only; otherwise the caller falls back to Cinetra's poster. */
export function posterOf(movie: RadarrMovieResource) {
  const candidates = [movie.remotePoster, ...(movie.images || []).filter(image => image?.coverType === 'poster').map(image => image.remoteUrl)];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    try { const url = new URL(candidate); if (url.protocol === 'https:') return url.toString(); } catch { /* skip */ }
  }
  return null;
}

/** "Open in Radarr" link, built from the configured base URL and Radarr's own slug (validated; Radarr v5+ uses the TMDB ID). */
export function movieLink(baseUrl: string, movie: RadarrMovieResource) {
  return typeof movie.titleSlug === 'string' && /^[a-z0-9][a-z0-9-]{0,200}$/i.test(movie.titleSlug) ? `${baseUrl}/movie/${movie.titleSlug}` : `${baseUrl}/`;
}

/** Radarr refusing a duplicate (its MovieExistsValidator / path validators). */
export const isAlreadyAddedRejection = (messages: readonly string[]) => messages.some(message => /already (been )?added|already exists|already configured/i.test(message));
