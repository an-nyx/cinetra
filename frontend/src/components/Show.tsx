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
    <article className="group relative flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card/60" style={borderColor ? { borderColor } : undefined}>
      <button type="button" onClick={() => setSelectedShow(id)} aria-label={`Open ${name}`} className="relative block aspect-[2/3] w-full overflow-hidden bg-muted text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-primary">
        <span className="absolute inset-0 flex items-center justify-center"><Tv className="size-8" /></span>
        {posterURL && <img loading="lazy" className="relative h-full w-full object-cover" src={posterSrc(posterURL, "w342")} decoding="async" alt="" onError={(event) => { event.currentTarget.style.display = "none"; }} />}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-3">
        <button type="button" onClick={() => setSelectedShow(id)} className="line-clamp-2 text-left text-sm font-semibold leading-snug text-foreground hover:text-primary sm:text-base">{name}</button>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><span aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: borderColor || 'currentColor' }} />{personalStatusLabels[savedStatus]}</p>
        {tracking && !tracking.error && <div className="space-y-1 text-xs text-muted-foreground"><p>{viewingStateLabel(tracking)}<span className="ml-1 font-medium text-foreground" title={tracking.progressUnavailable?.detail}>{tracking.progressPercent === null ? tracking.progressUnavailable?.label || 'Unavailable' : `${tracking.progressPercent}%`}</span></p>{positionDetails(tracking) && <p className="line-clamp-2">{positionDetails(tracking)}</p>}{tracking.newEpisodes > 0 && <p className="text-primary">{tracking.newEpisodes} new episode{tracking.newEpisodes === 1 ? '' : 's'}</p>}</div>}
        {tracking?.nextEpisode && !tracking.error && onMarkNext && <button type="button" className="mt-auto min-h-10 self-start pt-2 text-left text-xs font-semibold text-primary hover:underline" onClick={() => onMarkNext(tracking)}>Mark next watched <span aria-hidden="true">→</span></button>}
      </div>
      <button type="button" className="absolute right-1.5 top-1.5 flex size-11 items-center justify-center rounded-full bg-black/65 text-white hover:bg-black/80 focus-visible:outline-2 focus-visible:outline-primary" aria-label={`${favorite ? "Remove" : "Add"} ${name} ${favorite ? "from" : "to"} favorites`} aria-pressed={favorite} onClick={() => toggleFavorite(id, favorite)}><Heart className={`size-5 ${favorite ? "fill-rose-400 text-rose-400" : ""}`} /></button>
    </article>
  );
}
