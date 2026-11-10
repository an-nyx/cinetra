import { posterSrc } from "@/lib/poster";
import { useEffect, useState } from "react";
import { MovieService } from "@/services";
import type { MovieInfo, MovieWatch } from "@/services/movie.service";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { MovieType } from "@/types/index.ts";
import { Trash2, Calendar, Clock, Star } from "lucide-react";

interface MovieModalProps {
  selectedMovie: string | null;
  closeModal: () => void;
  movies: MovieType[];
  setMovies: React.Dispatch<React.SetStateAction<MovieType[]>>;
}

export default function MovieModal({
  selectedMovie,
  closeModal,
  movies,
  setMovies,
}: MovieModalProps) {
  const [movie, setMovie] = useState<MovieType>({
    id: "",
    name: "",
    overview: "",
    posterURL: "",
    favorite: false,
    userId: "",
    updatedAt: "",
    createdAt: "",
  });
  const [showFullOverview, setShowFullOverview] = useState(false);
  const [info, setInfo] = useState<MovieInfo | null>(null);
  const [watches, setWatches] = useState<MovieWatch[]>([]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [trackingError, setTrackingError] = useState("");

  const saveMovie = async (changes: { status?: "watchlist" | "watched" | null; rating?: number | null; notes?: string }) => {
    if (!selectedMovie) return;
    setSaving(true);
    setTrackingError("");
    try {
      const updated = await MovieService.updateMovie(selectedMovie, changes);
      setMovie(updated);
      setMovies(current => current.map(item => item.id === updated.id ? updated : item));
    } catch { setTrackingError("Could not save movie details. Please try again."); }
    finally { setSaving(false); }
  };

  const deleteMovie = async () => {
    if (!selectedMovie) return;

    try {
      await MovieService.deleteMovie(selectedMovie);
      setMovies(movies.filter((m) => m.id !== selectedMovie));
      closeModal();
    } catch (error) {
      console.error("Error deleting movie", error);
    }
  };

  const setOpenModal = (value: boolean) => {
    if (value === false) closeModal();
  };

  const formatDate = (dateString: string) => {
    if (!dateString) return "N/A";
    const date = new Date(dateString);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  useEffect(() => {
    if (!selectedMovie) return;
    setShowFullOverview(false);
    setInfo(null);
    let active = true;
    MovieService.getMovieInfo(selectedMovie).then(result => { if (active) setInfo(result); }).catch(() => {});

    const loadMovie = async () => {
      try {
        const movieData = await MovieService.getMovieById(selectedMovie);
        setMovie(movieData);
        setNotes(movieData.notes || "");
        setWatches(await MovieService.getWatches(selectedMovie));
      } catch (error) {
        console.error("Error loading movie", error);
      }
    };

    loadMovie();
    return () => { active = false; };
  }, [selectedMovie]);

  return (
    <Dialog open={selectedMovie?.length !== 0} onOpenChange={setOpenModal}>
      <DialogContent className="max-w-2xl gap-3 p-4 sm:p-6">
        <div className="flex min-w-0 items-start gap-3 pr-10">
          <img src={posterSrc(movie.posterURL, "w342")} alt="" className="h-24 w-16 shrink-0 rounded-lg object-cover shadow-md" onError={(e) => { e.currentTarget.src = "https://via.placeholder.com/300x450?text=No+Image"; }} />
          <div className="min-w-0 pt-1"><DialogTitle className="text-left text-xl leading-tight">{movie.name}</DialogTitle></div>
        </div>
        <div>
          <Label className="mb-1 block text-sm font-semibold">Overview</Label>
          <DialogDescription className={`text-sm leading-snug ${showFullOverview ? '' : 'line-clamp-2'}`}>{movie.overview || "No overview available."}</DialogDescription>
          {movie.overview && <button type="button" onClick={() => setShowFullOverview(!showFullOverview)} className="min-h-11 text-sm font-medium text-emerald-300">{showFullOverview ? "Read less" : "Read more"}</button>}
        </div>
        <Separator />
        <div className="space-y-2">
          <Label className="text-base font-semibold">Your tracking</Label>
          <div className="space-y-1">
            <div role="group" aria-label="Movie status" className="space-y-0">
              <div className="flex min-h-11 items-center justify-between text-sm"><span>Status</span>{movie.status && <button type="button" disabled={saving} onClick={() => saveMovie({ status: null })} className="min-h-11 px-2 text-xs text-muted-foreground">Clear status</button>}</div>
              <div className="flex gap-2">
                {(['watchlist', 'watched'] as const).map(status => <button key={status} type="button" disabled={saving} aria-pressed={movie.status === status} onClick={() => saveMovie({ status })} className={`min-h-11 flex-1 rounded-full border px-4 text-sm font-medium ${movie.status === status ? 'border-emerald-300/50 bg-emerald-300/15 text-emerald-200' : 'border-white/20 bg-background text-foreground'}`}>{status === 'watchlist' ? 'Watchlist' : 'Watched'}</button>)}
              </div>
            </div>
            <div role="group" aria-label="Movie rating" className="space-y-0">
              <div className="flex min-h-11 items-center justify-between text-sm"><span>Your rating {movie.rating ? `· ${movie.rating}/10` : '· Not rated'}</span>{movie.rating != null && <button type="button" disabled={saving} onClick={() => saveMovie({ rating: null })} className="min-h-11 px-2 text-xs text-muted-foreground">Clear rating</button>}</div>
              <div className="flex items-center">
                {[1, 2, 3, 4, 5].map(star => <button key={star} type="button" disabled={saving} aria-label={`Rate ${star} ${star === 1 ? 'star' : 'stars'} (${star * 2}/10)`} aria-pressed={movie.rating === star * 2} onClick={() => saveMovie({ rating: star * 2 })} className="flex size-11 items-center justify-center text-emerald-300"><span className="relative"><Star aria-hidden="true" className="size-7" /><span className="absolute inset-0 overflow-hidden" style={{ width: `${Math.max(0, Math.min(100, ((movie.rating || 0) - (star - 1) * 2) * 50))}%` }}><Star aria-hidden="true" className="size-7 fill-emerald-300" /></span></span></button>)}
              </div>
              <p className="sr-only">Each star equals 2 points out of 10.</p>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="movie-notes">Personal notes or review</Label>
            <Textarea className="min-h-11 h-11 resize-y focus:h-24" id="movie-notes" value={notes} onChange={event => setNotes(event.target.value)} onBlur={() => { if (notes !== (movie.notes || "")) saveMovie({ notes }); }} placeholder="Add your thoughts…" />
          </div>
          {info && (info.year || info.runtime || info.genres.length > 0 || info.trailerUrl) && <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {[info.year, info.runtime ? `${info.runtime} min` : null, info.genres.join(', ') || null].filter(Boolean).map((item, index) => <span key={index}>{index > 0 && <span aria-hidden="true" className="mr-2">·</span>}{item}</span>)}
            {info.trailerUrl && <a href={info.trailerUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-emerald-300 hover:underline">Watch trailer<span className="sr-only"> (opens in a new tab)</span></a>}
          </div>}
          {watches.length > 0 && <p className="text-xs text-muted-foreground">Watched {watches.length} {watches.length === 1 ? "time" : "times"} · Last watched {formatDate(watches[0].watchedAt)}</p>}
          {trackingError && <p role="alert" className="text-xs text-destructive">{trackingError}</p>}
        </div>

        {/* Metadata and Actions */}
        <div>
          {/* Metadata */}
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground mb-3">
            <div className="flex items-center gap-2">
              <Calendar className="w-3 h-3" />
              <span>Added: {formatDate(movie.createdAt)}</span>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="w-3 h-3" />
              <span>Last updated: {formatDate(movie.updatedAt)}</span>
            </div>
          </div>

          <Separator className="mb-3" />

          {/* Action Buttons */}
          <div className="flex flex-wrap gap-2">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" className="flex-1">
                  <Trash2 className="w-4 h-4 mr-2" />
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This action cannot be undone. This will permanently delete the movie
                    &ldquo;{movie.name}&rdquo; from your collection.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={deleteMovie}>
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
