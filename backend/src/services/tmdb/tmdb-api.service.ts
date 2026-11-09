import { TMDBService, SearchResult } from './tmdb.service';
import axios, { AxiosInstance } from 'axios';

interface ApiResponse {
  results: Array<{
    id: number;
    title?: string;
    name?: string;
    overview: string;
    poster_path: string;
    original_name?: string;
    original_title?: string;
  }>;
}

export class TMDBApiService implements TMDBService {
  private fetcher: AxiosInstance;
  private cache = new Map<string, { expires: number; value: Promise<unknown> }>();

  private cached<T>(key: string, fetch: () => Promise<T>): Promise<T> {
    const existing = this.cache.get(key);
    if (existing && existing.expires > Date.now()) return existing.value as Promise<T>;
    const value = fetch().catch(error => { this.cache.delete(key); throw error; });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { expires: Date.now() + 5 * 60_000, value });
    return value;
  }

  constructor() {
    this.fetcher = axios.create({
      baseURL: 'https://api.themoviedb.org/3',
      headers: {
        Authorization: process.env.API_AUTHORIZATION,
      },
      timeout: 10000,
    })
  }

  async searchShows(query: string): Promise<SearchResult[]> {
    return this.search('tv', query);
  }

  async searchMovies(query: string): Promise<SearchResult[]> {
    return this.search('movie', query);
  }

  private async search(type: 'tv' | 'movie', query: string): Promise<SearchResult[]> {
    query = query?.trim().slice(0, 100);
    if (!query || query.length < 2) {
      return [];
    }

    try {
      const response = await this.cached(`search:${type}:${query.toLowerCase()}`, () => this.fetcher.get<ApiResponse>(`/search/${type}`, { params: { query } }));

      const searchResults: SearchResult[] = response.data.results.map(
        ({ id, title, name, overview, poster_path }) => {
          return ({
            id,
            name: name || title || '',
            overview,
            posterURL: poster_path ? `https://image.tmdb.org/t/p/w500${poster_path}` : '',
          })
        }
      );

      return searchResults;
    } catch (err) {
      console.error('TMDB API Error:', axios.isAxiosError(err) ? `HTTP ${err.response?.status ?? 'network error'}` : 'Unexpected error');
      throw err;
    }
  }

  async getShow(id: number): Promise<{ seasons: Array<{ season_number: number; episode_count: number; air_date?: string | null; name?: string }>; status?: string; in_production?: boolean; next_episode_to_air?: { season_number: number; episode_number: number; air_date: string } | null; last_episode_to_air?: { season_number: number; episode_number: number; air_date: string } | null }> {
    const response = await this.cached(`tv:${id}`, () => this.fetcher.get(`/tv/${id}`));
    return response.data;
  }

  async getSeason(id: number, season: number): Promise<{ episodes: Array<{ episode_number: number; name: string; air_date: string | null; runtime: number | null; episode_type?: string }> }> {
    const response = await this.cached(`season:${id}:${season}`, () => this.fetcher.get(`/tv/${id}/season/${season}`));
    return response.data;
  }
}
