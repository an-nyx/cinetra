import { openTitle, favoriteTitle } from "@/i18n/labels";
import { phrase, useLanguage } from "@/i18n";
import { Heart, Film } from "lucide-react";
import { posterSrc } from "@/lib/poster";
import { MovieType } from "@/types";
import { MovieService } from "@/services";

interface MovieProps {
  id: string;
  name: string;
  favorite: boolean;
  posterURL?: string;
  status?: "watchlist" | "watched" | null;
  year?: string;
  setSelectedMovie: React.Dispatch<React.SetStateAction<string>>;
  movies: MovieType[];
  setMovies: React.Dispatch<React.SetStateAction<MovieType[]>>;
}

export default function Movie({
  id,
  name,
  favorite,
  posterURL,
  status,
  year,
  setSelectedMovie,
  movies,
  setMovies,
}: MovieProps) {
  const { language } = useLanguage();
  const toggleFavorite = async (id: string, favorite: boolean) => {
    try {
      await MovieService.toggleFavorite(id, !favorite);

      setMovies(
        movies.map((movie) => {
          if (movie.id !== id) return movie;

          return { ...movie, favorite: !favorite };
        }),
      );
    } catch (error) {
      console.error("error occurred while toggling movie favorite button", error);
    }
  };

  return (
    <article className={`group relative min-w-0 overflow-hidden rounded-xl border bg-card/60 ${status === "watched" ? "border-primary/25" : "border-border"}`}>
      <button type="button" className="compact-movie-poster relative block w-full overflow-hidden bg-muted text-left focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-primary" onClick={() => setSelectedMovie(id)} aria-label={openTitle(language, name)}>
        <span className="absolute inset-0 flex items-center justify-center text-muted-foreground"><Film className="size-8" /></span>
        {posterURL && <img loading="lazy" className="relative h-full w-full object-cover" src={posterSrc(posterURL, "w342")} decoding="async" alt="" onError={(event) => { event.currentTarget.style.display = "none"; }} />}
      </button>
      <button type="button" onClick={() => setSelectedMovie(id)} className="block h-[3.1rem] w-full min-w-0 px-2 py-1 text-left">
        <span className="block truncate text-sm font-semibold leading-5" title={name}><bdi>{name}</bdi></span>
        <span className="block truncate text-xs text-muted-foreground">{[year, status === "watched" ? phrase(language, "Watched") : status === "watchlist" ? phrase(language, "Watchlist") : null].filter(Boolean).join(" · ") || " "}</span>
      </button>
      <button type="button" className="absolute right-1.5 top-1.5 flex size-10 items-center justify-center rounded-full bg-black/65 text-white focus-visible:outline-2 focus-visible:outline-primary" aria-label={favoriteTitle(language, name, favorite)} aria-pressed={favorite} onClick={() => toggleFavorite(id, favorite)}>
        <Heart className={`size-5 ${favorite ? "fill-rose-400 text-rose-400" : ""}`} />
      </button>
    </article>
  );
}
