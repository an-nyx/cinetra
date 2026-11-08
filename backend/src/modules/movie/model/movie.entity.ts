export interface Movie {
  id: string;
  name: string;
  overview: string | null;
  posterURL: string | null;
  favorite: boolean;
  tmdbId: number | null;
  status: string | null;
  rating: number | null;
  notes: string | null;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateMovieDto {
  name: string;
  overview?: string;
  posterURL?: string;
  favorite?: boolean;
  tmdbId?: number;
}

export interface UpdateMovieDto {
  name?: string;
  overview?: string;
  posterURL?: string;
  favorite?: boolean;
  tmdbId?: number;
  status?: string | null;
  rating?: number | null;
  notes?: string | null;
}
