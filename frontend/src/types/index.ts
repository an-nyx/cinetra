export interface ShowType {
    id: string;
    name: string;
    overview: string;
    posterURL: string;
    seasonsWatched: number;
    episodesWatched: number;
    completed: boolean;
    favorite: boolean;
    tmdbId?: number | null;
    tvmazeId?: number | null;
    status?: "watching" | "completed" | "planned" | "paused" | "dropped" | null;
    userId: string;
    createdAt: string;
    updatedAt: string;
}

export interface MovieType {
    id: string;
    name: string;
    overview?: string;
    posterURL?: string;
    favorite: boolean;
    tmdbId?: number | null;
    status?: "watchlist" | "watched" | null;
    rating?: number | null;
    notes?: string | null;
    userId: string;
    createdAt: string;
    updatedAt: string;
}

export interface UserType {
    id: string;
    username: string;
    email: string;
    createdAt: string;
    updatedAt: string;
}
