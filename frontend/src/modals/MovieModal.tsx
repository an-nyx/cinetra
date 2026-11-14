import { movieWatchHistory, ratingLabel } from "@/i18n/tracking";
import { T, phrase, useLanguage } from "@/i18n";
import { useLocalizedOverview } from "@/hooks/use-localized-overview";
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
  const { language } = useLanguage();
  const localizedOverview = useLocalizedOverview("movie", selectedMovie, movie.overview);
  const [showFullOverview, setShowFullOverview] = useState(false);
  const [info, setInfo] = useState<MovieInfo | null>(null);
  const [watches, setWatches] = useState<MovieWatch[]>([]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [trackingError, setTrackingError] = useState("");

  const saveMovie = async (changes: { status?: "watchlist" | "watched" | "dropped" | null; rating?: number | null; notes?: string }) => {
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
    return date.toLocaleDateString(language === "ar" ? "ar" : language === "fr" ? "fr-FR" : "en-US", {
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
          <div className="min-w-0 pt-1"><DialogTitle className="text-left text-xl leading-tight"><bdi>{movie.name}</bdi></DialogTitle></div>
        </div>
        <div>
          <Label className="mb-1 block text-sm font-semibold"><T>Overview</T></Label>
          <DialogDescription className={`text-sm leading-snug ${showFullOverview ? '' : 'line-clamp-2'}`}>{localizedOverview.loading ? phrase(language, "Loading description…") : localizedOverview.overview || phrase(language, language === "en" ? "No overview available." : "Description unavailable in this language.")}</DialogDescription>
          {localizedOverview.overview && <button type="button" onClick={() => setShowFullOverview(!showFullOverview)} className="min-h-11 text-sm font-medium text-emerald-300">{phrase(language, showFullOverview ? "Read less" : "Read more")}</button>}
        </div>
        <Separator />
        <div className="space-y-2">
          <Label className="text-base font-semibold"><T>Your tracking</T></Label>
          <div className="space-y-1">
            <div role="group" aria-label={phrase(language, "Movie status")} className="space-y-0">
              <div className="flex min-h-11 items-center justify-between text-sm"><span><T>Status</T></span>{movie.status && <button type="button" disabled={saving} onClick={() => saveMovie({ status: null })} className="min-h-11 px-2 text-xs text-muted-foreground"><T>Clear status</T></button>}</div>
              <div className="grid grid-cols-3 gap-2">
                {(['watchlist', 'watched', 'dropped'] as const).map(status => {
                  const selected = movie.status === status;
                  // Dropped reads as a quiet muted red, never as an alarm: the movie stays in the library.
                  const tone = !selected ? 'border-white/20 bg-background text-foreground'
                    : status === 'dropped' ? 'border-rose-300/40 bg-rose-400/10 text-rose-200' : 'border-emerald-300/50 bg-emerald-300/15 text-emerald-200';
                  return <button key={status} type="button" disabled={saving} aria-pressed={selected} onClick={() => saveMovie({ status })} className={`min-h-11 min-w-0 truncate rounded-full border px-2 text-sm font-medium sm:px-4 ${tone}`}>{phrase(language, status === 'watchlist' ? 'Watchlist' : status === 'watched' ? 'Watched' : 'Dropped')}</button>;
                })}
              </div>
            </div>
            <div role="group" aria-label={phrase(language, "Movie rating")} className="space-y-0">
              <div className="flex min-h-11 items-center justify-between text-sm"><span><T>Your rating</T> {movie.rating ? `· ${movie.rating}/10` : `· ${phrase(language, 'Not rated')}`}</span>{movie.rating != null && <button type="button" disabled={saving} onClick={() => saveMovie({ rating: null })} className="min-h-11 px-2 text-xs text-muted-foreground"><T>Clear rating</T></button>}</div>
              <div className="flex items-center">
                {[1, 2, 3, 4, 5].map(star => <button key={star} type="button" disabled={saving} aria-label={ratingLabel(language, star)} aria-pressed={movie.rating === star * 2} onClick={() => saveMovie({ rating: star * 2 })} className="flex size-11 items-center justify-center text-emerald-300"><span className="relative"><Star aria-hidden="true" className="size-7" /><span className="absolute inset-0 overflow-hidden" style={{ width: `${Math.max(0, Math.min(100, ((movie.rating || 0) - (star - 1) * 2) * 50))}%` }}><Star aria-hidden="true" className="size-7 fill-emerald-300" /></span></span></button>)}
              </div>
              <p className="sr-only"><T>Each star equals 2 points out of 10.</T></p>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="movie-notes"><T>Personal notes or review</T></Label>
            <Textarea className="min-h-11 h-11 resize-y focus:h-24" id="movie-notes" value={notes} onChange={event => setNotes(event.target.value)} onBlur={() => { if (notes !== (movie.notes || "")) saveMovie({ notes }); }} placeholder={phrase(language, "Add your thoughts…")} />
          </div>
          {info && (info.year || info.runtime || info.genres.length > 0 || info.trailerUrl) && <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {[info.year, info.runtime ? `${info.runtime} min` : null, info.genres.join(', ') || null].filter(Boolean).map((item, index) => <span key={index}>{index > 0 && <span aria-hidden="true" className="mr-2">·</span>}{item}</span>)}
            {info.trailerUrl && <a href={info.trailerUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-emerald-300 hover:underline"><T>Watch trailer</T> <span className="sr-only"><T>(opens in a new tab)</T></span></a>}
          </div>}
          {watches.length > 0 && <p className="text-xs text-muted-foreground">{movieWatchHistory(language, watches.length, formatDate(watches[0].watchedAt))}</p>}
          {trackingError && <p role="alert" className="text-xs text-destructive">{phrase(language, trackingError)}</p>}
        </div>

        {/* Metadata and Actions */}
        <div>
          {/* Metadata */}
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground mb-3">
            <div className="flex items-center gap-2">
              <Calendar className="w-3 h-3" />
              <span>{phrase(language, "Added:")} {formatDate(movie.createdAt)}</span>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="w-3 h-3" />
              <span>{phrase(language, "Last updated:")} {formatDate(movie.updatedAt)}</span>
            </div>
          </div>

          <Separator className="mb-3" />

          {/* Action Buttons */}
          <div className="flex flex-wrap gap-2">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" className="flex-1">
                  <Trash2 className="w-4 h-4 mr-2" />
                  <T>Delete</T>
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle><T>Are you absolutely sure?</T></AlertDialogTitle>
                  <AlertDialogDescription>
                    <T>This action cannot be undone. This will permanently delete the movie from your collection.</T> <bdi>{movie.name}</bdi>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel><T>Cancel</T></AlertDialogCancel>
                  <AlertDialogAction onClick={deleteMovie}>
                    <T>Delete</T>
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
