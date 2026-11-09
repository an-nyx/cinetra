import {
  calculateLegacyCoverage, calculateTrackingProgress, episodeKey, mergeEpisodeWatchState,
  type BroadcastStatus, type EpisodeCatalog, type EpisodeMetadata,
} from './legacy-progress.model';

export type CatalogEpisode = EpisodeMetadata & { name: string; airTimestamp: string | null; runtime: number | null; episodeType?: string | null };
export type Catalog = Omit<EpisodeCatalog, 'episodes'> & {
  episodes: CatalogEpisode[]; source: 'TMDB'; broadcastStatus: string | null; inProduction: boolean | null; nextEpisodeAnnounced: boolean;
};
export type TrackedShow = { id: string; name: string; posterURL: string | null; status: string | null; completed: boolean; seasonsWatched: number; episodesWatched: number };
export type WatchRecord = { season: number; episode: number; watchedAt: Date };

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
function describePositionConflict(show: TrackedShow, catalog: Catalog, today: string) {
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

/** Saved position plus explicit records, merged per episode. A show without a saved position contributes no coverage. */
export function mergeShowEpisodes(show: TrackedShow, catalog: Catalog | null, watches: WatchRecord[], today: string) {
  const watchMap = new Map(watches.map(w => [episodeKey(w.season, w.episode), w.watchedAt]));
  const hasSavedPosition = show.seasonsWatched > 0 || show.episodesWatched > 0;
  const computed = calculateLegacyCoverage(show.seasonsWatched, show.episodesWatched, catalog, today);
  const legacy = hasSavedPosition ? computed : { ...computed, covered: new Set<string>() };
  const episodes = mergeEpisodeWatchState((catalog?.episodes || []).map(e => ({ ...e, watchedAt: watchMap.get(episodeKey(e.season, e.number)) || null })), watches, legacy);
  return { hasSavedPosition, legacy, episodes };
}

/**
 * The tracking summary every page reads (Shows, Home, Continue watching, Details). Pure: no database or provider access.
 * The personal status is reported as-is and never used as evidence of completion.
 */
export function buildTrackingSummary(show: TrackedShow, catalog: Catalog | null, metadataError: string | null, watches: WatchRecord[], today: string, metadataFailure: MetadataFailure | null = null) {
  const { hasSavedPosition, legacy, episodes } = mergeShowEpisodes(show, catalog, watches, today);
  episodes.sort((a, b) => a.season - b.season || a.number - b.number);
  const upcoming = episodes.filter(e => e.airDate && e.airDate > today).sort((a, b) => a.airDate!.localeCompare(b.airDate!));
  const last = [...episodes].filter(e => e.watchedAt).sort((a, b) => b.watchedAt!.getTime() - a.watchedAt!.getTime())[0] || null;
  const broadcastStatus = toBroadcastStatus(catalog?.broadcastStatus);
  const hasActivity = hasSavedPosition || watches.length > 0;
  const progress = calculateTrackingProgress(episodes, catalog, legacy.needsReview, broadcastStatus, catalog?.inProduction ?? null, !!catalog?.nextEpisodeAnnounced, today, hasActivity);
  const { releasedEpisodes: released, remainingEpisodes: remaining, finalSeason, finalityConfirmed, fullyWatched } = progress;
  const watched = released.length - remaining.length;
  const manualCompleted = show.status === 'completed' || (!show.status && show.completed);
  const statusProgressNote = manualCompleted && !fullyWatched
    ? metadataError || !catalog ? 'Your personal status is Completed. TMDB episode data is unavailable, so completion cannot be verified.'
      : remaining.length ? `Your personal status is Completed, but ${remaining.length} released episode${remaining.length === 1 ? '' : 's'} are not confirmed as watched. Your status has not been changed.`
        : 'Your personal status is Completed, but available metadata does not verify completion. Your status has not been changed.'
    : null;
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
    progressPercent: progress.progressPercent, progressUnavailable, broadcastStatus, viewingState: progress.viewingState, completionEligible: fullyWatched, finalSeason, finalityConfirmed, metadataError, statusProgressNote,
    lastEpisode: last, nextEpisode: progress.progressReliable ? remaining[0] || null : null, upcomingEpisode: upcoming[0] || null,
    newEpisodes: remaining.filter(e => !!last && e.airDate! > last.watchedAt!.toISOString().slice(0, 10)).length,
    recentHistory: [...watches].sort((a, b) => b.watchedAt.getTime() - a.watchedAt.getTime()).slice(0, 5),
  };
}
