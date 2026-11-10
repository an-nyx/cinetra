import { ApiService } from "./api.service";
import { MovieType } from "@/types";

interface CreateMovieData {
  name: string;
  overview?: string;
  posterURL?: string;
  favorite?: boolean;
  tmdbId?: number;
}

interface UpdateMovieData {
  name?: string;
  overview?: string;
  posterURL?: string;
  favorite?: boolean;
  status?: "watchlist" | "watched" | null;
  rating?: number | null;
  notes?: string | null;
}

interface MovieSearchResult {
  id: number;
  name: string;
  overview: string;
  posterURL: string;
}

export interface MovieRelease { tmdbId: number; title: string; overview: string; posterURL: string | null; collectionId: number; collectionName: string; date: string | null; market: string | null; releaseType: string | null; inLibrary: boolean }
export type MovieDiscovery = { status: "ready"; refreshing?: boolean; refreshError?: boolean; providerFailures?: number; releases: MovieRelease[]; years: Record<string, string>; verifiedMovies: number; unresolved: number; generatedAt: string } | { status: "building" };

export interface MovieInfo { year: string | null; runtime: number | null; genres: string[]; trailerUrl: string | null }

export interface MovieWatch { id: string; watchedAt: string }

class MovieServiceClass extends ApiService {
  async getUpcomingMovies(refresh = false): Promise<MovieDiscovery> {
    return (await this.get<MovieDiscovery>("/movie/upcoming", { timeout: 10_000, ...(refresh ? { params: { refresh: 1 } } : {}) })).data;
  }

  async getAllMovies(): Promise<MovieType[]> {
    const response = await this.get<MovieType[]>("/movie");
    return response.data;
  }

  async getMovieById(id: string): Promise<MovieType> {
    const response = await this.get<MovieType>(`/movie/${id}`);
    return response.data;
  }

  async getMovieInfo(id: string): Promise<MovieInfo | null> {
    return (await this.get<MovieInfo | null>(`/movie/${id}/info`)).data;
  }

  async createMovie(data: CreateMovieData): Promise<MovieType> {
    const response = await this.post<MovieType>("/movie", data);
    return response.data;
  }

  async updateMovie(id: string, data: UpdateMovieData): Promise<MovieType> {
    const response = await this.put<MovieType>(`/movie/${id}`, data);
    return response.data;
  }

  async deleteMovie(id: string): Promise<void> {
    await this.delete(`/movie/${id}`);
  }

  async searchMovies(query: string): Promise<MovieSearchResult[]> {
    const response = await this.get<MovieSearchResult[]>(`/movie/search?q=${encodeURIComponent(query)}`);
    return response.data;
  }

  async getWatches(id: string): Promise<MovieWatch[]> {
    const response = await this.get<MovieWatch[]>(`/movie/${id}/watches`);
    return response.data;
  }

  async addWatch(id: string, watchedAt?: string): Promise<MovieWatch> {
    const response = await this.post<MovieWatch>(`/movie/${id}/watches`, watchedAt ? { watchedAt } : {});
    return response.data;
  }

  async toggleFavorite(id: string, favorite: boolean): Promise<MovieType> {
    const response = await this.put<MovieType>(`/movie/${id}`, { favorite });
    return response.data;
  }
}

export const MovieService = new MovieServiceClass();
