import { useEffect, useState } from "react";
import axios from "axios";
import { AlertTriangle, ArrowLeft, Check, Search, Tv } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import useDebounce from "@/hooks/use-debounce";
import { posterSrc } from "@/lib/poster";
import { ShowService } from "@/services";
import type { ShowSearchResult, TmdbMatchPreview, TmdbSeriesSummary } from "@/services/show.service";

type Props = {
  showId: string;
  showName: string;
  currentTmdbId: number | null;
  onCancel: () => void;
  /** Called after a successful change; needsReview is true when saved progress does not fit the new series. */
  onApplied: (result: { needsReview: boolean }) => void;
};

function Poster({ url, size = "w92", className }: { url: string | null | undefined; size?: "w92" | "w154"; className: string }) {
  return url ? <img src={posterSrc(url, size)} alt="" loading="lazy" className={`${className} shrink-0 rounded-md object-cover`} />
    : <span className={`${className} flex shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground`}><Tv className="size-5" /></span>;
}

function SeriesCard({ label, series }: { label: string; series: TmdbSeriesSummary | null }) {
  return <div className="rounded-xl border bg-card p-3">
    <p className="cinema-eyebrow mb-2">{label}</p>
    {series ? <div className="flex gap-3">
      <Poster url={series.posterURL} size="w154" className="h-24 w-16" />
      <div className="min-w-0">
        <p className="font-semibold leading-5">{series.name}{series.year && <span className="font-normal text-muted-foreground"> ({series.year})</span>}</p>
        {series.originalName && series.originalName !== series.name && <p className="text-xs text-muted-foreground">Original title: {series.originalName}</p>}
        <p className="mt-0.5 text-xs text-muted-foreground">{series.seasons ?? "?"} season{series.seasons === 1 ? "" : "s"} · {series.releasedEpisodes ?? "?"} released episodes · TMDB {series.tmdbId}</p>
        {series.overview && <p className="mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground">{series.overview}</p>}
      </div>
    </div> : <p className="text-sm text-muted-foreground">Not linked to TMDB yet.</p>}
  </div>;
}

/** Edit show: find the correct TMDB series, compare it with the current match, and re-link only after confirmation. */
export default function EditShowMatch({ showId, showName, currentTmdbId, onCancel, onApplied }: Props) {
  const [query, setQuery] = useState(showName);
  const search = useDebounce(query, 300);
  const [results, setResults] = useState<ShowSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [preview, setPreview] = useState<TmdbMatchPreview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (search.trim().length < 2) { setResults([]); return; }
    let active = true;
    setSearching(true);
    ShowService.searchShows(search.trim())
      .then(found => { if (active) setResults(found); })
      .catch(() => { if (active) { setResults([]); setError("TMDB search is unavailable right now."); } })
      .finally(() => { if (active) setSearching(false); });
    return () => { active = false; };
  }, [search]);

  const choose = async (tmdbId: number) => {
    setBusy(true); setError(""); setAcknowledged(false);
    try { setPreview(await ShowService.previewTmdbMatch(showId, tmdbId)); }
    catch (e) { setError(axios.isAxiosError(e) && e.response?.data?.message ? e.response.data.message : "Could not load that series."); }
    finally { setBusy(false); }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy(true); setError("");
    try {
      const result = await ShowService.applyTmdbMatch(showId, { tmdbId: preview.replacement.tmdbId, expectedCurrentTmdbId: preview.currentTmdbId, acknowledgeProgress: acknowledged });
      onApplied({ needsReview: result.preview.progress.needsAcknowledgement || result.summary.viewingState === "needs_review" });
    } catch (e) {
      if (axios.isAxiosError(e) && e.response?.status === 409 && e.response.data?.preview) { setPreview(e.response.data.preview); setAcknowledged(false); }
      setError(axios.isAxiosError(e) && e.response?.data?.message ? e.response.data.message : "The change could not be saved. Nothing was changed.");
    } finally { setBusy(false); }
  };

  return <section aria-labelledby="edit-show-heading" className="space-y-4 py-5">
    <div className="flex items-center gap-2">
      <Button type="button" variant="ghost" size="icon" aria-label={preview ? "Back to search results" : "Close Edit show"} onClick={() => (preview ? setPreview(null) : onCancel())}><ArrowLeft className="size-5" /></Button>
      <div className="min-w-0"><h2 id="edit-show-heading" className="text-lg font-semibold">Edit show</h2><p className="text-xs text-muted-foreground">{preview ? "Check the change before saving." : "Find the exact TV series on TMDB."}</p></div>
    </div>
    {error && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">{error}</p>}

    {!preview && <>
      <label className="relative block"><Search aria-hidden="true" className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input aria-label="Search TMDB for the correct series" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search TV series" className="pl-9" autoFocus /></label>
      <p className="text-xs text-muted-foreground">Same title? Compare the year, poster and description to pick the right adaptation.</p>
      {searching && <p className="text-sm text-muted-foreground">Searching TMDB…</p>}
      {!searching && search.trim().length >= 2 && !results.length && !error && <p className="text-sm text-muted-foreground">No TV series found. Try another spelling or the original title.</p>}
      <ul className="space-y-2">{results.map(result => <li key={result.id}>
        <button type="button" disabled={busy} onClick={() => choose(result.id)} className="flex w-full gap-3 rounded-xl border bg-card p-2.5 text-left transition-colors hover:border-primary/40 disabled:opacity-60">
          <Poster url={result.posterURL} className="h-[4.5rem] w-12" />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2"><span className="truncate font-semibold">{result.name}</span>{result.year && <span className="shrink-0 text-sm text-muted-foreground">{result.year}</span>}</span>
            {result.originalName && result.originalName !== result.name && <span className="block truncate text-xs text-muted-foreground">Original title: {result.originalName}</span>}
            <span className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">{result.overview || "No description available."}</span>
            {result.id === currentTmdbId && <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary"><Check className="size-3" />Current match</span>}
          </span>
        </button>
      </li>)}</ul>
    </>}

    {preview && <>
      <SeriesCard label="Current match" series={preview.current} />
      <SeriesCard label="Replace with" series={preview.replacement} />
      {preview.unchanged && <p className="rounded-xl border bg-card p-3 text-sm">This is already the current match. Nothing to change.</p>}
      {preview.duplicate && <p role="alert" className="flex gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm"><AlertTriangle className="mt-0.5 size-4 shrink-0" />&ldquo;{preview.duplicate.name}&rdquo; in your library is already linked to this series. Change or remove that show first.</p>}
      {!preview.unchanged && !preview.duplicate && <div className="space-y-2 rounded-xl border bg-card p-3 text-sm">
        <p className="font-semibold">Your progress</p>
        {!preview.progress.hasProgress && <p className="text-muted-foreground">No saved position or logged episodes; nothing to carry over.</p>}
        {preview.progress.positionFits && preview.progress.positionDetail && <p className="text-muted-foreground">{preview.progress.positionDetail}</p>}
        {preview.progress.mappedRecords.length > 0 && <p className="text-muted-foreground">{preview.progress.mappedRecords.length} logged episode{preview.progress.mappedRecords.length === 1 ? "" : "s"} will count as the same episode numbers of the new series.</p>}
        {preview.progress.warnings.map(warning => <p key={warning} className="flex gap-2 text-amber-300"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{warning}</p>)}
        <p className="text-xs text-muted-foreground">Your personal status, favorite and watch history stay as they are. Nothing is renumbered or deleted.</p>
        {preview.progress.needsAcknowledgement && <label className="flex items-start gap-2 pt-1">
          <input type="checkbox" className="mt-1 size-4 accent-[var(--primary)]" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />
          <span>Keep my saved progress unchanged and review it after the change.</span>
        </label>}
      </div>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" disabled={busy} onClick={() => setPreview(null)}>Back</Button>
        <Button type="button" disabled={busy || !preview.canApply || (preview.progress.needsAcknowledgement && !acknowledged)} onClick={apply}>{busy ? "Saving…" : "Use this series"}</Button>
      </div>
    </>}
  </section>;
}
