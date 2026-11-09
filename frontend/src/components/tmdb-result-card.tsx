import { Check, Tv } from "lucide-react";
import { posterSrc } from "@/lib/poster";

/** Poster thumbnail with a neutral placeholder when TMDB has none (another show's poster is never substituted). */
export function SeriesPoster({ url, size = "w92", className }: { url: string | null | undefined; size?: "w92" | "w154" | "w185"; className: string }) {
  return url
    ? <img src={posterSrc(url, size)} alt="" loading="lazy" decoding="async" className={`${className} shrink-0 rounded-md bg-muted object-cover`} onError={event => { event.currentTarget.style.visibility = "hidden"; }} />
    : <span aria-hidden="true" className={`${className} flex shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground`}><Tv className="size-5" /></span>;
}

export type TmdbResult = { id?: number; name: string; overview?: string | null; posterURL?: string | null; year?: string | null; originalName?: string | null };

/** Compact TMDB search result: poster, full title, year, original title when different, and a short overview. */
export default function TmdbResultCard({ result, onSelect, disabled, current }: { result: TmdbResult; onSelect: () => void; disabled?: boolean; current?: boolean }) {
  return <button type="button" disabled={disabled} onClick={onSelect}
    aria-label={`${result.name}${result.year ? `, ${result.year}` : ""}${current ? ", current match" : ""}`}
    className="flex w-full min-w-0 gap-3 rounded-xl border bg-card p-2.5 text-left transition-colors hover:border-primary/40 focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60">
    <SeriesPoster url={result.posterURL} className="h-[4.5rem] w-12" />
    <span className="min-w-0 flex-1">
      <span className="flex items-baseline gap-2"><span className="min-w-0 break-words font-semibold leading-5">{result.name}</span><span className="shrink-0 text-sm text-muted-foreground">{result.year || "Year unknown"}</span></span>
      {result.originalName && result.originalName !== result.name && <span className="block truncate text-xs text-muted-foreground">Original title: {result.originalName}</span>}
      <span className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">{result.overview || "No description available."}</span>
      {current && <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary"><Check className="size-3" />Current match</span>}
    </span>
  </button>;
}
