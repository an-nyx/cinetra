import { Heart, Tv } from "lucide-react";
import { ShowType } from "@/types";
import { ShowService } from "@/services";
import type { TrackingSummary } from "@/services/show.service";
import { positionDetails, viewingStateLabel } from "@/lib/tracking";
import { posterSrc } from "@/lib/poster";
import { personalStatus, personalStatusColors, personalStatusLabels } from "@/lib/show-library";

interface ShowProps {
  id: string;
  name: string;
  favorite: boolean;
  status?: ShowType["status"];
  completed: boolean;
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
  status,
  completed,
  posterURL,
  setSelectedShow,
  shows,
  setShows,
  tracking,
  onMarkNext,
}: ShowProps) {
  const savedStatus = personalStatus({ status, completed });
  const borderColor = personalStatusColors[savedStatus];
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
    <article className="group relative flex min-w-0 gap-4 rounded-2xl border bg-card/70 p-3 shadow-sm transition-colors hover:bg-card sm:gap-5 sm:p-4" style={borderColor ? { borderColor } : undefined}>
      <button type="button" onClick={() => setSelectedShow(id)} aria-label={`Open ${name}`} className="relative block aspect-[2/3] w-24 shrink-0 overflow-hidden rounded-xl bg-muted text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary sm:w-28">
        <span className="absolute inset-0 flex items-center justify-center"><Tv className="size-8" /></span>
        {posterURL && <img loading="lazy" className="relative h-full w-full object-cover" src={posterSrc(posterURL, "w342")} decoding="async" alt="" onError={(event) => { event.currentTarget.style.display = "none"; }} />}
      </button>
      <div className="flex min-w-0 flex-1 flex-col py-0.5 pr-9">
        <p className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"><span aria-hidden="true" className="size-1.5 rounded-full" style={{ backgroundColor: borderColor || 'currentColor' }} />{personalStatusLabels[savedStatus]}</p>
        <button type="button" onClick={() => setSelectedShow(id)} className="line-clamp-2 text-left text-base font-semibold leading-snug text-foreground hover:text-primary sm:text-lg">{name}</button>
        {tracking && !tracking.error && <div className="mt-2 space-y-1 text-xs text-muted-foreground"><p>{viewingStateLabel(tracking)}<span className="ml-2 font-semibold text-foreground" title={tracking.progressUnavailable?.detail}>{tracking.progressPercent === null ? tracking.progressUnavailable?.label || 'Unavailable' : `${tracking.progressPercent}%`}</span></p>{positionDetails(tracking) && <p className="line-clamp-2">{positionDetails(tracking)}</p>}{tracking.newEpisodes > 0 && <p className="font-medium text-primary">{tracking.newEpisodes} new episode{tracking.newEpisodes === 1 ? '' : 's'}</p>}</div>}
        {tracking?.nextEpisode && !tracking.error && onMarkNext && <button type="button" className="mt-auto min-h-10 self-start pt-2 text-left text-xs font-semibold text-primary hover:underline" onClick={() => onMarkNext(tracking)}>Mark next watched <span aria-hidden="true">→</span></button>}
      </div>
      <button type="button" className="absolute right-2 top-2 flex size-11 items-center justify-center rounded-xl text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary" aria-label={`${favorite ? "Remove" : "Add"} ${name} ${favorite ? "from" : "to"} favorites`} aria-pressed={favorite} onClick={() => toggleFavorite(id, favorite)}><Heart className={`size-5 ${favorite ? "fill-rose-400 text-rose-400" : ""}`} /></button>
    </article>
  );
}
