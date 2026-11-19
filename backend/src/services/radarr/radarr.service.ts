import { RadarrClient, RadarrError, readRadarrConfig, type RadarrMovieResource } from './radarr-client';
import {
  MINIMUM_AVAILABILITY, SAFE_DEFAULTS, buildAddPayload, checkLookup, chooseQualityProfile, chooseRootFolder, fileState, findExisting, isAlreadyAddedRejection,
  lastSearchAt, movieLink, planRequest, posterOf, queueView, type AddRequest, type FileState, type MatchRejection, type MovieRequest, type QueueView,
} from './radarr-model';

/**
 * Radarr download management for Cinetra library movies. Completely separate from viewing data: nothing here reads or
 * writes movie statuses, watches, ratings, notes, favorites or statistics. A downloaded movie is not a watched movie.
 */
export type LibraryMovie = { id: string; name: string; tmdbId: number | null; posterURL: string | null };
export type RadarrDeps = {
  /** null when RADARR_URL / RADARR_API_KEY are missing or invalid. */
  client: () => RadarrClient | null;
  findMovie: (movieId: string, userId: string) => Promise<LibraryMovie | null>;
  /** Radarr manages the server owner's downloads: only allowed accounts can see or use it. */
  isAllowed: (userId: string) => Promise<boolean>;
  now?: () => number;
};

export type MovieSummary = { title: string; year: number | null; tmdbId: number; posterUrl: string | null; studio: string | null; runtime: number | null };
/** canSearch: Radarr's state allows a search now (released, missing, not queued, not searched minutes ago). */
export type RadarrState = { monitored: boolean; fileState: FileState; queue: QueueView; canSearch: boolean };
export type RadarrStatus =
  | { state: 'not_configured' }
  | { state: 'forbidden' }
  | { state: 'no_tmdb_link' }
  | { state: 'unmatched'; reason: MatchRejection }
  | { state: 'unavailable'; reason: RadarrError['code'] }
  | { state: 'available'; movie: MovieSummary }
  | { state: 'exists'; movie: MovieSummary; radarrUrl: string; radarr: RadarrState };

/** Errors returned to the client: a status code and a fixed message. Radarr's own responses are never forwarded. */
export class RadarrRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly detail?: Record<string, unknown>) { super(message); this.name = 'RadarrRequestError'; }
}

const LOOKUP_TTL = 6 * 60 * 60_000;
const EXISTING_TTL = 60_000;
const OPTIONS_TTL = 60_000;

class TtlCache<V> {
  private entries = new Map<string, { expires: number; value: Promise<V> }>();
  constructor(private ttl: number, private now: () => number, private max = 500) {}
  get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.entries.get(key);
    if (hit && hit.expires > this.now()) return hit.value;
    const value = load();
    this.entries.set(key, { expires: this.now() + this.ttl, value });
    // Failures are never cached: the next request retries.
    value.catch(() => { if (this.entries.get(key)?.value === value) this.entries.delete(key); });
    if (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value as string);
    return value;
  }
  delete(key: string) { this.entries.delete(key); }
  clear() { this.entries.clear(); }
}

function summary(record: RadarrMovieResource, tmdbId: number, movie: LibraryMovie): MovieSummary {
  return {
    title: typeof record.title === 'string' && record.title.trim() ? record.title.trim() : movie.name,
    year: typeof record.year === 'number' && record.year > 0 ? record.year : null,
    tmdbId,
    posterUrl: posterOf(record),
    studio: typeof record.studio === 'string' && record.studio ? record.studio : null,
    runtime: typeof record.runtime === 'number' && record.runtime > 0 ? record.runtime : null,
  };
}

export function createRadarrService(deps: RadarrDeps) {
  const now = deps.now || Date.now;
  const lookups = new TtlCache<RadarrMovieResource>(LOOKUP_TTL, now);
  const existing = new TtlCache<RadarrMovieResource[]>(EXISTING_TTL, now);
  const options = new TtlCache<unknown>(OPTIONS_TTL, now, 4);
  /** One Radarr write per TMDB movie at a time (add and request share it). */
  const inFlight = new Set<number>();
  /** When Cinetra last started a search, per Radarr movie ID (repeated-search protection; Radarr's lastSearchTime also counts). */
  const searches = new Map<number, number>();

  async function owned(movieId: string, userId: string) {
    const movie = await deps.findMovie(movieId, userId);
    if (!movie) throw new RadarrRequestError(404, 'movie_not_found', 'Movie not found.');
    return movie;
  }

  async function requireClient(userId: string) {
    const client = deps.client();
    if (!client) throw new RadarrRequestError(503, 'not_configured', 'Radarr is not configured on this server.');
    if (!(await deps.isAllowed(userId))) throw new RadarrRequestError(403, 'forbidden', 'Radarr is not available for this account.');
    return client;
  }

  const unavailable = (error: RadarrError) => error.code === 'timeout'
    ? new RadarrRequestError(504, 'timeout', 'Radarr did not respond in time. Try again in a moment.')
    : new RadarrRequestError(502, 'unavailable', error.code === 'unauthorized' ? 'Radarr rejected Cinetra\'s credentials. Check the server configuration.' : 'Radarr is unavailable right now. Try again in a moment.');
  /** Runs a Radarr read; Radarr failures become a clean client error. */
  const read = async <T>(run: () => Promise<T>) => {
    try { return await run(); } catch (error) { if (error instanceof RadarrError) throw unavailable(error); throw error; }
  };

  const existingFor = (client: RadarrClient, tmdbId: number, fresh = false) => {
    if (fresh) existing.delete(String(tmdbId));
    return existing.get(String(tmdbId), () => client.moviesByTmdbId(tmdbId)).then(list => {
      if (!Array.isArray(list)) throw new RadarrError('bad_response');
      return findExisting(list, tmdbId);
    });
  };
  const lookupFor = (client: RadarrClient, tmdbId: number) => lookups.get(String(tmdbId), () => client.lookupTmdb(tmdbId)).then(record => checkLookup(tmdbId, record))
    .catch(error => { if (error instanceof RadarrError && error.code === 'not_found') return checkLookup(tmdbId, null); throw error; });

  /** Radarr's queue for a movie without a file. A queue failure never hides the rest of the status. */
  const queueFor = async (client: RadarrClient, record: RadarrMovieResource): Promise<QueueView> => {
    if (record.hasFile === true || !Number.isInteger(record.id)) return null;
    try { return queueView(await client.queueForMovie(record.id as number)); } catch { return null; }
  };
  const stateOf = async (client: RadarrClient, record: RadarrMovieResource): Promise<RadarrState> => {
    const queue = await queueFor(client, record);
    const plan = planRequest(record, queue, lastSearchAt(record, searches.get(record.id as number)), now());
    return { monitored: plan.monitored, fileState: plan.fileState, queue, canSearch: plan.canSearch };
  };
  const existsStatus = async (client: RadarrClient, record: RadarrMovieResource, tmdbId: number, movie: LibraryMovie): Promise<RadarrStatus> =>
    ({ state: 'exists', movie: summary(record, tmdbId, movie), radarrUrl: movieLink(client.baseUrl, record), radarr: await stateOf(client, record) });

  /** Panel status for a library movie. Read-only; Radarr failures are returned as a state, never thrown. */
  async function status(movieId: string, userId: string): Promise<RadarrStatus> {
    const client = deps.client();
    if (!client) return { state: 'not_configured' };
    if (!(await deps.isAllowed(userId))) return { state: 'forbidden' };
    const movie = await owned(movieId, userId);
    if (!movie.tmdbId) return { state: 'no_tmdb_link' };
    const tmdbId = movie.tmdbId;
    try {
      const found = await existingFor(client, tmdbId);
      if (found) return await existsStatus(client, found, tmdbId, movie);
      const match = await lookupFor(client, tmdbId);
      if (!match.ok) return { state: 'unmatched', reason: match.reason };
      return { state: 'available', movie: summary(match.movie, tmdbId, movie) };
    } catch (error) {
      if (error instanceof RadarrError) return { state: 'unavailable', reason: error.code };
      throw error;
    }
  }

  async function loadOptions(client: RadarrClient, fresh = false) {
    if (fresh) options.clear();
    const [rootFolders, qualityProfiles] = await Promise.all([
      options.get('rootfolder', () => client.rootFolders()) as Promise<Awaited<ReturnType<RadarrClient['rootFolders']>>>,
      options.get('qualityprofile', () => client.qualityProfiles()) as Promise<Awaited<ReturnType<RadarrClient['qualityProfiles']>>>,
    ]);
    if (!Array.isArray(rootFolders) || !Array.isArray(qualityProfiles)) throw new RadarrError('bad_response');
    return { rootFolders, qualityProfiles };
  }

  /** Root folders and quality profiles exactly as Radarr reports them, plus the supported availability values and safe defaults. */
  async function getOptions(userId: string) {
    const client = await requireClient(userId);
    const { rootFolders, qualityProfiles } = await read(() => loadOptions(client));
    return {
      rootFolders: rootFolders.filter(folder => folder && Number.isInteger(folder.id) && typeof folder.path === 'string')
        .map(folder => ({ id: folder.id, path: folder.path, accessible: folder.accessible !== false, freeSpace: typeof folder.freeSpace === 'number' ? folder.freeSpace : null })),
      qualityProfiles: qualityProfiles.filter(profile => profile && Number.isInteger(profile.id) && typeof profile.name === 'string')
        .map(profile => ({ id: profile.id, name: profile.name })),
      minimumAvailability: [...MINIMUM_AVAILABILITY],
      defaults: SAFE_DEFAULTS,
    };
  }

  /** Owner-only connection check: Radarr's version and option counts. Read-only. */
  async function connection(userId: string) {
    const client = await requireClient(userId);
    const [system, { rootFolders, qualityProfiles }] = await read(() => Promise.all([client.systemStatus(), loadOptions(client)]));
    return {
      connected: true,
      version: system && typeof system.version === 'string' && /^[0-9][0-9.]{0,40}$/.test(system.version) ? system.version : null,
      rootFolders: rootFolders.length,
      qualityProfiles: qualityProfiles.length,
      radarrUrl: `${client.baseUrl}/`,
    };
  }

  function lock(tmdbId: number, message: string) {
    if (inFlight.has(tmdbId)) throw new RadarrRequestError(409, 'in_progress', message);
    inFlight.add(tmdbId);
  }

  /** Starts Radarr's MoviesSearch for exactly one movie; returns whether Radarr accepted the command. */
  async function startSearch(client: RadarrClient, radarrId: number) {
    const command = await client.searchMovies([radarrId]);
    if (!command || typeof command !== 'object' || !Number.isInteger(command.id)) throw new RadarrError('bad_response');
    searches.set(radarrId, now());
    if (searches.size > 500) searches.delete(searches.keys().next().value as number);
  }

  /**
   * Add the verified movie after explicit confirmation. Re-verifies everything server-side: the movie belongs to the
   * user, its TMDB ID is the confirmed one, Radarr's lookup carries that exact ID, the movie is not already in Radarr,
   * and the root folder and quality profile exist in Radarr right now. Monitoring is set only if confirmed; a confirmed
   * search starts only after Radarr's response shows the movie monitored, released and without a file.
   */
  async function add(movieId: string, userId: string, request: AddRequest) {
    const client = await requireClient(userId);
    const movie = await owned(movieId, userId);
    if (!movie.tmdbId) throw new RadarrRequestError(409, 'no_tmdb_link', 'Link this movie to TMDB before adding it to Radarr.');
    if (movie.tmdbId !== request.tmdbId) throw new RadarrRequestError(409, 'identity_changed', 'This movie\'s TMDB link changed since you opened this dialog. Nothing was added; please review it again.');
    const tmdbId = movie.tmdbId;
    lock(tmdbId, 'This movie is already being added to Radarr.');
    try {
      const found = await read(() => existingFor(client, tmdbId, true));
      if (found) throw new RadarrRequestError(409, 'already_exists', 'This movie is already in Radarr.', { status: await existsStatus(client, found, tmdbId, movie) });
      const match = await read(() => lookupFor(client, tmdbId));
      if (!match.ok) throw new RadarrRequestError(422, 'unmatched', 'Radarr could not confirm this TMDB movie, so nothing was added.', { reason: match.reason });
      const { rootFolders, qualityProfiles } = await read(() => loadOptions(client, true));
      const folder = chooseRootFolder(rootFolders, request.rootFolderId);
      if (!folder) throw new RadarrRequestError(400, 'invalid_root_folder', 'The selected root folder is not available in Radarr.');
      const profile = chooseQualityProfile(qualityProfiles, request.qualityProfileId);
      if (!profile) throw new RadarrRequestError(400, 'invalid_quality_profile', 'The selected quality profile does not exist in Radarr.');

      const payload = buildAddPayload(match.movie, { rootFolderPath: folder.path, qualityProfileId: profile.id, minimumAvailability: request.minimumAvailability, monitored: request.monitored });
      let added: RadarrMovieResource | null = null;
      try { added = await client.addMovie(payload); }
      catch (error) {
        existing.delete(String(tmdbId));
        if (!(error instanceof RadarrError)) throw error;
        if (error.code === 'rejected' && isAlreadyAddedRejection(error.validation)) {
          const current = await existingFor(client, tmdbId, true).catch(() => null);
          throw new RadarrRequestError(409, 'already_exists', 'This movie is already in Radarr.', current ? { status: await existsStatus(client, current, tmdbId, movie) } : undefined);
        }
        if (error.code === 'timeout') throw new RadarrRequestError(504, 'uncertain', 'Radarr did not confirm in time. The movie may still have been added: check again before retrying.');
        if (error.code === 'rejected') throw new RadarrRequestError(422, 'rejected', 'Radarr rejected the addition. Nothing was added.');
        throw unavailable(error);
      }
      existing.delete(String(tmdbId));

      // Verify Radarr's answer (or, if it is not usable, Radarr's library) before reporting success.
      let record = added && added.tmdbId === tmdbId && Number.isInteger(added.id) && (added.id as number) > 0 ? added : null;
      if (!record) record = await existingFor(client, tmdbId, true).catch(() => null);
      if (!record) throw new RadarrRequestError(502, 'unverified', 'Radarr did not confirm the addition. Check Radarr before retrying.');
      const monitoredNow = record.monitored === true;

      let search: 'not_requested' | 'started' | 'failed' | 'not_monitored' | 'not_available' = 'not_requested';
      if (request.searchForMovie) {
        if (!monitoredNow) search = 'not_monitored';
        else if (fileState(record) !== 'missing') search = 'not_available';
        else {
          try { await startSearch(client, record.id as number); search = 'started'; }
          catch (error) { if (!(error instanceof RadarrError)) throw error; search = 'failed'; }
        }
      }
      return {
        added: true,
        monitored: monitoredNow,
        monitoringAsRequested: monitoredNow === request.monitored,
        search,
        status: await existsStatus(client, record, tmdbId, movie),
        options: { rootFolder: folder.path, qualityProfile: profile.name, minimumAvailability: request.minimumAvailability },
      };
    } finally {
      inFlight.delete(tmdbId);
    }
  }

  /** The existing Radarr movie for a library movie (fresh read), or a clear refusal. Read-only. */
  async function existingMovie(client: RadarrClient, movie: LibraryMovie, tmdbId?: number) {
    if (!movie.tmdbId) throw new RadarrRequestError(409, 'no_tmdb_link', 'Link this movie to TMDB to manage it in Radarr.');
    if (tmdbId !== undefined && movie.tmdbId !== tmdbId) throw new RadarrRequestError(409, 'identity_changed', 'This movie\'s TMDB link changed since you opened this dialog. Nothing was changed; please review it again.');
    const found = await read(() => existingFor(client, movie.tmdbId as number, true));
    if (!found) throw new RadarrRequestError(409, 'not_in_radarr', 'This movie is not in Radarr.');
    return found;
  }

  async function detailView(client: RadarrClient, record: RadarrMovieResource, movie: LibraryMovie) {
    const queue = await queueFor(client, record);
    const plan = planRequest(record, queue, lastSearchAt(record, searches.get(record.id as number)), now());
    return {
      tmdbId: movie.tmdbId as number,
      movie: summary(record, movie.tmdbId as number, movie),
      radarrUrl: movieLink(client.baseUrl, record),
      monitored: plan.monitored,
      fileState: plan.fileState,
      queue,
      canMonitor: plan.canMonitor,
      canSearch: plan.canSearch,
      searchBlock: plan.searchBlock,
      checkedAt: new Date(now()).toISOString(),
    };
  }

  /** Fresh monitoring / file / queue state for the Request Movie dialog. Read-only: never monitors or searches. */
  async function detail(movieId: string, userId: string) {
    const client = await requireClient(userId);
    const movie = await owned(movieId, userId);
    const record = await existingMovie(client, movie);
    return detailView(client, record, movie);
  }

  /**
   * Request a movie that is already in Radarr, after explicit confirmation of the state the user saw. Order matters:
   * 1. turn monitoring on (only that field) if it is off, 2. re-read Radarr and verify, 3. only then, if confirmed,
   * search a released, missing movie. Nothing is unmonitored, deleted, replaced, upgraded or re-downloaded.
   */
  async function requestMovie(movieId: string, userId: string, request: MovieRequest) {
    const client = await requireClient(userId);
    const movie = await owned(movieId, userId);
    if (movie.tmdbId && movie.tmdbId !== request.tmdbId) throw new RadarrRequestError(409, 'identity_changed', 'This movie\'s TMDB link changed since you opened this dialog. Nothing was changed; please review it again.');
    lock(request.tmdbId, 'Another Radarr change for this movie is in progress. Please wait.');
    try {
      const record = await existingMovie(client, movie, request.tmdbId);
      const radarrId = record.id as number;
      const queue = await queueFor(client, record);
      const plan = planRequest(record, queue, lastSearchAt(record, searches.get(radarrId)), now());
      if (plan.monitored !== request.expected.monitored || plan.fileState !== request.expected.fileState) {
        throw new RadarrRequestError(409, 'state_changed', 'Radarr\'s state for this movie changed. Nothing was changed; please review it again.');
      }
      if (plan.fileState === 'on_disk') throw new RadarrRequestError(409, 'on_disk', 'This movie is already on disk in Radarr. Nothing was changed.');
      if (request.search && !plan.canSearch) {
        throw new RadarrRequestError(plan.searchBlock === 'recently_searched' ? 429 : 409, plan.searchBlock === 'recently_searched' ? 'recently_searched' : 'search_unavailable',
          plan.searchBlock === 'recently_searched' ? 'Radarr searched for this movie a few minutes ago. Nothing was changed; try again later.'
            : 'A search is not possible for this movie right now. Nothing was changed.', { reason: plan.searchBlock });
      }
      if (!plan.canMonitor && !request.search) throw new RadarrRequestError(422, 'nothing_to_do', 'This movie is already monitored. Nothing was changed.');

      const done = { monitored: false, search: false };
      if (plan.canMonitor) {
        try { await client.monitorMovies([radarrId]); done.monitored = true; }
        catch (error) {
          if (!(error instanceof RadarrError)) throw error;
          if (error.code === 'timeout') throw new RadarrRequestError(504, 'uncertain', 'Radarr did not confirm in time. The movie may be monitored: check again before retrying. No search was started.');
          throw new RadarrRequestError(502, 'not_applied', 'Radarr refused the change. Nothing was changed.');
        }
      }
      existing.delete(String(request.tmdbId));

      // Verify from Radarr itself before any search.
      let fresh: RadarrMovieResource;
      try { fresh = await client.movieById(radarrId); }
      catch (error) {
        if (!(error instanceof RadarrError)) throw error;
        throw new RadarrRequestError(502, 'unverified', 'The change was sent, but Radarr could not be re-checked, so no search was started. Check again in a moment.', { applied: done });
      }
      if (!fresh || fresh.tmdbId !== request.tmdbId || fresh.monitored !== true) {
        throw new RadarrRequestError(502, 'unverified', 'Radarr did not report the movie as monitored, so no search was started. Check the movie in Radarr.', { applied: done });
      }

      if (request.search) {
        // Re-check on the fresh record: a file may have arrived in the meantime.
        if (fileState(fresh) !== 'missing') throw new RadarrRequestError(409, 'search_unavailable', done.monitored ? 'Monitoring is on. Radarr\'s state changed, so no search was started.' : 'Radarr\'s state changed, so no search was started.', { applied: done });
        try { await startSearch(client, radarrId); done.search = true; }
        catch (error) {
          if (!(error instanceof RadarrError)) throw error;
          throw new RadarrRequestError(error.code === 'timeout' ? 504 : 502, 'search_failed', error.code === 'timeout'
            ? 'Monitoring is on. Radarr did not confirm the search in time; it may still have started.'
            : 'Monitoring is on, but Radarr could not start the search. Radarr will still look for the movie through its RSS feeds.', { applied: done });
        }
      }
      return { requested: true, monitoringEnabled: done.monitored, searched: done.search, view: await detailView(client, fresh, movie) };
    } finally {
      inFlight.delete(request.tmdbId);
    }
  }

  return { status, getOptions, connection, add, detail, requestMovie, clearCaches: () => { lookups.clear(); existing.clear(); options.clear(); searches.clear(); } };
}

/* ---------- Production wiring ---------- */

let clientCache: { key: string; client: RadarrClient | null } | null = null;
/** Re-read on change so a configuration update takes effect after a restart, never via a request. */
export function defaultRadarrClient() {
  const result = readRadarrConfig();
  const key = result.config ? `${result.config.baseUrl}\u0000${result.config.apiKey}` : `error:${result.error}`;
  if (!clientCache || clientCache.key !== key) clientCache = { key, client: result.config ? new RadarrClient(result.config) : null };
  return clientCache.client;
}

/* ---------- Health: a periodic read-only connectivity check, reported by /api/v1/health (counts only) ---------- */

type RadarrHealth = { configured: boolean; configError: string | null; connected: boolean | null; checkedAt: string | null; rootFolders: number | null; qualityProfiles: number | null; error: string | null };
let health: RadarrHealth = { configured: false, configError: null, connected: null, checkedAt: null, rootFolders: null, qualityProfiles: null, error: null };
let monitor: NodeJS.Timeout | null = null;

export async function checkRadarrConnection(client: RadarrClient | null = defaultRadarrClient(), configError: string | null = readRadarrConfig().error): Promise<RadarrHealth> {
  if (!client) { health = { configured: false, configError, connected: null, checkedAt: new Date().toISOString(), rootFolders: null, qualityProfiles: null, error: null }; return health; }
  try {
    const [status, folders, profiles] = await Promise.all([client.systemStatus(), client.rootFolders(), client.qualityProfiles()]);
    if (!status || typeof status !== 'object' || !Array.isArray(folders) || !Array.isArray(profiles)) throw new RadarrError('bad_response');
    health = { configured: true, configError: null, connected: true, checkedAt: new Date().toISOString(), rootFolders: folders.length, qualityProfiles: profiles.length, error: null };
  } catch (error) {
    health = { configured: true, configError: null, connected: false, checkedAt: new Date().toISOString(), rootFolders: null, qualityProfiles: null, error: error instanceof RadarrError ? error.code : 'unreachable' };
  }
  return health;
}
export function radarrHealth() { return health; }
export function startRadarrMonitor(intervalMs = 30 * 60_000) {
  if (monitor) return;
  const run = () => { checkRadarrConnection().then(result => { if (result.connected === false) console.warn(`Radarr connectivity check failed: ${result.error}`); }).catch(() => {}); };
  setTimeout(run, 3000).unref();
  monitor = setInterval(run, intervalMs);
  monitor.unref();
}
