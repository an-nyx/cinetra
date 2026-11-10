import { posterSrc } from "@/lib/poster";
import { useEffect, useState } from "react";
import { MovieService } from "@/services";
import type { MovieWatch } from "@/services/movie.service";
import {
  Dialog,
  DialogContent,
  DialogHeader,
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

  const logWatch = async () => {
    if (!selectedMovie) return;
    setSaving(true);
    setTrackingError("");
    try {
      const watch = await MovieService.addWatch(selectedMovie);
      setWatches(current => [watch, ...current]);
      setMovie(current => ({ ...current, status: "watched" }));
      setMovies(current => current.map(item => item.id === selectedMovie ? { ...item, status: "watched" } : item));
    } catch { setTrackingError("Could not log this viewing. Please try again."); }
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
  }, [selectedMovie]);

  return (
    <Dialog open={selectedMovie?.length !== 0} onOpenChange={setOpenModal}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <DialogTitle className="pr-8 text-xl sm:text-2xl mb-2">{movie.name}</DialogTitle>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Poster Image */}
            <div className="md:col-span-1">
              <img
                src={posterSrc(movie.posterURL, "w342")}
                alt={movie.name}
                className="mx-auto w-28 rounded-xl shadow-md sm:w-full"
                onError={(e) => {
                  e.currentTarget.src = "https://via.placeholder.com/300x450?text=No+Image";
                }}
              />
            </div>

            {/* Details Section */}
            <div className="md:col-span-2 space-y-4">
              {/* Overview */}
              <div>
                <Label className="text-base font-semibold mb-2 block">
                  Overview
                </Label>
                <DialogDescription className="text-sm leading-relaxed">
                  {movie.overview && movie.overview.length > 70 ? (
                    <>
                      {showFullOverview ? movie.overview : `${movie.overview.slice(0, 70)}...`}
                      {" "}
                      <Button
                        variant="link"
                        size="sm"
                        className="px-0 h-auto inline"
                        onClick={() => setShowFullOverview(!showFullOverview)}
                      >
                        {showFullOverview ? "Read less" : "Read more"}
                      </Button>
                    </>
                  ) : (
                    movie.overview || "No overview available."
                  )}
                </DialogDescription>
              </div>
              <Separator />
              <div className="space-y-3">
                <Label className="text-base font-semibold">Your tracking</Label>
                <div className="space-y-3">
                  <div role="group" aria-label="Movie status" className="space-y-1">
                    <div className="flex items-center justify-between text-sm"><span>Status</span>{movie.status && <button type="button" disabled={saving} onClick={() => saveMovie({ status: null })} className="min-h-11 px-2 text-xs text-muted-foreground">Clear status</button>}</div>
                    <div className="flex gap-2">
                      {(['watchlist', 'watched'] as const).map(status => <button key={status} type="button" disabled={saving} aria-pressed={movie.status === status} onClick={() => saveMovie({ status })} className={`min-h-11 flex-1 rounded-full border px-4 text-sm font-medium ${movie.status === status ? 'border-emerald-300/50 bg-emerald-300/15 text-emerald-200' : 'border-white/20 bg-background text-foreground'}`}>{status === 'watchlist' ? 'Watchlist' : 'Watched'}</button>)}
                    </div>
                  </div>
                  <div role="group" aria-label="Movie rating" className="space-y-1">
                    <div className="flex items-center justify-between text-sm"><span>Your rating {movie.rating ? `· ${movie.rating}/10` : '· Not rated'}</span>{movie.rating != null && <button type="button" disabled={saving} onClick={() => saveMovie({ rating: null })} className="min-h-11 px-2 text-xs text-muted-foreground">Clear rating</button>}</div>
                    <div className="flex items-center">
                      {[1, 2, 3, 4, 5].map(star => <button key={star} type="button" disabled={saving} aria-label={`Rate ${star} ${star === 1 ? 'star' : 'stars'} (${star * 2}/10)`} aria-pressed={movie.rating === star * 2} onClick={() => saveMovie({ rating: star * 2 })} className="flex size-11 items-center justify-center text-emerald-300"><span className="relative"><Star aria-hidden="true" className="size-7" /><span className="absolute inset-0 overflow-hidden" style={{ width: `${Math.max(0, Math.min(100, ((movie.rating || 0) - (star - 1) * 2) * 50))}%` }}><Star aria-hidden="true" className="size-7 fill-emerald-300" /></span></span></button>)}
                    </div>
                    <p className="text-xs text-muted-foreground">Each star equals 2 points out of 10.</p>
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="movie-notes">Personal notes or review</Label>
                  <Textarea id="movie-notes" value={notes} onChange={event => setNotes(event.target.value)} onBlur={() => { if (notes !== (movie.notes || "")) saveMovie({ notes }); }} placeholder="Add your thoughts…" />
                </div>
                <Button type="button" variant="outline" size="sm" disabled={saving} onClick={logWatch}>Log a viewing</Button>
                {watches.length > 0 && <p className="text-xs text-muted-foreground">Watched {watches.length} {watches.length === 1 ? "time" : "times"} · Last watched {formatDate(watches[0].watchedAt)}</p>}
                {trackingError && <p role="alert" className="text-xs text-destructive">{trackingError}</p>}
              </div>
            </div>
          </div>
        </div>


        {/* Metadata and Actions */}
        <div className="mt-2">
          {/* Metadata */}
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground mb-4">
            <div className="flex items-center gap-2">
              <Calendar className="w-3 h-3" />
              <span>Added: {formatDate(movie.createdAt)}</span>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="w-3 h-3" />
              <span>Last updated: {formatDate(movie.updatedAt)}</span>
            </div>
          </div>

          <Separator className="mb-4" />

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
