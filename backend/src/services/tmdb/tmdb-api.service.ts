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
    first_air_date?: string;
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
    if (!process.env.API_AUTHORIZATION || process.env.API_AUTHORIZATION.includes('<')) {
      const response = await this.cached(`tvmaze-search:${query.toLowerCase()}`, () => axios.get<Array<{ show: { id: number; name: string; summary: string | null; image: { medium: string } | null } }>>('https://api.tvmaze.com/search/shows', { params: { q: query.trim().slice(0, 100) }, timeout: 10000 }));
      return response.data.map(({ show }) => ({ id: 0, tvmazeId: show.id, name: show.name, overview: (show.summary || '').replace(/<[^>]*>/g, ''), posterURL: show.image?.medium || '' }));
    }
    return this.search('tv', query);
  }

  async searchShowCandidates(query: string) {
    if (!process.env.API_AUTHORIZATION || process.env.API_AUTHORIZATION.includes('<')) throw new Error('TMDB credentials are unavailable');
    query = query?.trim().slice(0, 100);
    if (!query || query.length < 2) return [];
    const response = await this.cached(`review-tv:${query.toLowerCase()}`, () => this.fetcher.get<ApiResponse>('/search/tv', { params: { query } }));
    return response.data.results.slice(0, 8).map(item => ({ id: item.id, name: item.name || item.original_name || '', year: item.first_air_date?.slice(0, 4) || null, overview: item.overview || '', posterURL: item.poster_path ? `https://image.tmdb.org/t/p/w342${item.poster_path}` : null, source: 'TMDB' as const }));
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

  async getShow(id: number): Promise<{ seasons: Array<{ season_number: number; episode_count: number }> }> {
    const response = await this.cached(`tv:${id}`, () => this.fetcher.get(`/tv/${id}`));
    return response.data;
  }

  async getSeason(id: number, season: number): Promise<{ episodes: Array<{ episode_number: number; name: string; air_date: string | null; runtime: number | null }> }> {
    const response = await this.cached(`season:${id}:${season}`, () => this.fetcher.get(`/tv/${id}/season/${season}`));
    return response.data;
  }
}
