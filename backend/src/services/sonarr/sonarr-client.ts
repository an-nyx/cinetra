import axios, { AxiosInstance } from 'axios';

/**
 * Minimal Sonarr v3 API client. Server-side only: the API key is read from the backend environment and is sent only
 * as a request header to the configured Sonarr host. It never appears in errors, logs or API responses.
 *
 * Errors are always replaced by a SonarrError that carries a short code and the HTTP status: never the axios error,
 * its request config (which holds the key) or Sonarr's response body.
 */
export type SonarrErrorCode = 'not_configured' | 'unreachable' | 'timeout' | 'unauthorized' | 'rejected' | 'not_found' | 'bad_response';

export class SonarrError extends Error {
  readonly code: SonarrErrorCode;
  readonly status: number | null;
  /** Sonarr's validation messages (400 only), for internal classification. Never returned to clients. */
  readonly validation: readonly string[];
  constructor(code: SonarrErrorCode, status: number | null = null, validation: readonly string[] = []) {
    super(`Sonarr request failed: ${code}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'SonarrError';
    this.code = code;
    this.status = status;
    this.validation = validation;
  }
}

export type SonarrConfig = { baseUrl: string; apiKey: string };
export type SonarrConfigResult = { config: SonarrConfig; error: null } | { config: null; error: 'missing' | 'invalid_url' | 'invalid_key' };

/** Validate SONARR_URL / SONARR_API_KEY. The URL comes only from the server environment, never from a request. */
export function readSonarrConfig(env: NodeJS.ProcessEnv = process.env): SonarrConfigResult {
  const rawUrl = (env.SONARR_URL || '').trim();
  const apiKey = (env.SONARR_API_KEY || '').trim();
  if (!rawUrl || !apiKey) return { config: null, error: 'missing' };
  if (!/^[A-Za-z0-9]{16,128}$/.test(apiKey)) return { config: null, error: 'invalid_key' };
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { config: null, error: 'invalid_url' }; }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) return { config: null, error: 'invalid_url' };
  return { config: { baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, apiKey }, error: null };
}

export type SonarrImage = { coverType?: string; remoteUrl?: string; url?: string };
export type SonarrSeason = { seasonNumber: number; monitored?: boolean };
export type SonarrSeriesResource = {
  id?: number; title?: string; sortTitle?: string; year?: number; tvdbId?: number; tmdbId?: number; imdbId?: string; tvMazeId?: number;
  titleSlug?: string; remotePoster?: string; images?: SonarrImage[]; seasons?: SonarrSeason[]; seriesType?: string; network?: string;
  path?: string; [key: string]: unknown;
};
export type SonarrRootFolder = { id: number; path: string; accessible?: boolean; freeSpace?: number };
export type SonarrQualityProfile = { id: number; name: string };

export class SonarrClient {
  private http: AxiosInstance;
  readonly baseUrl: string;

  constructor(config: SonarrConfig, http?: AxiosInstance) {
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
    catch (error) { throw toSonarrError(error); }
    // A login page or proxy error page instead of JSON means the request did not reach the API.
    if (typeof data === 'string') throw new SonarrError('bad_response');
    return data;
  }

  systemStatus() { return this.call<{ version?: string; appName?: string }>(() => this.http.get('/system/status')); }
  rootFolders() { return this.call<SonarrRootFolder[]>(() => this.http.get('/rootfolder')); }
  qualityProfiles() { return this.call<SonarrQualityProfile[]>(() => this.http.get('/qualityprofile')); }
  /** Supported identifier lookups only (`tvdb:<id>` / `tmdb:<id>`); free-text title searches are never used. */
  lookup(kind: 'tvdb' | 'tmdb', id: number) {
    if (!Number.isInteger(id) || id <= 0) return Promise.reject(new SonarrError('rejected'));
    return this.call<SonarrSeriesResource[]>(() => this.http.get('/series/lookup', { params: { term: `${kind}:${id}` }, timeout: 20_000 }));
  }
  seriesByTvdbId(tvdbId: number) { return this.call<SonarrSeriesResource[]>(() => this.http.get('/series', { params: { tvdbId } })); }
  addSeries(payload: Record<string, unknown>) { return this.call<SonarrSeriesResource>(() => this.http.post('/series', payload, { timeout: 30_000 })); }
}

function toSonarrError(error: unknown): SonarrError {
  if (error instanceof SonarrError) return error;
  if (!axios.isAxiosError(error)) return new SonarrError('unreachable');
  const status = error.response?.status ?? null;
  if (!error.response) {
    return new SonarrError(error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' ? 'timeout' : 'unreachable');
  }
  if (status === 401 || status === 403) return new SonarrError('unauthorized', status);
  if (status === 404) return new SonarrError('not_found', status);
  if (status === 400 || status === 409 || status === 422) {
    const body = error.response.data;
    const messages = Array.isArray(body) ? body.map(item => typeof item?.errorMessage === 'string' ? item.errorMessage.slice(0, 300) : '').filter(Boolean)
      : typeof (body as { message?: unknown })?.message === 'string' ? [((body as { message: string }).message).slice(0, 300)] : [];
    return new SonarrError('rejected', status, messages);
  }
  if (status !== null && status >= 300 && status < 400) return new SonarrError('bad_response', status);
  return new SonarrError('unreachable', status);
}
