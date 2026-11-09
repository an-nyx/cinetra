import type { MovieRelease } from "../services/movie.service";
import { dayKey, weekBounds, type CalendarFilter } from "./upcoming-calendar.ts";

export function filterMovieReleases(releases: MovieRelease[], filter: CalendarFilter, now: Date) {
  const today = dayKey(now);
  const [start, end] = weekBounds(now);
  return releases.filter(item => {
    const date = item.date;
    if (!date || date < today || filter === "premieres") return false;
    if (filter === "today") return date === today;
    if (filter === "week") return date >= start && date < end;
    if (filter === "month") return date.slice(0, 7) === today.slice(0, 7);
    return true;
  });
}
