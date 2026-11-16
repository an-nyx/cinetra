import type { MovieType, ShowType } from "../types/index";

const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

const statusLabels: Record<string, string> = {
  watchlist: "Watchlist", watched: "Watched", dropped: "Dropped",
  watching: "Watching", completed: "Completed", planned: "Planned", paused: "Paused",
};

/** Search only the supplied saved library; retain saved IDs for the details dialogs. */
export function searchLibrary(movies: MovieType[], shows: ShowType[], query: string) {
  const term = normalize(query);
  if (!term) return [];
  return [
    ...movies.map(movie => ({ ...movie, kind: "movie" as const, statusLabel: statusLabels[movie.status || ""] || "No status selected" })),
    ...shows.map(show => ({ ...show, kind: "show" as const, statusLabel: statusLabels[show.status || (show.completed ? "completed" : "")] || "No status selected" })),
  ].filter(item => normalize(item.name).includes(term));
}
