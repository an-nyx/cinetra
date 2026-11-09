import { Heart, Tv } from "lucide-react";
import { ShowType } from "@/types";
import { ShowService } from "@/services";
import type { TrackingSummary } from "@/services/show.service";
import { nextEpisodeCode, savedPositionCode, viewingStateLabel } from "@/lib/tracking";
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
      <div className="relative flex w-full justify-center">
        <button type="button" onClick={() => setSelectedShow(id)} aria-label={`Open ${name}`} className="compact-show-poster relative block aspect-[2/3] w-full overflow-hidden bg-muted text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-primary">
          <span className="absolute inset-0 flex items-center justify-center"><Tv className="size-8" /></span>
          {posterURL && <img loading="lazy" className="relative h-full w-full object-contain" src={posterSrc(posterURL, "w342")} decoding="async" alt="" onError={(event) => { event.currentTarget.style.display = "none"; }} />}
        </button>
        {tracking?.newSeasonToWatch && <button type="button" onClick={() => setSelectedShow(id)} className="absolute inset-x-0 bottom-0 min-h-10 bg-black/80 px-1 text-center text-[11px] leading-4 text-white"><span className="block truncate font-semibold">New season to watch</span><span className="block truncate">S{tracking.newSeasonToWatch.season} · {tracking.newSeasonToWatch.count} unwatched</span></button>}
      </div>
      {/* Fixed rows keep every card the same height: title, personal status, progress, and the optional action. */}
      <div className="grid min-w-0 grid-rows-[1.25rem_1rem_1rem_1.25rem] gap-px px-2.5 py-1 sm:grid-rows-[2.5rem_1.25rem_1.25rem_2.5rem] sm:gap-0.5 sm:px-3 sm:py-2">
        <button type="button" onClick={() => setSelectedShow(id)} title={name} className="block min-w-0 truncate text-left text-sm font-semibold leading-5 text-foreground hover:text-primary sm:line-clamp-2 sm:whitespace-normal sm:text-base">{name}</button>
        <p className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs leading-4 text-muted-foreground" title={`Personal status: ${personalStatusLabels[savedStatus]}`}><span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: borderColor || 'currentColor' }} /><span className="truncate">{personalStatusLabels[savedStatus]}</span></p>
        <p className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-xs leading-4 text-muted-foreground" title={tracking?.progressPercent == null ? tracking?.progressUnavailable?.detail : undefined}>{tracking && !tracking.error && <>
          {tracking.progressPercent !== null
            ? <span className="shrink-0 font-semibold text-foreground">{tracking.progressPercent}%</span>
            : <span className="truncate">{tracking.progressUnavailable?.label || viewingStateLabel(tracking)}</span>}
          {(nextEpisodeCode(tracking) || savedPositionCode(tracking)) && <><span aria-hidden="true">•</span><span className="truncate">{nextEpisodeCode(tracking) ? `Next ${nextEpisodeCode(tracking)}` : `Saved ${savedPositionCode(tracking)}`}</span></>}
        </>}</p>
        <div className="flex min-w-0 items-center">{tracking?.nextEpisode && !tracking.error && onMarkNext && <button type="button" className="min-h-5 max-w-full truncate text-left text-xs font-semibold leading-4 text-primary hover:underline" onClick={() => onMarkNext(tracking)}>Mark next watched <span aria-hidden="true">→</span></button>}</div>
      </div>
      <button type="button" className="absolute right-1.5 top-1.5 flex size-10 items-center justify-center rounded-full bg-black/65 text-white hover:bg-black/80 focus-visible:outline-2 focus-visible:outline-primary" aria-label={`${favorite ? "Remove" : "Add"} ${name} ${favorite ? "from" : "to"} favorites`} aria-pressed={favorite} onClick={() => toggleFavorite(id, favorite)}><Heart className={`size-5 ${favorite ? "fill-rose-400 text-rose-400" : ""}`} /></button>
    </article>
  );
}
