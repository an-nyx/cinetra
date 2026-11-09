import { Heart, Tv } from "lucide-react";
import { ShowType } from "@/types";
import { ShowService } from "@/services";
import type { TrackingSummary } from "@/services/show.service";

interface ShowProps {
  id: string;
  name: string;
  favorite: boolean;
  posterURL: string;
  setSelectedShow: React.Dispatch<React.SetStateAction<string>>;
  shows: ShowType[];
  setShows: React.Dispatch<React.SetStateAction<ShowType[]>>;
  type: "show" | "movie";
  tracking?: TrackingSummary;
  onMarkNext?: (item: TrackingSummary) => void;
}

export default function Show({
  id,
  name,
  favorite,
  posterURL,
  setSelectedShow,
  shows,
  setShows,
  tracking,
  onMarkNext,
}: ShowProps) {
  const toggleFavorite = async (id: string, favorite: boolean) => {
    try {
      await ShowService.toggleFavorite(id, !favorite);

      setShows(
        shows.map((show) => {
          if (show.id !== id) return show;

          return { ...show, favorite: !favorite };
        }),
      );
    } catch (error) {
      console.error("error occurred while toggling show favorite button", error);
    }
  };

  return (
    <article className="group relative min-w-0">
      <button
        type="button"
        className="cinema-poster relative block aspect-[2/3] w-full overflow-hidden rounded-2xl border border-white/10 bg-muted text-left transition-[transform,box-shadow,border-color] duration-300 group-hover:-translate-y-1 group-hover:border-primary/40 group-hover:shadow-[0_20px_45px_rgba(0,0,0,0.35)] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary motion-reduce:transform-none"
        onClick={() => setSelectedShow(id)}
        aria-label={`Open ${name}`}
      >
        <span className="absolute inset-0 flex items-center justify-center text-muted-foreground"><Tv className="size-10" /></span>
        {posterURL && <img loading="lazy" className="relative h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04] motion-reduce:transform-none" src={posterURL} alt="" onError={(event) => { event.currentTarget.style.display = "none"; }} />}
        <span className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/10 to-transparent" />
        {tracking && tracking.progressPercent !== null && <span className="absolute bottom-0 left-0 h-1 bg-primary transition-[width] duration-500" style={{ width: `${tracking.progressPercent}%` }} />}
        <span className="absolute inset-x-0 bottom-0 line-clamp-2 p-3 pb-4 text-sm font-semibold leading-5 text-white sm:text-base">{name}</span>
      </button>
      {tracking && !tracking.error && <div className="mt-3 space-y-2 px-1"><div className="flex items-center justify-between gap-1 text-xs"><span className="truncate text-muted-foreground">{tracking.viewingState === 'fully_watched' ? 'Fully watched' : tracking.viewingState === 'caught_up' ? 'Caught up · future episodes may follow' : tracking.legacyPosition ? `Saved · S${tracking.legacyPosition.normalizedSeason ?? tracking.legacyPosition.fullSeasons}E${tracking.legacyPosition.normalizedEpisode ?? tracking.legacyPosition.episodesInNextSeason}` : tracking.nextEpisode ? `Next · S${tracking.nextEpisode.season}E${tracking.nextEpisode.number}` : tracking.guideAvailable ? 'No released episode to track' : 'Episode guide unavailable'}</span><span className="shrink-0 font-semibold text-primary">{tracking.progressPercent === null ? '—' : `${tracking.progressPercent}%`}</span></div>{tracking.newEpisodes > 0 && <span className="cinema-tag">{tracking.newEpisodes} new episode{tracking.newEpisodes === 1 ? '' : 's'}</span>}{tracking.nextEpisode && onMarkNext && <button type="button" className="min-h-10 w-full rounded-xl border border-primary/35 px-2 py-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-primary" onClick={() => onMarkNext(tracking)}>Mark next watched</button>}</div>}
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
