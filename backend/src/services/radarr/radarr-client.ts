import axios, { AxiosInstance } from 'axios';

/**
 * Minimal Radarr v3 API client (verified against Radarr v6). Server-side only: the API key is read from the backend
 * environment and is sent only as a request header to the configured Radarr host. It never appears in errors, logs or
 * API responses.
 *
 * Only these operations exist: reads, adding one movie, turning monitoring ON for exact movie IDs, and a MoviesSearch
 * command for exact movie IDs. There is no delete, unmonitor, file, rename or settings call, and no generic proxy.
 *
 * Errors are always replaced by a RadarrError that carries a short code and the HTTP status: never the axios error,
 * its request config (which holds the key) or Radarr's response body.
 */
export type RadarrErrorCode = 'not_configured' | 'unreachable' | 'timeout' | 'unauthorized' | 'rejected' | 'not_found' | 'bad_response';

export class RadarrError extends Error {
  readonly code: RadarrErrorCode;
  readonly status: number | null;
  /** Radarr's validation messages (400 only), for internal classification. Never returned to clients. */
  readonly validation: readonly string[];
  constructor(code: RadarrErrorCode, status: number | null = null, validation: readonly string[] = []) {
    super(`Radarr request failed: ${code}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'RadarrError';
    this.code = code;
    this.status = status;
    this.validation = validation;
  }
}

export type RadarrConfig = { baseUrl: string; apiKey: string };
export type RadarrConfigResult = { config: RadarrConfig; error: null } | { config: null; error: 'missing' | 'invalid_url' | 'invalid_key' };

/** Validate RADARR_URL / RADARR_API_KEY. The URL comes only from the server environment, never from a request. */
export function readRadarrConfig(env: NodeJS.ProcessEnv = process.env): RadarrConfigResult {
  const rawUrl = (env.RADARR_URL || '').trim();
  const apiKey = (env.RADARR_API_KEY || '').trim();
  if (!rawUrl || !apiKey) return { config: null, error: 'missing' };
  if (!/^[A-Za-z0-9]{16,128}$/.test(apiKey)) return { config: null, error: 'invalid_key' };
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { config: null, error: 'invalid_url' }; }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) return { config: null, error: 'invalid_url' };
  return { config: { baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, apiKey }, error: null };
}

export type RadarrImage = { coverType?: string; remoteUrl?: string; url?: string };
export type RadarrMovieResource = {
  id?: number; title?: string; year?: number; tmdbId?: number; imdbId?: string; titleSlug?: string; remotePoster?: string; images?: RadarrImage[];
  monitored?: boolean; hasFile?: boolean; isAvailable?: boolean; status?: string; minimumAvailability?: string; lastSearchTime?: string | null;
  studio?: string; runtime?: number; path?: string; [key: string]: unknown;
};
export type RadarrQueueItem = { movieId?: number; status?: string; trackedDownloadState?: string; trackedDownloadStatus?: string; size?: number; sizeleft?: number; [key: string]: unknown };
export type RadarrRootFolder = { id: number; path: string; accessible?: boolean; freeSpace?: number };
export type RadarrQualityProfile = { id: number; name: string };

export class RadarrClient {
  private http: AxiosInstance;
  readonly baseUrl: string;

  constructor(config: RadarrConfig, http?: AxiosInstance) {
    this.baseUrl = config.baseUrl;
    this.http = http || axios.create({
      baseURL: `${config.baseUrl}/api/v3`,
      timeout: 10_000,
      // Never follow redirects: a redirect could carry the API key header to another host.
      maxRedirects: 0,
      headers: { 'X-Api-Key': config.apiKey, Accept: 'application/json', 'User-Agent': 'Cinetra/1.0' },
      validateStatus: status => status >= 200 && status < 300,
    });
  }

  private async call<T>(run: () => Promise<{ data: T }>): Promise<T> {
    let data: T;
    try { data = (await run()).data; }
    catch (error) { throw toRadarrError(error); }
    // A login page or proxy error page instead of JSON means the request did not reach the API.
    if (typeof data === 'string') throw new RadarrError('bad_response');
    return data;
  }

  systemStatus() { return this.call<{ version?: string; appName?: string }>(() => this.http.get('/system/status')); }
  rootFolders() { return this.call<RadarrRootFolder[]>(() => this.http.get('/rootfolder')); }
  qualityProfiles() { return this.call<RadarrQualityProfile[]>(() => this.http.get('/qualityprofile')); }
  /** Radarr's metadata record for exactly this TMDB ID (no free-text search). Read-only. */
  lookupTmdb(tmdbId: number) {
    return this.call<RadarrMovieResource>(() => this.http.get('/movie/lookup/tmdb', { params: { tmdbId: positiveId(tmdbId) }, timeout: 20_000 }));
  }
  /** Radarr library entries with this TMDB ID (Radarr's own filter; normally zero or one). Read-only. */
  moviesByTmdbId(tmdbId: number) { return this.call<RadarrMovieResource[]>(() => this.http.get('/movie', { params: { tmdbId: positiveId(tmdbId) } })); }
  movieById(movieId: number) { return this.call<RadarrMovieResource>(() => this.http.get(`/movie/${positiveId(movieId)}`)); }
  /** Download queue entries for one movie (Radarr's own data). Read-only. */
  queueForMovie(movieId: number) { return this.call<RadarrQueueItem[]>(() => this.http.get('/queue/details', { params: { movieId: positiveId(movieId) } })); }
  addMovie(payload: Record<string, unknown>) { return this.call<RadarrMovieResource>(() => this.http.post('/movie', payload, { timeout: 30_000 })); }
  /**
   * Turns monitoring ON (never off) for exactly these movie IDs via Radarr's movie editor. Only `monitored` is sent, so
   * Radarr changes no other field: no profile, availability, tags, root folder or file move.
   */
  monitorMovies(movieIds: number[]) {
    return this.call<unknown>(() => this.http.put('/movie/editor', { movieIds: movieIds.map(positiveId), monitored: true }, { timeout: 30_000 }));
  }
  /** Searches exactly these movie IDs. Radarr grabs a release only if it finds an acceptable one. */
  searchMovies(movieIds: number[]) {
    return this.call<{ id?: number }>(() => this.http.post('/command', { name: 'MoviesSearch', movieIds: movieIds.map(positiveId) }, { timeout: 30_000 }));
  }
}

function positiveId(value: number) {
  if (!Number.isInteger(value) || value <= 0) throw new RadarrError('rejected');
  return value;
}

function toRadarrError(error: unknown): RadarrError {
  if (error instanceof RadarrError) return error;
  if (!axios.isAxiosError(error)) return new RadarrError('unreachable');
  const status = error.response?.status ?? null;
  if (!error.response) {
    return new RadarrError(error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' ? 'timeout' : 'unreachable');
  }
  if (status === 401 || status === 403) return new RadarrError('unauthorized', status);
  if (status === 404) return new RadarrError('not_found', status);
  if (status === 400 || status === 409 || status === 422) {
    const body = error.response.data;
    const messages = Array.isArray(body) ? body.map(item => typeof item?.errorMessage === 'string' ? item.errorMessage.slice(0, 300) : '').filter(Boolean)
      : typeof (body as { message?: unknown })?.message === 'string' ? [((body as { message: string }).message).slice(0, 300)] : [];
    return new RadarrError('rejected', status, messages);
  }
  if (status !== null && status >= 300 && status < 400) return new RadarrError('bad_response', status);
  return new RadarrError('unreachable', status);
}
