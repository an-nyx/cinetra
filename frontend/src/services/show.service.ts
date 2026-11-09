import { ApiService } from "./api.service";
import { ShowType } from "@/types";

interface CreateShowData {
  name: string;
  overview?: string;
  posterURL?: string;
  seasonsWatched?: number;
  episodesWatched?: number;
  completed?: boolean;
  favorite?: boolean;
  tmdbId?: number;
  status?: "watching" | "completed" | "planned" | "paused" | "dropped" | null;
}

interface UpdateShowData {
  name?: string;
  overview?: string;
  posterURL?: string;
  seasonsWatched?: number;
  episodesWatched?: number;
  completed?: boolean;
  favorite?: boolean;
  tmdbId?: number;
  status?: "watching" | "completed" | "planned" | "paused" | "dropped" | null;
}

export interface ShowSearchResult {
  id: number;
  name: string;
  overview: string;
  posterURL: string;
  originalName?: string;
  year?: string | null;
}

export interface TmdbSeriesSummary { tmdbId: number; name: string; originalName: string | null; year: string | null; overview: string | null; posterURL: string | null; seasons: number | null; releasedEpisodes: number | null }
/** Read-only comparison of a show's current TMDB match with a chosen replacement, including how progress would read. */
export interface TmdbMatchPreview {
  showId: string; unchanged: boolean; currentTmdbId: number | null; canApply: boolean;
  current: TmdbSeriesSummary | null; replacement: TmdbSeriesSummary; duplicate: { id: string; name: string } | null;
  progress: { savedPosition: string | null; positionFits: boolean; positionDetail: string | null; coveredReleasedEpisodes: number; explicitRecords: number; mappedRecords: string[]; unmappedRecords: string[]; hasProgress: boolean; needsAcknowledgement: boolean; warnings: string[] };
}

export interface EpisodeGuide {
  seasons: { number: number; episodeCount: number }[];
  season: number;
  episodes: { number: number; name: string; airDate: string | null; runtime: number | null; watchedAt: string | null; watched: boolean; watchSource: 'explicit' | 'legacy' | 'both' | null }[];
  watched: { season: number; episode: number; watchedAt: string }[];
}

export interface TrackedEpisode { season: number; number: number; name: string; airDate: string | null; runtime: number | null; watchedAt: string | null; watched?: boolean; watchSource?: 'explicit' | 'legacy' | 'both' | null }
/** One new episode from the TVMaze-only schedule. `id` (TVMaze show + episode ID) is stable across refreshes. */
export interface UpcomingRelease {
  id: string; tvmazeShowId: number; episodeId: number;
  showId: string; showName: string; posterURL: string | null; showStatus: string | null;
  season: number; number: number; name: string;
  /** TVMaze's (network-local) premiere date. */
  airDate: string;
  /** Present only when TVMaze confirms an air time; date-only releases never get one. */
  airTime: string | null; airTimestamp: string | null;
  runtime: number | null; seasonPremiere: boolean; channel: string | null; streaming: boolean; scheduleSource: 'TVMaze';
}
export interface ReturningTba { showId: string; showName: string; posterURL: string | null; showStatus: string | null; tvmazeStatus: string; announcedEpisodes: number }
export interface ScheduleReview { showId: string; showName: string; posterURL: string | null; reason: string; detail: string }
export interface UpcomingSchedule {
  status: 'ready'; source: 'TVMaze'; generatedAt: string; stale: boolean; refreshing?: boolean; progress?: { done: number; total: number };
  releases: UpcomingRelease[]; returningTba: ReturningTba[]; needsReview: ScheduleReview[];
  unavailable: { showId: string; showName: string; provider: 'TMDB' | 'TVMaze' }[];
  coverage: { evaluatedShows: number; verifiedShows: number; verifiedByExternalId: number; verifiedByTitle: number; viaScheduleOnlyTMDBMatch: number; scheduledShows: number; unresolvedShows: number; unavailableShows: number; staleShows: number; excludedEpisodes: { specials: number; past: number; undated: number; duplicates: number; repeats: number } };
}
/** A first (cold) build can take a while; the server then answers with progress instead of waiting. */
export type UpcomingResponse = UpcomingSchedule | { status: 'building'; progress: { done: number; total: number } };
export interface TrackingSummary {
  showId: string; name: string; posterURL: string | null; status: string | null; source: string | null;
  guideAvailable: boolean; countDataAvailable: boolean; legacyPosition: { fullSeasons: number; episodesInNextSeason: number; normalizedSeason?: number | null; normalizedEpisode?: number | null; needsReview?: boolean } | null;
  watchedCount: number; explicitWatchedCount: number; legacyInferredCount: number; releasedCount: number; remainingCount: number; progressPercent: number | null;
  /** Present only when no percentage can be shown: why, in a short label and one sentence. */
  progressUnavailable?: { code: string; label: string; detail: string } | null;
  broadcastStatus?: 'ended' | 'canceled' | 'returning' | 'in_production' | 'planned' | 'unknown';
  viewingState?: 'unknown' | 'fully_watched' | 'caught_up' | 'in_progress' | 'not_started' | 'needs_review';
  completionEligible?: boolean; finalSeason?: number | null; finalityConfirmed?: boolean;
  metadataError?: string | null; statusProgressNote?: string | null;
  lastEpisode: TrackedEpisode | null; nextEpisode: TrackedEpisode | null; upcomingEpisode: TrackedEpisode | null;
  newSeasonToWatch?: { season: number; count: number; episodes: { number: number; name: string; airDate: string }[] } | null;
  newEpisodes: number; recentHistory: { season: number; episode: number; watchedAt: string }[];
  error?: string | null;
}

class ShowServiceClass extends ApiService {
  async getLibraryTracking(): Promise<TrackingSummary[]> {
    const response = await this.get<TrackingSummary[]>("/show/tracking");
    return response.data;
  }

  async getUpcomingReleases(options: { refresh?: boolean; bypassCache?: boolean } = {}): Promise<UpcomingResponse> {
    const params = options.refresh ? { refresh: 1 } : options.bypassCache ? { t: Date.now() } : undefined;
    const response = await this.get<UpcomingResponse>("/show/upcoming", { timeout: 10_000, ...(params ? { params } : {}) });
    return response.data;
  }

  async getTrackingSummary(id: string): Promise<TrackingSummary> {
    const response = await this.get<TrackingSummary>(`/show/${id}/tracking`);
    return response.data;
  }

  async importLegacyProgress(id: string): Promise<TrackingSummary> {
    const response = await this.post<TrackingSummary>(`/show/${id}/import-legacy-progress`);
    return response.data;
  }
  async getAllShows(): Promise<ShowType[]> {
    const response = await this.get<ShowType[]>("/show");
    return response.data;
  }

  async getShowById(id: string): Promise<ShowType> {
    const response = await this.get<ShowType>(`/show/${id}`);
    return response.data;
  }

  async createShow(data: CreateShowData): Promise<ShowType> {
    const response = await this.post<ShowType>("/show", data);
    return response.data;
  }

  async updateShow(id: string, data: UpdateShowData): Promise<ShowType> {
    const response = await this.put<ShowType>(`/show/${id}`, data);
    return response.data;
  }

  async deleteShow(id: string): Promise<void> {
    await this.delete(`/show/${id}`);
  }

  async searchShows(query: string): Promise<ShowSearchResult[]> {
    const response = await this.get<ShowSearchResult[]>(`/show/search?q=${encodeURIComponent(query)}`);
    return response.data;
  }


  async previewTmdbMatch(id: string, tmdbId: number): Promise<TmdbMatchPreview> {
    const response = await this.get<TmdbMatchPreview>(`/show/${id}/tmdb-match?tmdbId=${tmdbId}`);
    return response.data;
  }

  /** Re-link this show only. Fails with 409 (and a fresh preview) on duplicates, concurrent edits or unacknowledged progress. */
  async applyTmdbMatch(id: string, body: { tmdbId: number; expectedCurrentTmdbId: number | null; acknowledgeProgress: boolean }): Promise<{ preview: TmdbMatchPreview; summary: TrackingSummary }> {
    const response = await this.put<{ preview: TmdbMatchPreview; summary: TrackingSummary }>(`/show/${id}/tmdb-match`, body);
    return response.data;
  }

  async getEpisodeGuide(id: string, season = 1): Promise<EpisodeGuide> {
    const response = await this.get<EpisodeGuide>(`/show/${id}/episodes?season=${season}`);
    return response.data;
  }

  async setEpisodeWatched(id: string, season: number, episode: number, watched: boolean): Promise<void> {
    await this.put(`/show/${id}/episodes/${season}/${episode}`, { watched });
  }

  async markSeasonWatched(id: string, season: number): Promise<void> {
    await this.post(`/show/${id}/seasons/${season}/watched`);
  }

  async toggleFavorite(id: string, favorite: boolean): Promise<ShowType> {
    const response = await this.put<ShowType>(`/show/${id}`, { favorite });
    return response.data;
  }

  async toggleCompleted(id: string, completed: boolean): Promise<ShowType> {
    const response = await this.put<ShowType>(`/show/${id}`, { completed });
    return response.data;
  }

  async updateSeasons(id: string, seasonsWatched: number): Promise<ShowType> {
    const response = await this.put<ShowType>(`/show/${id}`, { seasonsWatched });
    return response.data;
  }

  async updateEpisodes(id: string, episodesWatched: number): Promise<ShowType> {
    const response = await this.put<ShowType>(`/show/${id}`, { episodesWatched });
    return response.data;
  }
}

export const ShowService = new ShowServiceClass();
