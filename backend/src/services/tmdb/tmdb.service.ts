export interface SearchResult {
  id: number;
  tvmazeId?: number;
  name: string;
  overview: string;
  posterURL: string;
}

export interface TMDBService {
  searchShows(query: string): Promise<SearchResult[]>;
  searchMovies(query: string): Promise<SearchResult[]>;
}
