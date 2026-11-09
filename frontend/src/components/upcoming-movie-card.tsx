import { useState } from "react";
import { Film } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MovieService } from "@/services";
import type { MovieRelease } from "@/services/movie.service";
import { posterSrc } from "@/lib/poster";

export default function UpcomingMovieCard({ movie }: { movie: MovieRelease }) {
  const [added, setAdded] = useState(movie.inLibrary);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const add = async () => {
    setBusy(true); setError("");
    try {
      await MovieService.createMovie({ name: movie.title, overview: movie.overview, posterURL: movie.posterURL || undefined, tmdbId: movie.tmdbId });
      setAdded(true); window.dispatchEvent(new Event("movies-updated"));
    } catch { setError("Could not add this movie. It may already be in your library."); }
    finally { setBusy(false); }
  };
  return <article className="dash-card flex min-w-0 items-center gap-2.5 p-2.5">
    {movie.posterURL ? <img src={posterSrc(movie.posterURL, "w154")} alt="" className="dash-poster h-[66px] w-11" /> : <span className="dash-poster flex h-[66px] w-11 items-center justify-center"><Film className="size-4" /></span>}
    <div className="min-w-0 flex-1"><p className="break-words text-sm font-semibold leading-snug">{movie.title}{movie.date && ` (${movie.date.slice(0, 4)})`}</p>
      <p className="mt-0.5 break-words text-xs text-muted-foreground">{movie.collectionName}</p>
      <p className="mt-0.5 text-xs text-primary">{movie.date ? `${movie.date} · ${movie.releaseType} · ${movie.market}` : "Release details unconfirmed"}</p>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
    {added ? <span className="shrink-0 text-xs text-muted-foreground">In Movies</span> : <Button type="button" variant="outline" size="sm" disabled={busy} onClick={add} aria-label={`Add ${movie.title} to Movies`} className="shrink-0 text-xs">{busy ? "Adding…" : "Add"}</Button>}
  </article>;
}
