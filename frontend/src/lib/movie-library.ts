/** Pure helpers for the Movies library (testable in Node). */
export type MovieStatusFilter = "watchlist" | "watched" | "dropped" | "none";
export const MOVIE_STATUS_FILTERS: MovieStatusFilter[] = ["watchlist", "watched", "dropped", "none"];

/** Which status filter a movie belongs to. Dropped is its own status and never means "removed". */
export const movieStatusOf = (movie: { status?: string | null }): MovieStatusFilter =>
  movie.status === "watchlist" || movie.status === "watched" || movie.status === "dropped" ? movie.status : "none";

/** Movies per status, for the filter menu. */
export function movieStatusCounts(movies: { status?: string | null }[]): Record<MovieStatusFilter, number> {
  const counts: Record<MovieStatusFilter, number> = { watchlist: 0, watched: 0, dropped: 0, none: 0 };
  for (const movie of movies) counts[movieStatusOf(movie)]++;
  return counts;
}

/**
 * How full each of the five stars is (0-100) for a 1-10 rating: each star is worth 2 points, so an odd rating ends on a
 * half star. Null when there is no saved rating (the card then shows no rating at all).
 */
export function ratingStars(rating: number | null | undefined): number[] | null {
  if (rating === null || rating === undefined || !Number.isFinite(rating)) return null;
  return [1, 2, 3, 4, 5].map(star => Math.max(0, Math.min(100, (rating - (star - 1) * 2) * 50)));
}
