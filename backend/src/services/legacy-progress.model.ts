export type SeasonMetadata = { number: number; episodeCount: number };
export type EpisodeMetadata = { season: number; number: number; airDate: string | null };
export type EpisodeCatalog = { seasons: SeasonMetadata[]; episodes: EpisodeMetadata[] };
export type ExplicitWatch = { season: number; episode: number; watchedAt?: Date | string };
export type WatchSource = 'explicit' | 'legacy' | 'both' | null;

export type LegacyCoverage = {
  covered: Set<string>;
  known: boolean;
  needsReview: boolean;
  normalizedSeason: number | null;
  normalizedEpisode: number | null;
};

export const episodeKey = (season: number, episode: number) => `${season}:${episode}`;
const regular = (episode: EpisodeMetadata) => episode.season > 0 && episode.number > 0;

/** Maps the old season/episode counters onto TMDB episodes without writing watch rows. */
export function calculateLegacyCoverage(
  seasonsWatched: number,
  episodesWatched: number,
  catalog: EpisodeCatalog | null,
  now = new Date().toISOString().slice(0, 10),
): LegacyCoverage {
  const empty = { covered: new Set<string>(), known: !!catalog, needsReview: false, normalizedSeason: null, normalizedEpisode: null };
  if (!catalog) return { ...empty, known: false };
  if (!Number.isInteger(seasonsWatched) || !Number.isInteger(episodesWatched) || seasonsWatched < 0 || episodesWatched < 0) {
    return { ...empty, needsReview: true };
  }
  if (seasonsWatched === 0 && episodesWatched === 0) return { ...empty, normalizedSeason: 1, normalizedEpisode: 1 };

  const seasons = [...catalog.seasons].filter(s => s.number > 0).sort((a, b) => a.number - b.number);
  const bySeason = new Map<number, EpisodeMetadata[]>();
  for (const episode of catalog.episodes.filter(regular)) {
    const list = bySeason.get(episode.season) || [];
    list.push(episode);
    bySeason.set(episode.season, list);
  }
  for (const list of bySeason.values()) list.sort((a, b) => a.number - b.number);

  const covered = new Set<string>();
  let needsReview = false;
  const seasonPosition = Math.max(1, seasonsWatched);
  const coverSeason = (seasonNumber: number, count: number) => {
    const declared = seasons.find(s => s.number === seasonNumber);
    const episodes = bySeason.get(seasonNumber) || [];
    if (!declared || declared.episodeCount <= 0 || episodes.length !== declared.episodeCount) needsReview = true;
    if (!declared) return;
    for (let index = 0; index < Math.min(count, episodes.length); index++) {
      const episode = episodes[index];
      if (!episode.airDate || episode.airDate <= now) covered.add(episodeKey(episode.season, episode.number));
      if (!episode.airDate || episode.airDate > now) needsReview = true;
    }
    if (episodes.some((episode, index) => index > 0 && episode.number !== episodes[index - 1].number + 1)) needsReview = true;
  };

  // Every season before the selected one is represented as completed.
  for (let number = 1; number < seasonPosition; number++) {
    const season = seasons.find(item => item.number === number);
    if (!season) { needsReview = true; continue; }
    coverSeason(number, season.episodeCount);
  }

  let normalizedSeason: number | null = null;
  let normalizedEpisode: number | null = null;
  if (episodesWatched === 0) {
    if (seasons.some(item => item.number === seasonPosition)) {
      normalizedSeason = seasonPosition;
      normalizedEpisode = 1;
    } else if (seasonPosition > 1) {
      const previous = bySeason.get(seasonPosition - 1) || [];
      if (previous.length) {
        normalizedSeason = seasonPosition - 1;
        normalizedEpisode = previous[previous.length - 1].number;
      } else needsReview = true;
    } else {
      normalizedSeason = 1;
      normalizedEpisode = 1;
    }
  } else {
    const selected = seasons.find(item => item.number === seasonsWatched);
    const selectedEpisodes = bySeason.get(seasonsWatched) || [];
    if (!selected || selected.episodeCount <= 0) needsReview = true;
    if (selected && episodesWatched > selected.episodeCount) needsReview = true;
    coverSeason(seasonsWatched, episodesWatched);

    if (selected && episodesWatched <= selected.episodeCount) {
      const seasonComplete = episodesWatched === selected.episodeCount && selected.episodeCount > 0;
      const following = seasonComplete ? seasons.find(item => item.number > seasonsWatched && item.episodeCount > 0) : undefined;
      if (following) {
        normalizedSeason = following.number;
        normalizedEpisode = 1;
      } else if (seasonComplete) {
        normalizedSeason = seasonsWatched;
        normalizedEpisode = selectedEpisodes.at(-1)?.number ?? episodesWatched;
      } else {
        normalizedSeason = seasonsWatched;
        normalizedEpisode = episodesWatched + 1;
      }
    }
  }

  return { covered, known: true, needsReview, normalizedSeason, normalizedEpisode };
}

export function mergeEpisodeWatchState<T extends EpisodeMetadata & { watchedAt: Date | null }>(
  episodes: T[],
  watches: ExplicitWatch[],
  legacy: LegacyCoverage,
) {
  const explicit = new Set(watches.map(watch => episodeKey(watch.season, watch.episode)));
  return episodes.map(episode => {
    const key = episodeKey(episode.season, episode.number);
    const hasExplicit = explicit.has(key);
    const hasLegacy = legacy.covered.has(key);
    const watchSource: WatchSource = hasExplicit && hasLegacy ? 'both' : hasExplicit ? 'explicit' : hasLegacy ? 'legacy' : null;
    return { ...episode, watched: hasExplicit || hasLegacy, watchSource };
  });
}

export function isCatalogComplete(catalog: EpisodeCatalog | null) {
  if (!catalog || !catalog.seasons.length) return false;
  const episodes = catalog.episodes.filter(regular);
  return catalog.seasons.every(season => episodes.filter(episode => episode.season === season.number).length === season.episodeCount) &&
    episodes.every(episode => !!episode.airDate);
}

export function calculateTrackingProgress<T extends EpisodeMetadata & { watched: boolean; watchSource?: WatchSource }>(
  episodes: T[],
  catalog: EpisodeCatalog | null,
  legacyNeedsReview: boolean,
  broadcastStatus: 'ended' | 'returning' | 'in_production' | 'planned' | 'unknown',
  inProduction: boolean | null,
  nextEpisodeAnnounced: boolean,
  now = new Date().toISOString().slice(0, 10),
) {
  const regularEpisodes = episodes.filter(regular);
  const releasedEpisodes = regularEpisodes.filter(episode => !!episode.airDate && episode.airDate <= now);
  const remainingEpisodes = releasedEpisodes.filter(episode => !episode.watched);
  const metadataComplete = isCatalogComplete(catalog);
  const explicitCoverageComplete = regularEpisodes.length > 0 && regularEpisodes.every(episode => episode.watchSource === 'explicit' || episode.watchSource === 'both');
  const unresolvedLegacyConflict = legacyNeedsReview && !explicitCoverageComplete;
  const finalSeason = catalog?.seasons.map(season => season.number).sort((a, b) => a - b).at(-1) ?? null;
  const finalityConfirmed = broadcastStatus === 'ended' && inProduction === false && !nextEpisodeAnnounced && metadataComplete && regularEpisodes.every(episode => !!episode.airDate && episode.airDate <= now);
  const fullyWatched = finalityConfirmed && !unresolvedLegacyConflict && regularEpisodes.length > 0 && regularEpisodes.every(episode => episode.watched && !!episode.airDate && episode.airDate <= now);
  const continuing = ['returning', 'in_production', 'planned'].includes(broadcastStatus) || nextEpisodeAnnounced;
  const progressReliable = metadataComplete && !unresolvedLegacyConflict;
  const caughtUp = !fullyWatched && continuing && progressReliable && releasedEpisodes.length > 0 && remainingEpisodes.length === 0;
  const viewingState = fullyWatched ? 'fully_watched' : caughtUp ? 'caught_up' : remainingEpisodes.length > 0 ? 'in_progress' : 'unknown';
  const progressPercent = progressReliable && releasedEpisodes.length > 0
    ? Math.round((releasedEpisodes.length - remainingEpisodes.length) / releasedEpisodes.length * 100)
    : null;
  return { regularEpisodes, releasedEpisodes, remainingEpisodes, metadataComplete, finalSeason, finalityConfirmed, fullyWatched, caughtUp, viewingState, progressPercent };
}
