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
  const [state, setState] = useState<{ loading: boolean; rows: StatusPreviewRow[] | null; error: string | null }>({ loading: false, rows: null, error: null });
  const load = async () => {
    setState({ loading: true, rows: null, error: null });
    try { setState({ loading: false, rows: (await ShowService.getStatusPreview()).shows, error: null }); }
    catch { setState({ loading: false, rows: null, error: "The preview is unavailable right now." }); }
  };
  const rows = state.rows || [];
  const automatic = rows.filter(r => r.automatic);
  const proposed = rows.filter(r => r.retroactive);
  const ambiguous = rows.filter(r => r.ambiguous && !r.automatic && !r.retroactive);
  const list = (items: StatusPreviewRow[], render: (r: StatusPreviewRow) => string) => <ul className="mt-1 space-y-0.5 text-muted-foreground">{items.map(r => <li key={r.showId}><bdi>{r.name}</bdi>: {render(r)}</li>)}</ul>;
  return (
    <section aria-labelledby="status-preview-title" className="space-y-3 rounded-2xl border bg-card/60 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2"><ListChecks className="size-4 text-primary" aria-hidden="true" /><h3 id="status-preview-title" className="text-sm font-semibold">Automatic TV statuses</h3></div>
        <Button type="button" variant="ghost" size="sm" disabled={state.loading} onClick={() => void load()} className="gap-1.5">{state.loading && <Loader2 className="size-4 animate-spin" />}{state.rows ? "Refresh" : "Review"}</Button>
      </div>
      <p className="text-xs text-muted-foreground">Shows move between Watching and Completed on their own. Dropped, Paused and Planned are never changed. This review only reads your library.</p>
      {state.error && <p role="status" className="text-xs text-destructive">{state.error}</p>}
      {state.rows && <div className="space-y-3 text-xs">
        <div><p className="font-medium">Will change automatically ({automatic.length})</p>{automatic.length ? list(automatic, r => `${label(r.status)} → ${label(r.automatic!.to)} (${r.automatic!.reason})`) : <p className="text-muted-foreground">Nothing right now.</p>}</div>
        <div><p className="font-medium">Finished earlier, waiting for your approval ({proposed.length})</p>{proposed.length ? list(proposed, r => `${label(r.status)} → ${label(r.retroactive!.to)} (${r.retroactive!.reason})`) : <p className="text-muted-foreground">None.</p>}</div>
        <div><p className="font-medium">Cannot be verified, left unchanged ({ambiguous.length})</p>{ambiguous.length ? list(ambiguous, r => r.completion) : <p className="text-muted-foreground">None.</p>}</div>
        <p className="text-muted-foreground">{rows.length} shows reviewed.</p>
      </div>}
    </section>
  );
}
