export interface SearchResult {
  id: number;
  name: string;
  overview: string;
  posterURL: string;
  originalName?: string;
  year?: string | null;
}

export interface TMDBService {
  searchShows(query: string): Promise<SearchResult[]>;
  searchMovies(query: string): Promise<SearchResult[]>;
}
