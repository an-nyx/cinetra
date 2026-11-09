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
export function buildTrackingSummary(show: TrackedShow, catalog: Catalog | null, metadataError: string | null, watches: WatchRecord[], today: string) {
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
  return {
    showId: show.id, name: show.name, posterURL: show.posterURL, status: show.status || (show.completed ? 'completed' : null), source: catalog?.source || null,
    guideAvailable: !!catalog && episodes.length > 0, countDataAvailable: progress.releasedMetadataReliable,
    legacyPosition: hasSavedPosition ? { fullSeasons: show.seasonsWatched, episodesInNextSeason: show.episodesWatched, normalizedSeason: legacy.normalizedSeason, normalizedEpisode: legacy.normalizedEpisode, needsReview: legacy.needsReview } : null,
    watchedCount: watched, explicitWatchedCount: watches.length, legacyInferredCount, releasedCount: released.length, remainingCount: remaining.length,
    progressPercent: progress.progressPercent, broadcastStatus, viewingState: progress.viewingState, completionEligible: fullyWatched, finalSeason, finalityConfirmed, metadataError, statusProgressNote,
    lastEpisode: last, nextEpisode: progress.progressReliable ? remaining[0] || null : null, upcomingEpisode: upcoming[0] || null,
    newEpisodes: remaining.filter(e => !!last && e.airDate! > last.watchedAt!.toISOString().slice(0, 10)).length,
    recentHistory: [...watches].sort((a, b) => b.watchedAt.getTime() - a.watchedAt.getTime()).slice(0, 5),
  };
}
