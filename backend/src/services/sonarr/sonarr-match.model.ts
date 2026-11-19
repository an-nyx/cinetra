import type { SonarrRootFolder, SonarrQualityProfile, SonarrSeriesResource } from './sonarr-client';

/**
 * Identity rules for sending a Cinetra show (identified by TMDB) to Sonarr (identified by TVDB).
 *
 * Identifier mappings only: titles, years and descriptions are never used to choose a series, so duplicate titles,
 * remakes and translated names cannot produce a match. Anything less than one consistent candidate is rejected with a
 * reason instead of guessed, and nothing is ever submitted for a rejected match.
 */
export type ExternalIds = { tvdbId: number | null; imdbId: string | null };
export type MatchRejection = 'no_tvdb_mapping' | 'not_found' | 'ambiguous' | 'conflicting_ids';
export type MatchSource = 'tmdb_external_ids' | 'sonarr_tmdb_mapping';
export type SonarrMatch = { ok: true; tvdbId: number; series: SonarrSeriesResource; source: MatchSource } | { ok: false; reason: MatchRejection };

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;
const imdb = (value: unknown) => typeof value === 'string' && /^tt\d+$/.test(value.trim()) ? value.trim() : null;

/** True when the candidate carries another series' TMDB or IMDb identifier than the Cinetra show. */
function contradicts(candidate: SonarrSeriesResource, tmdbId: number, external: ExternalIds) {
  if (positive(candidate.tmdbId) && candidate.tmdbId !== tmdbId) return true;
  const theirs = imdb(candidate.imdbId);
  return !!(theirs && external.imdbId && theirs !== external.imdbId);
}

/**
 * Primary path: TMDB's own external-ID record names the TVDB series; Sonarr's `tvdb:` lookup must return exactly that
 * series, and Sonarr's metadata must not attribute it to a different TMDB/IMDb series.
 *
 * Fallback (TMDB has no TVDB mapping): Sonarr's `tmdb:` lookup, accepted only when exactly one TVDB series carries this
 * exact TMDB ID and its IMDb ID (when both are known) agrees.
 */
export function chooseSonarrMatch(input: { tmdbId: number; external: ExternalIds; byTvdb?: SonarrSeriesResource[] | null; byTmdb?: SonarrSeriesResource[] | null }): SonarrMatch {
  const { tmdbId, external } = input;
  if (positive(external.tvdbId)) {
    const candidates = (input.byTvdb || []).filter(item => item && item.tvdbId === external.tvdbId);
    if (!candidates.length) return { ok: false, reason: 'not_found' };
    if (candidates.length > 1) return { ok: false, reason: 'ambiguous' };
    if (contradicts(candidates[0], tmdbId, external)) return { ok: false, reason: 'conflicting_ids' };
    return { ok: true, tvdbId: external.tvdbId, series: candidates[0], source: 'tmdb_external_ids' };
  }
  const candidates = (input.byTmdb || []).filter(item => item && item.tmdbId === tmdbId && positive(item.tvdbId));
  if (!candidates.length) return { ok: false, reason: 'no_tvdb_mapping' };
  if (new Set(candidates.map(item => item.tvdbId)).size > 1 || candidates.length > 1) return { ok: false, reason: 'ambiguous' };
  if (contradicts(candidates[0], tmdbId, external)) return { ok: false, reason: 'conflicting_ids' };
  return { ok: true, tvdbId: candidates[0].tvdbId as number, series: candidates[0], source: 'sonarr_tmdb_mapping' };
}

/** The Sonarr library entry for this TVDB ID, if any (Sonarr's own identifier, never the title). */
export function findExisting(series: SonarrSeriesResource[] | null | undefined, tvdbId: number) {
  const matches = (series || []).filter(item => item && item.tvdbId === tvdbId && positive(item.id));
  return matches[0] || null;
}

/** Sonarr's supported `addOptions.monitor` values offered when adding a series. "none" is the safe default. */
export const MONITOR_OPTIONS = ['none', 'future', 'missing', 'existing', 'recent', 'pilot', 'firstSeason', 'lastSeason', 'all'] as const;
export type MonitorOption = typeof MONITOR_OPTIONS[number];
export const MONITOR_NEW_ITEMS = ['none', 'all'] as const;
export type MonitorNewItems = typeof MONITOR_NEW_ITEMS[number];
export const SAFE_DEFAULTS = { monitor: 'none' as MonitorOption, monitorNewItems: 'none' as MonitorNewItems, searchForMissingEpisodes: false };

export type AddRequest = { tvdbId: number; rootFolderId: number; qualityProfileId: number; monitor: MonitorOption; monitorNewItems: MonitorNewItems; searchForMissingEpisodes: boolean };

/** Strict shape check of the client's request. Unknown fields (e.g. a path or URL) are rejected, not ignored. */
export function parseAddRequest(body: unknown): { ok: true; value: AddRequest } | { ok: false; message: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, message: 'Invalid request.' };
  const allowed = new Set(['tvdbId', 'rootFolderId', 'qualityProfileId', 'monitor', 'monitorNewItems', 'searchForMissingEpisodes']);
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(key => !allowed.has(key))) return { ok: false, message: 'Unexpected field in request.' };
  const { tvdbId, rootFolderId, qualityProfileId, monitor, monitorNewItems, searchForMissingEpisodes } = value;
  if (!positive(tvdbId)) return { ok: false, message: 'Missing confirmed series.' };
  if (!positive(rootFolderId)) return { ok: false, message: 'Choose a root folder.' };
  if (!positive(qualityProfileId)) return { ok: false, message: 'Choose a quality profile.' };
  if (typeof monitor !== 'string' || !(MONITOR_OPTIONS as readonly string[]).includes(monitor)) return { ok: false, message: 'Choose a supported monitoring option.' };
  if (typeof monitorNewItems !== 'string' || !(MONITOR_NEW_ITEMS as readonly string[]).includes(monitorNewItems)) return { ok: false, message: 'Choose whether new seasons are monitored.' };
  if (typeof searchForMissingEpisodes !== 'boolean') return { ok: false, message: 'Choose whether to search for missing episodes.' };
  // Searching only finds monitored episodes: with nothing monitored the option would be misleading.
  if (searchForMissingEpisodes && monitor === 'none') return { ok: false, message: 'Searching needs monitored episodes.' };
  return { ok: true, value: { tvdbId, rootFolderId, qualityProfileId, monitor: monitor as MonitorOption, monitorNewItems: monitorNewItems as MonitorNewItems, searchForMissingEpisodes } };
}

export function chooseRootFolder(folders: SonarrRootFolder[], id: number) {
  const folder = (folders || []).find(item => item && item.id === id && typeof item.path === 'string' && item.path.length > 0);
  return folder && folder.accessible !== false ? folder : null;
}
export function chooseQualityProfile(profiles: SonarrQualityProfile[], id: number) {
  return (profiles || []).find(item => item && item.id === id) || null;
}

const SERIES_TYPES = new Set(['standard', 'daily', 'anime']);

/**
 * The POST /api/v3/series body: Sonarr's own lookup record for the verified series, with only the selected options
 * applied. The root folder path comes from Sonarr's root folder list, never from the client.
 */
export function buildAddPayload(series: SonarrSeriesResource, options: { rootFolderPath: string; qualityProfileId: number; monitor: MonitorOption; monitorNewItems: MonitorNewItems; searchForMissingEpisodes: boolean }) {
  const { id: _id, path: _path, statistics: _statistics, added: _added, ...lookup } = series as SonarrSeriesResource & { statistics?: unknown; added?: unknown };
  const nothingMonitored = options.monitor === 'none';
  return {
    ...lookup,
    seriesType: typeof series.seriesType === 'string' && SERIES_TYPES.has(series.seriesType) ? series.seriesType : 'standard',
    // With "none", also unmonitor every season in the request itself, so nothing can be searched for or grabbed.
    seasons: (series.seasons || []).map(season => nothingMonitored ? { ...season, monitored: false } : season),
    qualityProfileId: options.qualityProfileId,
    rootFolderPath: options.rootFolderPath,
    seasonFolder: true,
    monitored: !nothingMonitored,
    monitorNewItems: options.monitorNewItems,
    tags: [],
    addOptions: {
      monitor: options.monitor,
      searchForMissingEpisodes: options.searchForMissingEpisodes,
      searchForCutoffUnmetEpisodes: false,
      ignoreEpisodesWithFiles: false,
      ignoreEpisodesWithoutFiles: false,
    },
  };
}

/** Sonarr's poster for the confirmation dialog: HTTPS only; otherwise the caller falls back to Cinetra's poster. */
export function posterOf(series: SonarrSeriesResource) {
  const candidates = [series.remotePoster, ...(series.images || []).filter(image => image?.coverType === 'poster').map(image => image.remoteUrl)];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    try { const url = new URL(candidate); if (url.protocol === 'https:') return url.toString(); } catch { /* skip */ }
  }
  return null;
}

/** "Open in Sonarr" link, built from the configured base URL and Sonarr's own slug (validated). */
export function seriesLink(baseUrl: string, series: SonarrSeriesResource) {
  return typeof series.titleSlug === 'string' && /^[a-z0-9][a-z0-9-]{0,200}$/i.test(series.titleSlug) ? `${baseUrl}/series/${series.titleSlug}` : `${baseUrl}/`;
}

/** Sonarr refusing a duplicate (its SeriesExistsValidator / path validators). */
export const isAlreadyAddedRejection = (messages: readonly string[]) => messages.some(message => /already (been )?added|already exists|already configured/i.test(message));
