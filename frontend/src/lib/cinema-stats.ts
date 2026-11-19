/** Pure presentation helpers for My Cinema Stats (testable in Node). They never change or infer data. */

/** Whole hours and leftover minutes of an estimated duration. */
export function splitDuration(minutes: number): { hours: number; minutes: number; days: number } {
  const total = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
  return { hours: Math.floor(total / 60), minutes: total % 60, days: Math.floor(total / 1440) };
}

/** Bar length in percent of the largest value. A non-zero value always stays visible (at least 3%). */
export function barPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(3, Math.min(100, Math.round(value / max * 100)));
}

/** Share of the whole in percent (0-100), rounded; 0 when there is no whole. */
export function sharePercent(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0 || part <= 0) return 0;
  return Math.min(100, Math.round(part / whole * 100));
}

/** The year to show: the remembered one if it still has records, otherwise the most recent year with records. */
export function pickYear(years: number[], preferred: number | null): number | null {
  if (preferred !== null && years.includes(preferred)) return preferred;
  return years.length ? Math.max(...years) : null;
}

export type GenreSort = "time" | "titles";
/** Genres ranked by estimated watch time or by number of titles; ties by the other measure, then by name. */
export function rankGenres<T extends { name: string; titles: number; minutes: number }>(items: T[], by: GenreSort, limit = 8): T[] {
  return [...items].sort((a, b) => by === "time"
    ? b.minutes - a.minutes || b.titles - a.titles || a.name.localeCompare(b.name)
    : b.titles - a.titles || b.minutes - a.minutes || a.name.localeCompare(b.name)).slice(0, limit);
}

/** Whether a library has anything to show at all (otherwise the page shows its empty state). */
export function hasAnyStats(stats: { tv: { shows: number }; movies: { total: number } }): boolean {
  return stats.tv.shows > 0 || stats.movies.total > 0;
}
