import { ListChecks, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ShowService } from "@/services";
import type { StatusPreviewRow } from "@/services/show.service";

const label = (status: string | null) => status === "completed" ? "Completed" : status === "watching" ? "Watching" : status ? status[0].toUpperCase() + status.slice(1) : "No status";

/**
 * Read-only review of automatic Watching <-> Completed statuses: what will change on its own, what applying the rules
 * to shows you finished earlier would change (never applied without your approval), and what cannot be verified.
 */
export default function ShowStatusPreview() {
  const [dates, setDates] = useState<Record<string, string>>({});
  const [baselines, setBaselines] = useState<Record<string, string>>({});
  const [writesEnabled, setWritesEnabled] = useState<boolean | null>(null);
  const [state, setState] = useState<{ loading: boolean; rows: StatusPreviewRow[] | null; error: string | null }>({ loading: false, rows: null, error: null });
  const load = async (confirmed = baselines) => {
    setState({ loading: true, rows: null, error: null });
    try { const result = await ShowService.getStatusPreview(confirmed); setWritesEnabled(result.automaticWritesEnabled); setState({ loading: false, rows: result.shows, error: null }); }
    catch { setState({ loading: false, rows: null, error: "The preview is unavailable right now." }); }
  };
  const rows = state.rows || [];
  const automatic = rows.filter(r => r.automatic);
  const proposed = rows.filter(r => r.retroactive);
  const protectedLegacy = rows.filter(r => r.confirmationRequired);
  const ambiguous = rows.filter(r => !r.confirmationRequired && r.ambiguous && !r.automatic && !r.retroactive);
  const unchanged = rows.filter(r => !r.confirmationRequired && !r.ambiguous && !r.automatic && !r.retroactive);
  const confirmBaseline = (r: StatusPreviewRow) => {
    const date = new Date(dates[r.showId]);
    if (!Number.isFinite(date.getTime()) || date.getTime() > Date.now()) return;
    const confirmed = { ...baselines, [r.showId]: date.toISOString() };
    setBaselines(confirmed);
    void load(confirmed);
  };
  const list = (items: StatusPreviewRow[], render: (r: StatusPreviewRow) => string) => <ul className="mt-1 space-y-2 text-muted-foreground">{items.map(r => <li key={r.showId}>
    <bdi>{r.name}</bdi>: {render(r)}
    <span className="block">{label(r.status)} · {r.legacyCompletion ? "Actual viewing unrecorded" : `${r.watched ?? "Unknown"} effectively watched`} / {r.released ?? "Unknown"} verified released regular episodes{r.unwatched.length > 0 && ` · ${r.legacyCompletion ? "New episodes after confirmed baseline" : "Unwatched"}: ${r.unwatched.join(", ")}`}</span>
    {r.legacyCompletion && <div className="mt-2 space-y-1">
      <p>{r.explanation}</p>
      <label className="block">When had you finished all regular episodes that had premiered? (Your local date and time)
        <input aria-label={`Completion baseline for ${r.name}`} type="datetime-local" className="mt-1 block max-w-full rounded border bg-background p-2 text-foreground" value={dates[r.showId] ?? ""} onChange={e => setDates(previous => ({ ...previous, [r.showId]: e.target.value }))} />
      </label>
      <Button type="button" variant="outline" size="sm" disabled={state.loading || !dates[r.showId] || !Number.isFinite(new Date(dates[r.showId]).getTime()) || new Date(dates[r.showId]).getTime() > Date.now()} onClick={() => confirmBaseline(r)}>Confirm baseline for preview</Button>
      {r.completionBaseline && <Button type="button" variant="ghost" size="sm" disabled={state.loading} onClick={() => {
        const confirmed = { ...baselines }; delete confirmed[r.showId]; setBaselines(confirmed); void load(confirmed);
      }}>Remove preview baseline</Button>}
      <p>This only recalculates this review. It saves no baseline, status or watched records.</p>
    </div>}
  </li>)}</ul>;
  return (
    <section aria-labelledby="status-preview-title" className="space-y-3 rounded-2xl border bg-card/60 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2"><ListChecks className="size-4 text-primary" aria-hidden="true" /><h3 id="status-preview-title" className="text-sm font-semibold">Automatic TV statuses</h3></div>
        <Button type="button" variant="ghost" size="sm" disabled={state.loading} onClick={() => void load()} className="gap-1.5">{state.loading && <Loader2 className="size-4 animate-spin" />}{state.rows ? "Refresh" : "Review"}</Button>
      </div>
      <p className="text-xs text-muted-foreground">Proposed corrections use verified episodes and effective watch coverage. Legacy Completed shows without regular tracking are protected; unrecorded viewing does not mean unwatched. Proposals awaiting activation require approval. Dropped, Paused and Planned are never changed. This review only reads your library.</p>
      {writesEnabled === false && <p role="status" className="text-xs font-medium">Automatic status changes are disabled. Reviewing does not change your library.</p>}
      {state.error && <p role="status" className="text-xs text-destructive">{state.error}</p>}
      {state.rows && <div className="space-y-3 text-xs">
        <div><p className="font-medium">Will change automatically ({automatic.length})</p>{automatic.length ? list(automatic, r => `${label(r.status)} → ${label(r.automatic!.to)} (${r.automatic!.reason})`) : <p className="text-muted-foreground">Nothing right now.</p>}</div>
        <div><p className="font-medium">Proposed corrections awaiting activation ({proposed.length})</p>{proposed.length ? list(proposed, r => `${label(r.status)} → ${label(r.retroactive!.to)} (${r.retroactive!.reason})`) : <p className="text-muted-foreground">None.</p>}</div>
        <div><p className="font-medium">Legacy Completed — needs your baseline ({protectedLegacy.length})</p>{list(protectedLegacy, () => "Preserved; completion baseline requires your confirmation.")}</div>
        <div><p className="font-medium">Cannot be verified, left unchanged ({ambiguous.length})</p>{ambiguous.length ? list(ambiguous, r => r.completion) : <p className="text-muted-foreground">None.</p>}</div>
        <div><p className="font-medium">Correctly unchanged ({unchanged.length})</p>{list(unchanged, r => `${r.completion}; ${r.reopen}`)}</div>
        <p className="text-muted-foreground">{rows.length} shows reviewed.</p>
      </div>}
    </section>
  );
}
