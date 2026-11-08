export interface Show {
  id: string;
  name: string;
  overview: string | null;
  posterURL: string | null;
  seasonsWatched: number;
  episodesWatched: number;
  completed: boolean;
  favorite: boolean;
  tmdbId: number | null;
  tvmazeId: number | null;
  status: string | null;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateShowDto {
  name: string;
  overview?: string;
  posterURL?: string;
  seasonsWatched?: number;
  episodesWatched?: number;
  completed?: boolean;
  favorite?: boolean;
  tmdbId?: number;
  tvmazeId?: number;
  status?: string;
}

export interface UpdateShowDto {
  name?: string;
  overview?: string;
  posterURL?: string;
  seasonsWatched?: number;
  episodesWatched?: number;
  completed?: boolean;
  favorite?: boolean;
  tmdbId?: number;
  tvmazeId?: number;
  status?: string | null;
}
