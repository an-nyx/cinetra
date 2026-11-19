import { ApiService } from "./api.service";

type Month = { episodes: number; movieViewings: number; minutes: number };
type TitleRef = { id: string; name: string; posterURL: string | null };

/** GET /api/v1/stats: read-only statistics over the signed-in user's own library. */
export interface CinemaStats {
  generatedAt: string; today: string; timeZone: string;
  /** Lookups (catalogs, genres, runtimes) still loading when the answer was sent; retrying fills them in. */
  metadataPending: number;
  watchTime: {
    totalMinutes: number;
    tv: { minutes: number; listedMinutes: number; estimatedMinutes: number; episodesEstimated: number; episodesWithoutRuntime: number };
    movies: { minutes: number; moviesWithoutRuntime: number };
  };
  tv: {
    shows: number; watchedEpisodes: number; episodesFromRecords: number; episodesFromSavedPositions: number;
    showsStarted: number; countedShows: number; showsNotCounted: number;
    statusCounts: { watching: number; completed: number; dropped: number; none: number };
    completed: number; fullyWatched: number; caughtUp: number;
  };
  movies: { total: number; watched: number; watchlist: number; dropped: number; none: number; loggedViewings: number };
  genres: { items: { name: string; titles: number; shows: number; movies: number; minutes: number }[]; titlesWithoutGenres: number };
  ratings: {
    movies: { count: number; average: number | null; distribution: number[]; top: (TitleRef & { rating: number; status: string | null })[] };
    shows: { available: false };
  };
  years: {
    items: {
      year: number; episodes: number; movieViewings: number; distinctMovies: number; minutes: number;
      itemsWithoutRuntime: number; bulkLoggedEpisodes: number; months: Month[];
      topShows: (TitleRef & { episodes: number; minutes: number })[];
      topGenres: { name: string; titles: number; minutes: number }[];
    }[];
    undated: { savedPositionEpisodes: number; watchedMoviesWithoutViewingDate: number };
  };
}

class StatsServiceClass extends ApiService {
  async getStats(): Promise<CinemaStats> {
    let tz = "UTC";
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { /* keep UTC */ }
    const response = await this.get<CinemaStats>("/stats", { params: { tz } });
    return response.data;
  }
}

export const StatsService = new StatsServiceClass();
