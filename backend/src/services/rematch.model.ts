import { calculateLegacyCoverage, episodeKey } from './legacy-progress.model';
import { describePositionConflict, type Catalog, type TrackedShow } from './tracking-summary.model';

/**
 * How a show's existing progress would read against a replacement TMDB series. Pure; nothing is changed.
 *
 * Progress is stored as season/episode numbers, so after a rematch those numbers refer to the replacement series.
 * This analysis makes that interpretation explicit: it says which parts map to real episodes of the replacement and
 * which do not. Nothing is ever converted, renumbered or deleted; parts that do not map stay stored and need review.
 */
export type RematchProgress = {
  savedPosition: string | null;
  positionFits: boolean;
  positionDetail: string | null;
  coveredReleasedEpisodes: number;
  explicitRecords: number;
  mappedRecords: string[];
  unmappedRecords: string[];
  hasProgress: boolean;
  /** True when some existing progress does not map onto the replacement: the user must acknowledge it explicitly. */
  needsAcknowledgement: boolean;
  warnings: string[];
};

const code = (season: number, episode: number) => `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;

export function analyzeRematchProgress(show: TrackedShow, watches: { season: number; episode: number }[], replacement: Catalog, today: string): RematchProgress {
  const hasPosition = show.seasonsWatched > 0 || show.episodesWatched > 0;
  const legacy = calculateLegacyCoverage(show.seasonsWatched, show.episodesWatched, replacement, today);
  const positionFits = !hasPosition || !legacy.needsReview;
  const released = new Set(replacement.episodes.filter(e => e.season > 0 && e.number > 0 && !!e.airDate && e.airDate <= today).map(e => episodeKey(e.season, e.number)));
  const coveredReleased = hasPosition ? [...legacy.covered].filter(key => released.has(key)).length : 0;
  const known = new Set(replacement.episodes.filter(e => e.season > 0 && e.number > 0).map(e => episodeKey(e.season, e.number)));
  const records = [...new Map(watches.map(w => [episodeKey(w.season, w.episode), w])).values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
  const mapped = records.filter(w => known.has(episodeKey(w.season, w.episode))).map(w => code(w.season, w.episode));
  const unmapped = records.filter(w => !known.has(episodeKey(w.season, w.episode))).map(w => code(w.season, w.episode));
  const position = hasPosition ? code(show.seasonsWatched, show.episodesWatched) : null;

  const warnings: string[] = [];
  if (hasPosition && !positionFits) warnings.push(`${describePositionConflict(show, replacement, today)} It will be kept as it is and marked for review; correct it with Edit progress.`);
  if (unmapped.length) warnings.push(`${unmapped.length} individually logged episode${unmapped.length === 1 ? '' : 's'} (${unmapped.slice(0, 6).join(', ')}${unmapped.length > 6 ? ', …' : ''}) do${unmapped.length === 1 ? 'es' : ''} not exist in the replacement series. ${unmapped.length === 1 ? 'It is' : 'They are'} kept but will not count.`);

  return {
    savedPosition: position, positionFits,
    positionDetail: !hasPosition ? null : positionFits
      ? `Saved position ${position} will count as ${coveredReleased} released episode${coveredReleased === 1 ? '' : 's'} of the replacement series.`
      : describePositionConflict(show, replacement, today),
    coveredReleasedEpisodes: coveredReleased, explicitRecords: records.length, mappedRecords: mapped, unmappedRecords: unmapped,
    hasProgress: hasPosition || records.length > 0,
    needsAcknowledgement: (hasPosition && !positionFits) || unmapped.length > 0,
    warnings,
  };
}

export type SeriesSummary = { tmdbId: number; name: string; originalName: string | null; year: string | null; overview: string | null; posterURL: string | null; seasons: number | null; releasedEpisodes: number | null };

/**
 * Describe a TMDB series for the Edit show comparison.
 * - "current": the series the library entry is linked to now; it may fall back to the entry's own saved poster and
 *   overview, which belong to that entry.
 * - "replacement": only TMDB's own data for that exact series. A missing poster or overview stays empty (the page shows
 *   a neutral placeholder); another show's poster or text is never substituted, so it cannot be saved either.
 */
export function summarizeSeries(tmdbId: number, catalog: Catalog | null, role: 'current' | 'replacement', saved: { name: string; posterURL: string | null; overview: string | null }, today: string): SeriesSummary {
  const meta = catalog?.meta;
  const own = role === 'current';
  return {
    tmdbId, name: meta?.name || saved.name, originalName: meta?.originalName ?? null, year: (meta?.firstAirDate || '').slice(0, 4) || null,
    overview: meta?.overview || (own ? saved.overview : null) || null,
    posterURL: meta?.posterPath ? `https://image.tmdb.org/t/p/w500${meta.posterPath}` : own ? saved.posterURL : null,
    seasons: catalog ? catalog.seasons.filter(s => s.number > 0).length : null,
    releasedEpisodes: catalog ? catalog.episodes.filter(e => e.season > 0 && e.number > 0 && !!e.airDate && e.airDate <= today).length : null,
  };
}
