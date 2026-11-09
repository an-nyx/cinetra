import { Heart, Film } from "lucide-react";
import { posterSrc } from "@/lib/poster";
import { MovieType } from "@/types";
import { MovieService } from "@/services";

interface MovieProps {
  id: string;
  name: string;
  favorite: boolean;
  posterURL?: string;
  setSelectedMovie: React.Dispatch<React.SetStateAction<string>>;
  movies: MovieType[];
  setMovies: React.Dispatch<React.SetStateAction<MovieType[]>>;
}

export default function Movie({
  id,
  name,
  favorite,
  posterURL,
  setSelectedMovie,
  movies,
  setMovies,
}: MovieProps) {
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
    <article className="group relative min-w-0">
      <button
        type="button"
        className="cinema-poster relative block aspect-[2/3] w-full overflow-hidden rounded-2xl border border-white/10 bg-muted text-left transition-[transform,box-shadow,border-color] duration-300 group-hover:-translate-y-1 group-hover:border-primary/40 group-hover:shadow-[0_20px_45px_rgba(0,0,0,0.35)] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary motion-reduce:transform-none"
        onClick={() => setSelectedMovie(id)}
        aria-label={`Open ${name}`}
      >
        <span className="absolute inset-0 flex items-center justify-center text-muted-foreground"><Film className="size-10" /></span>
        {posterURL && <img loading="lazy" className="relative h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04] motion-reduce:transform-none" src={posterSrc(posterURL, "w342")} decoding="async" alt="" onError={(event) => { event.currentTarget.style.display = "none"; }} />}
        <span className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/10 to-transparent" />
        <span className="absolute inset-x-0 bottom-0 line-clamp-2 p-3 pb-4 text-sm font-semibold leading-5 text-white sm:text-base">{name}</span>
      </button>
      <button
        type="button"
        className="absolute right-2 top-2 flex size-11 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-colors hover:bg-black/65 focus-visible:outline-2 focus-visible:outline-primary"
        aria-label={`${favorite ? "Remove" : "Add"} ${name} ${favorite ? "from" : "to"} favorites`}
        aria-pressed={favorite}
        onClick={() => toggleFavorite(id, favorite)}
      >
        <Heart className={`size-5 ${favorite ? "fill-rose-400 text-rose-400" : ""}`} />
      </button>
    </article>
  );
}
