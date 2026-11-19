import { SonarrClient, SonarrError, readSonarrConfig, type SonarrSeriesResource } from './sonarr-client';
import {
  MONITOR_OPTIONS, SAFE_DEFAULTS, buildAddPayload, chooseQualityProfile, chooseRootFolder, chooseSonarrMatch, findExisting,
  isAlreadyAddedRejection, posterOf, seriesLink, type AddRequest, type ExternalIds, type MatchRejection, type MatchSource,
} from './sonarr-match.model';

/**
 * Sonarr download management for Cinetra library shows. Completely separate from viewing progress: nothing here reads
 * or writes watched episodes, checkpoints, statuses, favorites, ratings or any other Cinetra library field.
 */
export type LibraryShow = { id: string; name: string; tmdbId: number | null; posterURL: string | null };
export type SonarrDeps = {
  /** null when SONARR_URL / SONARR_API_KEY are missing or invalid. */
  client: () => SonarrClient | null;
  externalIds: (tmdbId: number) => Promise<ExternalIds>;
  findShow: (showId: string, userId: string) => Promise<LibraryShow | null>;
  /** Sonarr manages the server owner's downloads: only allowed accounts can see or use it. */
  isAllowed: (userId: string) => Promise<boolean>;
  now?: () => number;
};

export type SeriesSummary = { title: string; year: number | null; tvdbId: number; posterUrl: string | null; network: string | null; seasonCount: number; source: MatchSource };
export type SonarrStatus =
  | { state: 'not_configured' }
  | { state: 'forbidden' }
  | { state: 'no_tmdb_link' }
  | { state: 'unmatched'; reason: MatchRejection }
  | { state: 'unavailable'; reason: SonarrError['code'] | 'tmdb_unavailable' }
  | { state: 'available'; series: SeriesSummary }
  | { state: 'exists'; series: SeriesSummary; sonarrUrl: string };

/** Errors returned to the client: a status code and a fixed message. Sonarr's own responses are never forwarded. */
export class SonarrRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly detail?: Record<string, unknown>) { super(message); this.name = 'SonarrRequestError'; }
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

function summary(series: SonarrSeriesResource, tvdbId: number, source: MatchSource, show: LibraryShow): SeriesSummary {
  return {
    title: typeof series.title === 'string' && series.title.trim() ? series.title.trim() : show.name,
    year: typeof series.year === 'number' && series.year > 0 ? series.year : null,
    tvdbId,
    posterUrl: posterOf(series),
    network: typeof series.network === 'string' && series.network ? series.network : null,
    seasonCount: (series.seasons || []).filter(season => season && season.seasonNumber > 0).length,
    source,
  };
}

export function createSonarrService(deps: SonarrDeps) {
  const now = deps.now || Date.now;
  const lookups = new TtlCache<SonarrSeriesResource[]>(LOOKUP_TTL, now);
  const existing = new TtlCache<SonarrSeriesResource[]>(EXISTING_TTL, now);
  const options = new TtlCache<unknown>(OPTIONS_TTL, now, 4);
  const inFlight = new Set<number>();

  async function owned(showId: string, userId: string) {
    const show = await deps.findShow(showId, userId);
    if (!show) throw new SonarrRequestError(404, 'show_not_found', 'Show not found.');
    return show;
  }

  /** Verified identity for a library show, or a rejection. Sonarr lookups are cached; existence is checked separately. */
  async function resolve(client: SonarrClient, show: LibraryShow & { tmdbId: number }) {
    const external = await deps.externalIds(show.tmdbId).catch(() => { throw new SonarrRequestError(502, 'tmdb_unavailable', 'TMDB is unavailable, so the series cannot be verified. Try again later.'); });
    if (external.tvdbId) {
      const byTvdb = await lookups.get(`tvdb:${external.tvdbId}`, () => client.lookup('tvdb', external.tvdbId as number));
      return chooseSonarrMatch({ tmdbId: show.tmdbId, external, byTvdb });
    }
    const byTmdb = await lookups.get(`tmdb:${show.tmdbId}`, () => client.lookup('tmdb', show.tmdbId));
    return chooseSonarrMatch({ tmdbId: show.tmdbId, external, byTmdb });
  }

  const existingFor = (client: SonarrClient, tvdbId: number, fresh = false) => {
    if (fresh) existing.delete(String(tvdbId));
    return existing.get(String(tvdbId), () => client.seriesByTvdbId(tvdbId)).then(list => findExisting(list, tvdbId));
  };

  async function status(showId: string, userId: string): Promise<SonarrStatus> {
    const client = deps.client();
    if (!client) return { state: 'not_configured' };
    if (!(await deps.isAllowed(userId))) return { state: 'forbidden' };
    const show = await owned(showId, userId);
    if (!show.tmdbId) return { state: 'no_tmdb_link' };
    try {
      const match = await resolve(client, show as LibraryShow & { tmdbId: number });
      if (!match.ok) return { state: 'unmatched', reason: match.reason };
      const found = await existingFor(client, match.tvdbId);
      const series = summary(found || match.series, match.tvdbId, match.source, show);
      return found ? { state: 'exists', series, sonarrUrl: seriesLink(client.baseUrl, found) } : { state: 'available', series };
    } catch (error) {
      if (error instanceof SonarrError) return { state: 'unavailable', reason: error.code };
      if (error instanceof SonarrRequestError && error.code === 'tmdb_unavailable') return { state: 'unavailable', reason: 'tmdb_unavailable' };
      throw error;
    }
  }

  async function loadOptions(client: SonarrClient, fresh = false) {
    if (fresh) options.clear();
    const [rootFolders, qualityProfiles] = await Promise.all([
      options.get('rootfolder', () => client.rootFolders()) as Promise<Awaited<ReturnType<SonarrClient['rootFolders']>>>,
      options.get('qualityprofile', () => client.qualityProfiles()) as Promise<Awaited<ReturnType<SonarrClient['qualityProfiles']>>>,
    ]);
    if (!Array.isArray(rootFolders) || !Array.isArray(qualityProfiles)) throw new SonarrError('bad_response');
    return { rootFolders, qualityProfiles };
  }

  async function requireClient(userId: string) {
    const client = deps.client();
    if (!client) throw new SonarrRequestError(503, 'not_configured', 'Sonarr is not configured on this server.');
    if (!(await deps.isAllowed(userId))) throw new SonarrRequestError(403, 'forbidden', 'Sonarr is not available for this account.');
    return client;
  }

  const unavailable = (error: SonarrError) => error.code === 'timeout'
    ? new SonarrRequestError(504, 'timeout', 'Sonarr did not respond in time. Try again in a moment.')
    : new SonarrRequestError(502, 'unavailable', error.code === 'unauthorized' ? 'Sonarr rejected Cinetra\'s credentials. Check the server configuration.' : 'Sonarr is unavailable right now. Try again in a moment.');

  /** Root folders and quality profiles exactly as Sonarr reports them, plus the supported monitoring options. */
  async function getOptions(userId: string) {
    const client = await requireClient(userId);
    try {
      const { rootFolders, qualityProfiles } = await loadOptions(client);
      return {
        rootFolders: rootFolders.filter(folder => folder && Number.isInteger(folder.id) && typeof folder.path === 'string')
          .map(folder => ({ id: folder.id, path: folder.path, accessible: folder.accessible !== false, freeSpace: typeof folder.freeSpace === 'number' ? folder.freeSpace : null })),
        qualityProfiles: qualityProfiles.filter(profile => profile && Number.isInteger(profile.id) && typeof profile.name === 'string')
          .map(profile => ({ id: profile.id, name: profile.name })),
        monitorOptions: [...MONITOR_OPTIONS],
        defaults: SAFE_DEFAULTS,
      };
    } catch (error) {
      if (error instanceof SonarrError) throw unavailable(error);
      throw error;
    }
  }

  /**
   * Add the verified series after explicit confirmation. Re-verifies everything server-side: the show belongs to the
   * user, the TVDB identity still matches what was confirmed, the series is not already in Sonarr, and the root folder
   * and quality profile exist in Sonarr right now. One addition per TVDB series at a time.
   */
  async function add(showId: string, userId: string, request: AddRequest) {
    const client = await requireClient(userId);
    const show = await owned(showId, userId);
    if (!show.tmdbId) throw new SonarrRequestError(409, 'no_tmdb_link', 'Link this show to TMDB before adding it to Sonarr.');
    if (inFlight.has(request.tvdbId)) throw new SonarrRequestError(409, 'in_progress', 'This series is already being added to Sonarr.');
    inFlight.add(request.tvdbId);
    try {
      let match;
      try { match = await resolve(client, show as LibraryShow & { tmdbId: number }); }
      catch (error) { if (error instanceof SonarrError) throw unavailable(error); throw error; }
      if (!match.ok) throw new SonarrRequestError(422, 'unmatched', 'Cinetra could not verify the matching Sonarr series, so nothing was added.', { reason: match.reason });
      if (match.tvdbId !== request.tvdbId) throw new SonarrRequestError(409, 'identity_changed', 'The matching series changed since you opened this dialog. Nothing was added; please review it again.');

      let folders, profiles, found;
      try {
        found = await existingFor(client, match.tvdbId, true);
        if (!found) ({ rootFolders: folders, qualityProfiles: profiles } = await loadOptions(client, true));
      } catch (error) { if (error instanceof SonarrError) throw unavailable(error); throw error; }
      if (found) throw new SonarrRequestError(409, 'already_exists', 'This series is already in Sonarr.', { status: { state: 'exists', series: summary(found, match.tvdbId, match.source, show), sonarrUrl: seriesLink(client.baseUrl, found) } });
      const folder = chooseRootFolder(folders || [], request.rootFolderId);
      if (!folder) throw new SonarrRequestError(400, 'invalid_root_folder', 'The selected root folder is not available in Sonarr.');
      const profile = chooseQualityProfile(profiles || [], request.qualityProfileId);
      if (!profile) throw new SonarrRequestError(400, 'invalid_quality_profile', 'The selected quality profile does not exist in Sonarr.');

      const payload = buildAddPayload(match.series, { rootFolderPath: folder.path, qualityProfileId: profile.id, monitor: request.monitor, monitorNewItems: request.monitorNewItems, searchForMissingEpisodes: request.searchForMissingEpisodes });
      let added: SonarrSeriesResource;
      try { added = await client.addSeries(payload); }
      catch (error) {
        existing.delete(String(match.tvdbId));
        if (error instanceof SonarrError && error.code === 'rejected' && isAlreadyAddedRejection(error.validation)) {
          const current = await existingFor(client, match.tvdbId, true).catch(() => null);
          throw new SonarrRequestError(409, 'already_exists', 'This series is already in Sonarr.', current ? { status: { state: 'exists', series: summary(current, match.tvdbId, match.source, show), sonarrUrl: seriesLink(client.baseUrl, current) } } : undefined);
        }
        if (error instanceof SonarrError && error.code === 'timeout') throw new SonarrRequestError(504, 'uncertain', 'Sonarr did not confirm in time. The series may still have been added: check again before retrying.');
        if (error instanceof SonarrError && error.code === 'rejected') throw new SonarrRequestError(422, 'rejected', 'Sonarr rejected the addition. Nothing was added.');
        if (error instanceof SonarrError) throw unavailable(error);
        throw error;
      }
      existing.delete(String(match.tvdbId));
      const record = added && added.tvdbId === match.tvdbId ? { ...match.series, ...added } : match.series;
      return {
        added: true,
        status: { state: 'exists', series: summary(record, match.tvdbId, match.source, show), sonarrUrl: seriesLink(client.baseUrl, record) } as SonarrStatus,
        options: { monitor: request.monitor, monitorNewItems: request.monitorNewItems, searchForMissingEpisodes: request.searchForMissingEpisodes, rootFolder: folder.path, qualityProfile: profile.name },
      };
    } finally {
      inFlight.delete(request.tvdbId);
    }
  }

  return { status, getOptions, add, clearCaches: () => { lookups.clear(); existing.clear(); options.clear(); } };
}

/* ---------- Production wiring ---------- */

let clientCache: { key: string; client: SonarrClient | null } | null = null;
/** Re-read on change so a configuration update takes effect after a restart, never via a request. */
export function defaultSonarrClient() {
  const result = readSonarrConfig();
  const key = result.config ? `${result.config.baseUrl}\u0000${result.config.apiKey}` : `error:${result.error}`;
  if (!clientCache || clientCache.key !== key) clientCache = { key, client: result.config ? new SonarrClient(result.config) : null };
  return clientCache.client;
}

/* ---------- Health: a periodic read-only connectivity check, reported by /api/v1/health (counts only) ---------- */

type SonarrHealth = { configured: boolean; configError: string | null; connected: boolean | null; checkedAt: string | null; rootFolders: number | null; qualityProfiles: number | null; error: string | null };
let health: SonarrHealth = { configured: false, configError: null, connected: null, checkedAt: null, rootFolders: null, qualityProfiles: null, error: null };
let monitor: NodeJS.Timeout | null = null;

export async function checkSonarrConnection(client: SonarrClient | null = defaultSonarrClient(), configError: string | null = readSonarrConfig().error): Promise<SonarrHealth> {
  if (!client) { health = { configured: false, configError, connected: null, checkedAt: new Date().toISOString(), rootFolders: null, qualityProfiles: null, error: null }; return health; }
  try {
    const [status, folders, profiles] = await Promise.all([client.systemStatus(), client.rootFolders(), client.qualityProfiles()]);
    if (!status || typeof status !== 'object' || !Array.isArray(folders) || !Array.isArray(profiles)) throw new SonarrError('bad_response');
    health = { configured: true, configError: null, connected: true, checkedAt: new Date().toISOString(), rootFolders: folders.length, qualityProfiles: profiles.length, error: null };
  } catch (error) {
    health = { configured: true, configError: null, connected: false, checkedAt: new Date().toISOString(), rootFolders: null, qualityProfiles: null, error: error instanceof SonarrError ? error.code : 'unreachable' };
  }
  return health;
}
export function sonarrHealth() { return health; }
export function startSonarrMonitor(intervalMs = 30 * 60_000) {
  if (monitor) return;
  const run = () => { checkSonarrConnection().then(result => { if (result.connected === false) console.warn(`Sonarr connectivity check failed: ${result.error}`); }).catch(() => {}); };
  setTimeout(run, 3000).unref();
  monitor = setInterval(run, intervalMs);
  monitor.unref();
}
