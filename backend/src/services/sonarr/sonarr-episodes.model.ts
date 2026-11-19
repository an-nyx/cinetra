import type { SonarrEpisodeResource, SonarrSeriesResource } from './sonarr-client';

/**
 * Precise episode requests for a series that is already in Sonarr.
 *
 * Everything is computed from Sonarr's own series and episode records (Sonarr IDs and Sonarr/TVDB numbering), never from
 * TMDB numbering. The plan only ever turns monitoring ON for the requested selection: nothing is unmonitored, deleted or
 * re-downloaded, and monitoring outside the selection is left exactly as it is.
 *
 * Sonarr semantics this relies on (verified against Sonarr v4 source):
 * - `PUT /episode/monitor` changes only the listed episode IDs.
 * - `POST /seasonpass` without `monitoringOptions` changes only the listed series/season flags and does NOT cascade to
 *   episodes (`UpdateSeries(series, updateEpisodesToMatchSeason: false)`).
 * - Releases are grabbed only when both the series and the episode are monitored; a season's flag decides whether
 *   episodes Sonarr adds to that season later are monitored.
 * - `EpisodeSearch` searches exactly the listed episode IDs.
 */
export type EpisodeState = 'downloaded' | 'missing' | 'unreleased';
export type RequestMode = 'series' | 'seasons' | 'episodes';
export const REQUEST_MODES: readonly RequestMode[] = ['series', 'seasons', 'episodes'];

export type EpisodeView = { id: number; seasonNumber: number; episodeNumber: number; title: string | null; airDateUtc: string | null; monitored: boolean; state: EpisodeState };
/** `flag` is false when Sonarr lists episodes for a season it has no season entry for (its flag cannot be set). */
export type SeasonView = { seasonNumber: number; monitored: boolean; flag: boolean; episodes: EpisodeView[] };

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;
const nonNegative = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** An episode is released once its UTC air time has passed; no air date means not announced yet (TBA). */
export function episodeState(episode: Pick<SonarrEpisodeResource, 'hasFile' | 'airDateUtc'>, now: number): EpisodeState {
  if (episode.hasFile === true) return 'downloaded';
  const aired = typeof episode.airDateUtc === 'string' ? Date.parse(episode.airDateUtc) : NaN;
  return Number.isFinite(aired) && aired <= now ? 'missing' : 'unreleased';
}

/** Valid episode records of this series only (a record for another series or without an ID is ignored). */
export function cleanEpisodes(episodes: SonarrEpisodeResource[] | null | undefined, seriesId: number) {
  return (Array.isArray(episodes) ? episodes : []).filter(episode => episode && positive(episode.id) && nonNegative(episode.seasonNumber) && nonNegative(episode.episodeNumber)
    && (episode.seriesId === undefined || episode.seriesId === seriesId));
}

/** The picker's data: Sonarr seasons (with their own monitored flag) and episodes, ordered by Sonarr numbering. */
export function seasonViews(series: SonarrSeriesResource, episodes: SonarrEpisodeResource[], now: number): SeasonView[] {
  const flags = new Map((series.seasons || []).filter(season => season && nonNegative(season.seasonNumber)).map(season => [season.seasonNumber, season.monitored === true]));
  const bySeason = new Map<number, EpisodeView[]>();
  for (const episode of episodes) {
    const list = bySeason.get(episode.seasonNumber) || [];
    list.push({
      id: episode.id as number, seasonNumber: episode.seasonNumber, episodeNumber: episode.episodeNumber,
      title: typeof episode.title === 'string' && episode.title.trim() ? episode.title.trim().slice(0, 200) : null,
      airDateUtc: typeof episode.airDateUtc === 'string' && Number.isFinite(Date.parse(episode.airDateUtc)) ? new Date(episode.airDateUtc).toISOString() : null,
      monitored: episode.monitored === true, state: episodeState(episode, now),
    });
    bySeason.set(episode.seasonNumber, list);
  }
  const numbers = [...new Set([...flags.keys(), ...bySeason.keys()])].sort((a, b) => a - b);
  return numbers.map(seasonNumber => ({ seasonNumber, monitored: flags.get(seasonNumber) === true, flag: flags.has(seasonNumber), episodes: (bySeason.get(seasonNumber) || []).sort((a, b) => a.episodeNumber - b.episodeNumber || a.id - b.id) }));
}

export type EpisodeRequest = {
  tvdbId: number; mode: RequestMode; seasons: number[]; episodeIds: number[]; search: boolean;
  /** What the confirmation showed. If Sonarr's data changed meanwhile, the request is refused instead of doing something else. */
  expected: { monitor: number; seasons: number; search: number; enableSeries: boolean };
};

const MAX_EPISODES = 5000;
const MAX_SEASONS = 300;
const intList = (value: unknown, max: number, valid: (item: unknown) => boolean) => Array.isArray(value) && value.length <= max && value.every(valid) ? [...new Set(value as number[])] : null;

/** Strict shape check. Unknown fields are refused, and the selection must fit the mode exactly. */
export function parseEpisodeRequest(body: unknown): { ok: true; value: EpisodeRequest } | { ok: false; message: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, message: 'Invalid request.' };
  const value = body as Record<string, unknown>;
  const allowed = new Set(['tvdbId', 'mode', 'seasons', 'episodeIds', 'search', 'expected']);
  if (Object.keys(value).some(key => !allowed.has(key))) return { ok: false, message: 'Unexpected field in request.' };
  if (!positive(value.tvdbId)) return { ok: false, message: 'Missing confirmed series.' };
  if (typeof value.mode !== 'string' || !(REQUEST_MODES as readonly string[]).includes(value.mode)) return { ok: false, message: 'Choose what to request.' };
  const mode = value.mode as RequestMode;
  const seasons = value.seasons === undefined ? [] : intList(value.seasons, MAX_SEASONS, nonNegative);
  const episodeIds = value.episodeIds === undefined ? [] : intList(value.episodeIds, MAX_EPISODES, positive);
  if (!seasons) return { ok: false, message: 'Invalid seasons.' };
  if (!episodeIds) return { ok: false, message: 'Invalid episodes.' };
  if (mode === 'series' && (seasons.length || episodeIds.length)) return { ok: false, message: 'The entire series takes no season or episode list.' };
  if (mode === 'seasons' && (!seasons.length || episodeIds.length)) return { ok: false, message: 'Choose at least one season.' };
  if (mode === 'episodes' && (!episodeIds.length || seasons.length)) return { ok: false, message: 'Choose at least one episode.' };
  if (typeof value.search !== 'boolean') return { ok: false, message: 'Choose whether to search now.' };
  const expected = value.expected as Record<string, unknown> | undefined;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) || Object.keys(expected).some(key => !['monitor', 'seasons', 'search', 'enableSeries'].includes(key))
    || !nonNegative(expected.monitor) || !nonNegative(expected.seasons) || !nonNegative(expected.search) || typeof expected.enableSeries !== 'boolean') return { ok: false, message: 'Missing confirmation summary.' };
  if (!value.search && expected.search !== 0) return { ok: false, message: 'Missing confirmation summary.' };
  return { ok: true, value: { tvdbId: value.tvdbId, mode, seasons: seasons.sort((a, b) => a - b), episodeIds, search: value.search, expected: { monitor: expected.monitor, seasons: expected.seasons, search: expected.search, enableSeries: expected.enableSeries } } };
}

export type RequestPlan = {
  /** Every episode in the request (whether or not it is already monitored). */
  selectedIds: number[];
  /** Selected episodes that are not monitored yet: the only episode flags that change. */
  monitorIds: number[];
  /** Seasons whose own flag turns on (whole-season requests only), so episodes Sonarr adds to them later are monitored too. */
  seasonNumbers: number[];
  /** Series monitoring is off and must be turned on for anything to download. */
  enableSeries: boolean;
  /** Episodes outside the selection that are already marked monitored and become active when series monitoring turns on. */
  alsoActivated: number;
  /** Selected episodes that are released and have no file: the only ones searched, and only when asked. */
  searchIds: number[];
  counts: { selected: number; alreadyMonitored: number; downloaded: number; missing: number; unreleased: number };
};

export type PlanError = { ok: false; code: 'unknown_season' | 'unknown_episode' | 'empty_selection' };

/** Exactly what a request changes. Pure; the same function decides the confirmation check and the writes. */
export function planRequest(series: SonarrSeriesResource, episodes: SonarrEpisodeResource[], request: Pick<EpisodeRequest, 'mode' | 'seasons' | 'episodeIds' | 'search'>, now: number): ({ ok: true } & RequestPlan) | PlanError {
  const seasonFlags = new Map((series.seasons || []).filter(season => season && nonNegative(season.seasonNumber)).map(season => [season.seasonNumber, season.monitored === true]));
  const known = new Set([...seasonFlags.keys(), ...episodes.map(episode => episode.seasonNumber)]);
  let selected: SonarrEpisodeResource[];
  let wholeSeasons: number[] = [];
  if (request.mode === 'series') {
    // Regular seasons only: specials (season 0) are never part of "entire series".
    wholeSeasons = [...known].filter(number => number > 0).sort((a, b) => a - b);
    selected = episodes.filter(episode => episode.seasonNumber > 0);
  } else if (request.mode === 'seasons') {
    if (request.seasons.some(number => !known.has(number))) return { ok: false, code: 'unknown_season' };
    wholeSeasons = [...request.seasons];
    const wanted = new Set(request.seasons);
    selected = episodes.filter(episode => wanted.has(episode.seasonNumber));
  } else {
    const byId = new Map(episodes.map(episode => [episode.id as number, episode]));
    if (request.episodeIds.some(id => !byId.has(id))) return { ok: false, code: 'unknown_episode' };
    selected = request.episodeIds.map(id => byId.get(id) as SonarrEpisodeResource);
  }
  if (!selected.length) return { ok: false, code: 'empty_selection' };
  const selectedIds = new Set(selected.map(episode => episode.id as number));
  const states = selected.map(episode => episodeState(episode, now));
  const enableSeries = series.monitored !== true;
  return {
    ok: true,
    selectedIds: [...selectedIds],
    monitorIds: selected.filter(episode => episode.monitored !== true).map(episode => episode.id as number),
    seasonNumbers: wholeSeasons.filter(number => seasonFlags.has(number) && seasonFlags.get(number) !== true),
    enableSeries,
    alsoActivated: enableSeries ? episodes.filter(episode => episode.monitored === true && !selectedIds.has(episode.id as number)).length : 0,
    searchIds: request.search ? selected.filter((_, index) => states[index] === 'missing').map(episode => episode.id as number) : [],
    counts: {
      selected: selected.length,
      alreadyMonitored: selected.filter(episode => episode.monitored === true).length,
      downloaded: states.filter(state => state === 'downloaded').length,
      missing: states.filter(state => state === 'missing').length,
      unreleased: states.filter(state => state === 'unreleased').length,
    },
  };
}

/** True when the plan is exactly what the user confirmed. */
export const matchesConfirmation = (plan: RequestPlan, expected: EpisodeRequest['expected']) =>
  plan.monitorIds.length === expected.monitor && plan.seasonNumbers.length === expected.seasons && plan.searchIds.length === expected.search && plan.enableSeries === expected.enableSeries;

/** Season pass body: only the changing flags. No monitoringOptions, so Sonarr does not touch any episode. */
export function seasonPassBody(seriesId: number, plan: Pick<RequestPlan, 'enableSeries' | 'seasonNumbers'>) {
  return {
    series: [{ id: seriesId, ...(plan.enableSeries ? { monitored: true as const } : {}), seasons: plan.seasonNumbers.map(seasonNumber => ({ seasonNumber, monitored: true as const })) }],
  };
}
