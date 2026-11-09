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

interface ShowSearchResult {
  id: number;
  name: string;
  overview: string;
  posterURL: string;
}

export interface EpisodeGuide {
  seasons: { number: number; episodeCount: number }[];
  season: number;
  episodes: { number: number; name: string; airDate: string | null; runtime: number | null; watchedAt: string | null }[];
  watched: { season: number; episode: number; watchedAt: string }[];
}

export interface TrackedEpisode { season: number; number: number; name: string; airDate: string | null; runtime: number | null; watchedAt: string | null }
export interface UpcomingRelease {
  showId: string; showName: string; posterURL: string | null; showStatus: string | null;
  season: number; number: number; name: string; airDate: string; airTimestamp: string | null; seasonPremiere: boolean;
}
export interface TrackingSummary {
  showId: string; name: string; posterURL: string | null; status: string | null; source: string | null;
  guideAvailable: boolean; legacyPosition: { fullSeasons: number; episodesInNextSeason: number; normalizedSeason?: number; normalizedEpisode?: number; needsReview?: boolean } | null;
  watchedCount: number; releasedCount: number; remainingCount: number; progressPercent: number | null;
  broadcastStatus?: 'ended' | 'returning' | 'in_production' | 'planned' | 'unknown';
  viewingState?: 'unknown' | 'fully_watched' | 'caught_up' | 'in_progress' | 'not_started';
  completionEligible?: boolean; finalSeason?: number | null; finalityConfirmed?: boolean;
  lastEpisode: TrackedEpisode | null; nextEpisode: TrackedEpisode | null; upcomingEpisode: TrackedEpisode | null;
  newEpisodes: number; recentHistory: { season: number; episode: number; watchedAt: string }[];
  error?: string | null;
}

class ShowServiceClass extends ApiService {
  async getLibraryTracking(): Promise<TrackingSummary[]> {
    const response = await this.get<TrackingSummary[]>("/show/tracking");
    return response.data;
  }

  async getUpcomingReleases(): Promise<{ releases: UpcomingRelease[]; failedShows: number }> {
    const response = await this.get<{ releases: UpcomingRelease[]; failedShows: number }>("/show/upcoming");
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
