import { TMDBService, SearchResult } from './tmdb.service';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { resolveTMDBRequestAuth, TMDB_AUTH_CONFIGURATION_ERROR } from './tmdb-auth';
import { sanitizeTMDBError, tmdbSecrets } from './tmdb-error';

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

export type TMDBShowDetails = { name?: string; original_name?: string; overview?: string; first_air_date?: string | null; seasons: Array<{ season_number: number; episode_count: number; air_date?: string | null; name?: string }>; status?: string; in_production?: boolean; next_episode_to_air?: { season_number: number; episode_number: number; name?: string; air_date: string } | null; last_episode_to_air?: { season_number: number; episode_number: number; air_date: string } | null };
type SeasonDetails = { episodes: Array<{ episode_number: number; name: string; air_date: string | null; runtime: number | null; episode_type?: string }> };

export class TMDBApiService implements TMDBService {
  private fetcher: AxiosInstance;
  private hasAuthentication: boolean;
  private cache = new Map<string, { expires: number; value: Promise<unknown> }>();

  private cached<T>(key: string, fetch: () => Promise<T>): Promise<T> {
    const existing = this.cache.get(key);
    if (existing && existing.expires > Date.now()) return existing.value as Promise<T>;
    const value = fetch().catch(error => { this.cache.delete(key); throw error; });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { expires: Date.now() + 5 * 60_000, value });
    return value;
  }

  private secrets: string[];

  constructor() {
    const auth = resolveTMDBRequestAuth(process.env);
    this.hasAuthentication = !!auth;
    this.secrets = tmdbSecrets(auth);
    this.fetcher = axios.create({
      baseURL: 'https://api.themoviedb.org/3',
      ...auth,
      timeout: 10000,
    })
  }

  /** Every TMDB request goes through here, so no raw Axios error (which embeds the credential) can escape. */
  private async get<T>(url: string, config?: { params?: Record<string, string | number> }) {
    if (!this.hasAuthentication) throw new Error(TMDB_AUTH_CONFIGURATION_ERROR);
    try {
      return await this.fetcher.get<T>(url, config);
    } catch (error) {
      throw sanitizeTMDBError(error, this.secrets);
    }
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
      const response = await this.cached(`search:${type}:${query.toLowerCase()}`, () => this.get<ApiResponse>(`/search/${type}`, { params: { query } }));

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

  /** Raw TV search candidates (first page) for schedule-only identity checks. Never used to create or link shows. */
  async searchTVCandidates(query: string): Promise<Array<{ id: number; name?: string; original_name?: string; overview?: string; first_air_date?: string }>> {
    query = query?.trim().slice(0, 100);
    if (!query) return [];
    const response = await this.cached(`candidates:tv:${query.toLowerCase()}`, () => this.get<{ results: Array<{ id: number; name?: string; original_name?: string; overview?: string; first_air_date?: string }> }>('/search/tv', { params: { query } }));
    return response.data.results || [];
  }

  async getShow(id: number): Promise<TMDBShowDetails> {
    const response = await this.cached<AxiosResponse<TMDBShowDetails>>(`tv:${id}`, () => this.get<TMDBShowDetails>(`/tv/${id}`));
    return response.data;
  }

  async getSeason(id: number, season: number): Promise<SeasonDetails> {
    const response = await this.cached<AxiosResponse<SeasonDetails>>(`season:${id}:${season}`, () => this.get<SeasonDetails>(`/tv/${id}/season/${season}`));
    return response.data;
  }
}
