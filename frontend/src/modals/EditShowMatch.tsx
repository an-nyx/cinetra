import { useEffect, useState } from "react";
import axios from "axios";
import { AlertTriangle, ArrowLeft, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import useDebounce from "@/hooks/use-debounce";
import TmdbResultCard, { SeriesPoster } from "@/components/tmdb-result-card";
import { ShowService } from "@/services";
import type { ShowSearchResult, TmdbMatchPreview, TmdbSeriesSummary } from "@/services/show.service";

type Props = {
  showId: string;
  showName: string;
  /** The library entry's saved poster, shown at the top so it is clear which entry is being edited. */
  showPosterURL: string | null;
  currentTmdbId: number | null;
  onCancel: () => void;
  /** Called after a successful change; needsReview is true when saved progress does not fit the new series. */
  onApplied: (result: { needsReview: boolean }) => void;
};

function SeriesCard({ label, series }: { label: string; series: TmdbSeriesSummary | null }) {
  return <div className="rounded-xl border bg-card p-3">
    <p className="cinema-eyebrow mb-2">{label}</p>
    {series ? <div className="flex gap-3">
      <SeriesPoster url={series.posterURL} size="w154" className="h-24 w-16" />
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
export default function EditShowMatch({ showId, showName, showPosterURL, currentTmdbId, onCancel, onApplied }: Props) {
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
    <div className="flex items-center gap-3 rounded-xl border bg-card/60 p-2.5">
      <SeriesPoster url={showPosterURL} className="h-14 w-10" />
      <div className="min-w-0"><p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Editing your saved show</p><p className="truncate font-semibold">{showName}</p><p className="text-xs text-muted-foreground">{currentTmdbId ? `Linked to TMDB ${currentTmdbId}` : "Not linked to TMDB"}</p></div>
    </div>
    {error && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">{error}</p>}

    {!preview && <>
      <div className="sticky top-0 z-10 -mx-1 bg-background/95 px-1 pb-2 pt-1">
        <label className="relative block"><Search aria-hidden="true" className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" inputMode="search" enterKeyHint="search" autoComplete="off" autoCorrect="off" aria-label="Search TMDB for the correct series" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search TV series" className="pl-9" /></label>
      </div>
      <p className="text-xs text-muted-foreground">Same title? Compare the year, poster and description to pick the right adaptation.</p>
      {searching && <p className="text-sm text-muted-foreground">Searching TMDB…</p>}
      {!searching && search.trim().length >= 2 && !results.length && !error && <p className="text-sm text-muted-foreground">No TV series found. Try another spelling or the original title.</p>}
      <ul className="space-y-2">{results.map(result => <li key={result.id}><TmdbResultCard result={result} disabled={busy} current={result.id === currentTmdbId} onSelect={() => choose(result.id)} /></li>)}</ul>
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
        <Button type="button" variant="outline" disabled={busy} onClick={() => setPreview(null)}>Cancel</Button>
        <Button type="button" disabled={busy || !preview.canApply || (preview.progress.needsAcknowledgement && !acknowledged)} onClick={apply}>{busy ? "Saving…" : "Confirm match"}</Button>
      </div>
    </>}
  </section>;
}
