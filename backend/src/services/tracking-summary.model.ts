import {
  calculateLegacyCoverage, calculateTrackingProgress, episodeKey, isReleasedMetadataReliable, mergeEpisodeWatchState,
  type BroadcastStatus, type EpisodeCatalog, type EpisodeMetadata,
} from './legacy-progress.model';

export type CatalogEpisode = EpisodeMetadata & { name: string; airTimestamp: string | null; runtime: number | null; episodeType?: string | null };
/** Show-level TMDB details kept with the catalog so Upcoming can reuse it instead of re-downloading. */
export type CatalogMeta = {
  name: string | null; originalName: string | null; overview: string | null; firstAirDate: string | null;
  nextEpisode: { season: number; number: number; name: string; airDate: string | null } | null;
  lastAiredSeason: number | null; seasonAirDates: Record<number, string | null>;
  posterPath?: string | null;
};
export type Catalog = Omit<EpisodeCatalog, 'episodes'> & {
  episodes: CatalogEpisode[]; source: 'TMDB'; broadcastStatus: string | null; inProduction: boolean | null; nextEpisodeAnnounced: boolean;
  meta?: CatalogMeta;
};
export type TrackedShow = { id: string; name: string; posterURL: string | null; status: string | null; completed: boolean; seasonsWatched: number; episodesWatched: number; completedMonitorFrom?: Date | null };
export type WatchRecord = { season: number; episode: number; watchedAt: Date };
/** An episode explicitly marked not watched although the legacy saved position covers it (see EpisodeUnwatch). */
export type UnwatchRecord = { season: number; episode: number };

/** Map TMDB's broadcast status onto the tracking model. Unrecognised values stay "unknown" rather than being guessed. */
export function toBroadcastStatus(status: string | null | undefined): BroadcastStatus {
  switch (status) {
    case 'Ended': return 'ended';
    case 'Canceled': return 'canceled';
    case 'Returning Series': return 'returning';
    case 'In Production': return 'in_production';
    case 'Planned': return 'planned';
    default: return 'unknown';
  }
}

export type MetadataFailure = 'no_tmdb_association' | 'tmdb_auth_failed' | 'tmdb_not_found' | 'tmdb_unavailable';
export type ProgressUnavailableCode = MetadataFailure | 'saved_position_conflict' | 'incomplete_metadata' | 'no_released_episodes';
export type ProgressUnavailable = { code: ProgressUnavailableCode; label: string; detail: string };

const code = (season: number, episode: number) => `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
const regularOf = (catalog: Catalog) => catalog.episodes.filter(e => e.season > 0 && e.number > 0).sort((a, b) => a.season - b.season || a.number - b.number);

/** Plain-language reason a saved position cannot be placed on the episode list. */
export function describePositionConflict(show: TrackedShow, catalog: Catalog, today: string) {
  const { seasonsWatched: s, episodesWatched: e } = show;
  const position = code(s, e);
  if (s === 0) return `Saved position ${position} names no season, so it cannot be placed on episodes.`;
  const regular = regularOf(catalog);
  const listed = (n: number) => catalog.seasons.some(season => season.number === n);
  const missing = Array.from({ length: s - 1 }, (_, i) => i + 1).find(n => !listed(n));
  if (missing) return `Saved position ${position} implies season ${missing} was watched, but TMDB does not list season ${missing}.`;
  if (e > 0 && !listed(s)) return `Saved position ${position} names season ${s}, which TMDB does not list.`;
  const inSeason = regular.filter(ep => ep.season === s);
  if (e > inSeason.length) return `Saved position ${position} is beyond the ${inSeason.length} episodes TMDB lists for season ${s}.`;
  const covered = regular.filter(ep => ep.season < s || (ep.season === s && inSeason.indexOf(ep) < e));
  if (covered.some(ep => !ep.airDate || ep.airDate > today)) return `Saved position ${position} includes episodes that have not aired or have no air date.`;
  const incomplete = catalog.seasons.find(season => season.number <= s && regular.filter(ep => ep.season === season.number).length !== season.episodeCount);
  if (incomplete) return `TMDB's episode list for season ${incomplete.number} is incomplete, so saved position ${position} cannot be placed reliably.`;
  return `Saved position ${position} does not fit TMDB's episode list.`;
}

/** Plain-language reason released-episode metadata is not reliable. */
function describeMetadataGap(catalog: Catalog, today: string) {
  const regular = regularOf(catalog);
  if (!regular.length) return 'TMDB lists no regular episodes for this show.';
  for (const season of catalog.seasons) {
    const listed = regular.filter(ep => ep.season === season.number);
    if (listed.some(ep => !!ep.airDate && ep.airDate <= today) && listed.length !== season.episodeCount) return `TMDB says season ${season.number} has ${season.episodeCount} episodes but lists ${listed.length}.`;
  }
  const lastAired = regular.map(ep => !!ep.airDate && ep.airDate <= today).lastIndexOf(true);
  const undated = regular.slice(0, Math.max(0, lastAired)).find(ep => !ep.airDate);
  if (undated) return `${code(undated.season, undated.number)} has no air date on TMDB although later episodes have aired.`;
  return 'TMDB episode data is incomplete.';
}

type TMDBEpisodeRef = { season_number: number; episode_number: number; name?: string; air_date?: string | null };
type TMDBDetailsLike = {
  name?: string | null; original_name?: string | null; overview?: string | null; first_air_date?: string | null; poster_path?: string | null;
  status?: string | null; in_production?: boolean | null; next_episode_to_air?: TMDBEpisodeRef | null; last_episode_to_air?: TMDBEpisodeRef | null;
  seasons?: { season_number: number; episode_count: number; air_date?: string | null }[];
};
type TMDBSeasonLike = { episodes?: { episode_number: number; name?: string; air_date?: string | null; runtime?: number | null; episode_type?: string | null }[] };

/**
 * Build the catalog from TMDB show details and per-season pages. A season page that could not be loaded is tolerated
 * only when that season has not started airing (announced, undated or future): it then contributes no episodes, so an
 * announcement can never break or reduce released progress. A missing page for a season that has aired is an error.
 */
export function catalogFromTMDB(details: TMDBDetailsLike, pages: { season: number; data: TMDBSeasonLike | null }[], today: string): Catalog {
  const seasons = (details.seasons || []).filter(s => s.season_number > 0);
  for (const page of pages) {
    if (page.data) continue;
    const airDate = seasons.find(s => s.season_number === page.season)?.air_date;
    if (airDate && airDate <= today) throw new Error(`TMDB season ${page.season} could not be loaded`);
  }
  return {
    source: 'TMDB', seasons: seasons.map(s => ({ number: s.season_number, episodeCount: s.episode_count })),
    broadcastStatus: details.status || null, inProduction: typeof details.in_production === 'boolean' ? details.in_production : null, nextEpisodeAnnounced: !!details.next_episode_to_air,
    meta: {
      name: details.name || null, originalName: details.original_name || null, overview: details.overview || null, firstAirDate: details.first_air_date || null,
      nextEpisode: details.next_episode_to_air ? { season: details.next_episode_to_air.season_number, number: details.next_episode_to_air.episode_number, name: details.next_episode_to_air.name || '', airDate: details.next_episode_to_air.air_date || null } : null,
      lastAiredSeason: details.last_episode_to_air?.season_number ?? null,
      seasonAirDates: Object.fromEntries(seasons.map(s => [s.season_number, s.air_date || null])),
      posterPath: details.poster_path || null,
    },
    episodes: pages.flatMap(page => (page.data?.episodes || []).filter(e => e.episode_number > 0).map(e => ({ season: page.season, number: e.episode_number, name: e.name || '', airDate: e.air_date || null, airTimestamp: null, runtime: e.runtime || null, episodeType: e.episode_type || null }))),
  };
}

export type Checkpoint = { seasonsWatched: number; episodesWatched: number };
const releasedRegular = (catalog: Catalog, today: string) => regularOf(catalog).filter(e => !!e.airDate && e.airDate <= today);
const positionOf = (catalog: Catalog, episode: { season: number; number: number }): Checkpoint => ({
  seasonsWatched: episode.season, episodesWatched: regularOf(catalog).filter(e => e.season === episode.season && e.number <= episode.number).length,
});

/**
 * After a user marks episodes watched: advance the saved checkpoint through every released episode that directly
 * follows it and now has an individual record. Returns null when nothing should change. Never runs for shows without
 * a saved position, for positions that need review, or when released-episode metadata is unreliable.
 */
export function checkpointAfterWatch(show: TrackedShow, catalog: Catalog, watches: { season: number; episode: number }[], today: string): Checkpoint | null {
  if (show.seasonsWatched === 0 && show.episodesWatched === 0) return null;
  const legacy = calculateLegacyCoverage(show.seasonsWatched, show.episodesWatched, catalog, today);
  if (legacy.needsReview || !isReleasedMetadataReliable(catalog, today)) return null;
  const explicit = new Set(watches.map(w => episodeKey(w.season, w.episode)));
  let reached: CatalogEpisode | null = null;
  for (const episode of releasedRegular(catalog, today)) {
    const key = episodeKey(episode.season, episode.number);
    if (legacy.covered.has(key)) continue;
    if (!explicit.has(key)) break;
    reached = episode;
  }
  return reached ? positionOf(catalog, reached) : null;
}

/**
 * After a user un-marks the episode the checkpoint points at (it has an individual record and is covered by the
 * position): step the checkpoint back by exactly one episode. Returns null for any other episode.
 */
export function checkpointAfterUnwatch(show: TrackedShow, catalog: Catalog, season: number, episode: number, today: string): Checkpoint | null {
  if (show.seasonsWatched === 0 && show.episodesWatched === 0) return null;
  const legacy = calculateLegacyCoverage(show.seasonsWatched, show.episodesWatched, catalog, today);
  if (legacy.needsReview) return null;
  const covered = regularOf(catalog).filter(e => legacy.covered.has(episodeKey(e.season, e.number)));
  const last = covered[covered.length - 1];
  if (!last || last.season !== season || last.number !== episode) return null;
  const index = positionOf(catalog, last).episodesWatched;
  if (index > 1) return { seasonsWatched: season, episodesWatched: index - 1 };
  return season === 1 ? { seasonsWatched: 0, episodesWatched: 0 } : { seasonsWatched: season, episodesWatched: 0 };
}

/**
 * Saved position plus explicit records, merged per episode. A show without a saved position contributes no coverage.
 * An unwatch record removes one episode from the saved position's coverage without changing the position itself.
 */
export function mergeShowEpisodes(show: TrackedShow, catalog: Catalog | null, watches: WatchRecord[], today: string, unwatched: UnwatchRecord[] = []) {
  const watchMap = new Map(watches.map(w => [episodeKey(w.season, w.episode), w.watchedAt]));
  const hasSavedPosition = show.seasonsWatched > 0 || show.episodesWatched > 0;
  const computed = calculateLegacyCoverage(show.seasonsWatched, show.episodesWatched, catalog, today);
  const excluded = new Set(unwatched.map(u => episodeKey(u.season, u.episode)));
  const legacy = hasSavedPosition ? { ...computed, covered: new Set([...computed.covered].filter(key => !excluded.has(key))) } : { ...computed, covered: new Set<string>() };
  const episodes = mergeEpisodeWatchState((catalog?.episodes || []).map(e => ({ ...e, watchedAt: watchMap.get(episodeKey(e.season, e.number)) || null })), watches, legacy);
  return { hasSavedPosition, legacy, episodes };
}

/**
 * The tracking summary every page reads (Shows, Home, Continue watching, Details). Pure: no database or provider access.
 * The personal status is reported as-is and never used as evidence of completion.
 */
export function buildTrackingSummary(show: TrackedShow, catalog: Catalog | null, metadataError: string | null, watches: WatchRecord[], today: string, metadataFailure: MetadataFailure | null = null, unwatched: UnwatchRecord[] = []) {
  const { hasSavedPosition, legacy, episodes } = mergeShowEpisodes(show, catalog, watches, today, unwatched);
  episodes.sort((a, b) => a.season - b.season || a.number - b.number);
  const upcoming = episodes.filter(e => e.airDate && e.airDate > today).sort((a, b) => a.airDate!.localeCompare(b.airDate!));
  const last = [...episodes].filter(e => e.watchedAt).sort((a, b) => b.watchedAt!.getTime() - a.watchedAt!.getTime())[0] || null;
  const broadcastStatus = toBroadcastStatus(catalog?.broadcastStatus);
  const hasActivity = hasSavedPosition || watches.length > 0;
  const progress = calculateTrackingProgress(episodes, catalog, legacy.needsReview, broadcastStatus, catalog?.inProduction ?? null, !!catalog?.nextEpisodeAnnounced, today, hasActivity);
  const { releasedEpisodes: released, remainingEpisodes: remaining, finalSeason, finalityConfirmed, fullyWatched } = progress;
  const watched = released.length - remaining.length;
  const manualCompleted = show.status === 'completed' || (!show.status && show.completed);
  // Completed means every released episode is watched (the series may continue), so the note only flags real gaps:
  // released episodes not confirmed as watched, or episode data that cannot be loaded at all.
  const statusProgressNote = manualCompleted && !fullyWatched
    ? metadataError || !catalog ? 'Your personal status is Completed. TMDB episode data is unavailable, so completion cannot be verified.'
      : remaining.length ? `Your personal status is Completed, but ${remaining.length} released episode${remaining.length === 1 ? '' : 's'} are not confirmed as watched. Your status has not been changed.`
        : null
    : null;
  // A stored last-update boundary is a conservative upper bound for the time the personal status was set.
  // A missing boundary or incomplete metadata is ambiguous and must not produce a new-season claim.
  const monitoredAfter = show.completedMonitorFrom?.toISOString().slice(0, 10);
  const newSeasonToWatch = (() => {
    if (!manualCompleted || !catalog || !monitoredAfter || !progress.progressReliable) return null;
    for (const season of [...catalog.seasons].sort((a, b) => a.number - b.number)) {
      if (season.number <= 1) continue;
      const seasonEpisodes = episodes.filter(e => e.season === season.number && e.number > 0);
      const premiere = seasonEpisodes.find(e => e.number === 1);
      if (!premiere?.airDate || premiere.airDate < '2024-01-01' || premiere.airDate <= monitoredAfter || premiere.airDate > today) continue;
      const priorComplete = Array.from({ length: season.number - 1 }, (_, i) => i + 1).every(number => {
        const declared = catalog.seasons.find(s => s.number === number);
        const prior = episodes.filter(e => e.season === number && e.number > 0);
        return !!declared && declared.episodeCount > 0 && prior.length === declared.episodeCount && prior.every(e => e.watched && !!e.airDate && e.airDate <= today);
      });
      if (!priorComplete) continue;
      const unwatched = seasonEpisodes.filter(e => !e.watched && !!e.airDate && e.airDate <= today);
      if (unwatched.length) return { season: season.number, count: unwatched.length, episodes: unwatched.map(e => ({ number: e.number, name: e.name, airDate: e.airDate })) };
    }
    return null;
  })();
  const legacyInferredCount = episodes.filter(e => e.watchSource === 'legacy' || e.watchSource === 'both').length;
  const kept = hasSavedPosition ? ` Your saved position ${code(show.seasonsWatched, show.episodesWatched)} is kept.` : '';
  const failure = metadataFailure || (!catalog ? 'tmdb_unavailable' : null);
  const progressUnavailable: ProgressUnavailable | null = progress.progressPercent !== null ? null
    : failure === 'no_tmdb_association' ? { code: failure, label: 'No TMDB match', detail: `This show is not linked to a TMDB entry, so its episodes cannot be counted.${kept}` }
      : failure === 'tmdb_auth_failed' ? { code: failure, label: 'TMDB sign-in failed', detail: `Cinetra could not authenticate with TMDB, so episode data could not be loaded.${kept}` }
        : failure === 'tmdb_not_found' ? { code: failure, label: 'TMDB entry missing', detail: `The linked TMDB entry could not be found; the association may need review.${kept}` }
          : failure ? { code: 'tmdb_unavailable', label: 'TMDB unavailable', detail: `TMDB episode data could not be loaded right now. Try again later.${kept}` }
            // Incomplete provider data is the root cause even when it also prevents placing the saved position.
            : !progress.releasedMetadataReliable ? { code: 'incomplete_metadata', label: 'Episode data incomplete', detail: describeMetadataGap(catalog!, today) }
              : progress.unresolvedLegacyConflict ? { code: 'saved_position_conflict', label: 'Position conflict', detail: `${describePositionConflict(show, catalog!, today)} It has not been changed.` }
                : { code: 'no_released_episodes', label: 'Not aired yet', detail: 'No regular episode has aired yet.' };
  return {
    showId: show.id, name: show.name, posterURL: show.posterURL, status: show.status || (show.completed ? 'completed' : null), source: catalog?.source || null,
    guideAvailable: !!catalog && episodes.length > 0, countDataAvailable: progress.releasedMetadataReliable,
    legacyPosition: hasSavedPosition ? { fullSeasons: show.seasonsWatched, episodesInNextSeason: show.episodesWatched, normalizedSeason: legacy.normalizedSeason, normalizedEpisode: legacy.normalizedEpisode, needsReview: legacy.needsReview } : null,
    watchedCount: watched, explicitWatchedCount: watches.length, legacyInferredCount, releasedCount: released.length, remainingCount: remaining.length,
    progressPercent: progress.progressPercent, progressUnavailable, newSeasonToWatch, broadcastStatus, viewingState: progress.viewingState, completionEligible: fullyWatched, finalSeason, finalityConfirmed, metadataError, statusProgressNote,
    lastEpisode: last, nextEpisode: progress.progressReliable ? remaining[0] || null : null, upcomingEpisode: upcoming[0] || null,
    // "New" = released and unwatched, aired after your latest watch (its date, or for a saved position without
    // individual records, the air date of the latest episode it covers).
    newEpisodes: (() => {
      const since = last ? last.watchedAt!.toISOString().slice(0, 10) : released.filter(e => e.watched).map(e => e.airDate!).sort().at(-1);
      return since ? remaining.filter(e => e.airDate! > since).length : 0;
    })(),
    recentHistory: [...watches].sort((a, b) => b.watchedAt.getTime() - a.watchedAt.getTime()).slice(0, 5),
  };
}
