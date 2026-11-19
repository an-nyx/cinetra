import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { toast } from "sonner";
import { Bookmark, Check, Download, ExternalLink, HardDrive, Info, Loader2, RotateCw, Search } from "lucide-react";
import { T, phrase, useLanguage } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RadarrService } from "@/services/radarr.service";
import StatusBadge from "@/components/radarr-badge";
import {
  badges, createLatest, createSubmitGuard, displayYear, reloadAfter, requestActionLabel, requestBody, requestErrorMessage, requestPlan, requestProblem,
  searchBlockMessages, statusFromView, type MovieSummary, type RadarrStatus, type RequestView,
} from "@/lib/radarr";

/**
 * Request a movie that is already in Radarr: turn monitoring on and, only if explicitly chosen, search now. It never
 * unmonitors, deletes, replaces, upgrades or re-downloads anything, and never touches Cinetra's viewing data.
 */
const errorOf = (error: unknown) => axios.isAxiosError(error) ? { code: (error.response?.data as { code?: string } | undefined)?.code, status: error.response?.status } : { code: undefined, status: undefined };

export default function RequestMovieDialog({ open, onOpenChange, movieId, movie, justAdded = false, onDone }: {
  open: boolean; onOpenChange: (open: boolean) => void; movieId: string; movie: MovieSummary; justAdded?: boolean; onDone: (status: RadarrStatus) => void;
}) {
  const { language } = useLanguage();
  const [view, setView] = useState<RequestView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [search, setSearch] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const guard = useRef(createSubmitGuard());
  const latest = useRef(createLatest());

  useEffect(() => { if (open) { setSearch(false); setError(""); setView(null); } }, [open]);

  // Fresh, read-only Radarr state every time the dialog opens (and after a refused or partial change).
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const token = latest.current.next();
    setLoadError("");
    RadarrService.getRequestView(movieId, controller.signal)
      .then(result => { if (latest.current.isLatest(token)) { setView(result); if (!result.canSearch) setSearch(false); } })
      .catch(caught => { if (!axios.isCancel(caught) && latest.current.isLatest(token)) setLoadError(requestErrorMessage(errorOf(caught).code, errorOf(caught).status)); });
    return () => controller.abort();
  }, [open, movieId, reload]);

  const plan = view ? requestPlan(view, search) : null;
  const problem = requestProblem(view, search);
  const year = displayYear(movie);

  const submit = async () => {
    if (!view || !plan || problem) return;
    setError("");
    await guard.current(async () => {
      setSubmitting(true);
      try {
        const result = await RadarrService.requestMovie(movieId, requestBody(view, search));
        latest.current.next();
        setView(result.view);
        onDone(statusFromView(result.view));
        const parts = [phrase(language, result.monitoringEnabled ? "Monitoring turned on." : "Already monitored.")];
        parts.push(phrase(language, result.searched ? "Search started. Radarr grabs a release only if it finds a suitable one." : "No search started."));
        toast.success(phrase(language, "Radarr updated"), { description: parts.join(" ") });
        onOpenChange(false);
      } catch (caught) {
        const { code, status } = errorOf(caught);
        setError(requestErrorMessage(code, status));
        if (reloadAfter(code)) { setSearch(false); setReload(value => value + 1); }
      } finally { setSubmitting(false); }
    });
  };

  return <Dialog open={open} onOpenChange={value => { if (!submitting) onOpenChange(value); }}>
    <DialogContent className="grid-cols-[minmax(0,1fr)] gap-0 pb-0 sm:max-w-lg sm:pb-0" onInteractOutside={event => { if (submitting) event.preventDefault(); }}>
      <DialogHeader className="pr-10 text-left">
        <p className="cinema-eyebrow"><T>Radarr</T></p>
        <DialogTitle className="text-xl"><T>Request movie</T></DialogTitle>
        <DialogDescription><bdi>{movie.title}</bdi>{year ? ` (${year})` : ""} · <T>Choose what Radarr should do.</T></DialogDescription>
      </DialogHeader>

      {justAdded && <p role="status" className="mt-4 flex gap-2 rounded-xl border border-primary/30 bg-primary/10 p-3 text-xs leading-5"><Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" /><span><T>Added to Radarr with monitoring off. Request it now, or close this to leave it unmonitored.</T></span></p>}

      {loadError && <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">
        <span>{phrase(language, loadError)}</span>
        <Button type="button" size="sm" variant="ghost" className="gap-1.5" onClick={() => setReload(value => value + 1)}><RotateCw aria-hidden="true" className="size-4" /><T>Retry</T></Button>
      </div>}
      {!view && !loadError && <p className="mt-5 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 aria-hidden="true" className="size-4 animate-spin" /><T>Loading Radarr status…</T></p>}

      {view && plan && <div className="mt-4 space-y-4">
        <div className="rounded-xl border bg-card/40 p-3">
          <p className="text-xs font-medium text-muted-foreground"><T>Current state in Radarr</T></p>
          <div className="mt-2 flex flex-wrap gap-1.5">{badges({ monitored: view.monitored, fileState: view.fileState, queue: view.queue, canSearch: view.canSearch }).map(badge => <StatusBadge key={badge.key} badge={badge} />)}</div>
        </div>

        {view.fileState === "on_disk"
          ? <p className="flex gap-2 rounded-xl border bg-muted/40 p-3 text-xs leading-5 text-muted-foreground"><HardDrive aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" /><span>{phrase(language, searchBlockMessages.on_disk)}</span></p>
          : <>
            <div className="flex gap-3 rounded-xl border bg-card/40 p-3 text-sm">
              <Bookmark aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
              <span><span className="font-medium">{phrase(language, view.canMonitor ? "Turn monitoring on" : "Already monitored")}</span>
                <span className="block text-xs text-muted-foreground"><T>Radarr may grab it automatically when a suitable release appears. Monitoring alone does not start a download right away.</T></span></span>
            </div>
            <label className={`flex min-h-11 items-start gap-3 rounded-xl border bg-card/40 p-3 text-sm ${view.canSearch ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}>
              <input type="checkbox" className="mt-0.5 size-5 shrink-0 accent-[var(--primary)]" checked={search && view.canSearch} disabled={submitting || !view.canSearch} onChange={event => setSearch(event.target.checked)} />
              <span><span className="font-medium"><T>Search now</T></span>
                <span className="block text-xs text-muted-foreground">{phrase(language, view.canSearch ? "Radarr searches now and may grab a release if one is available." : searchBlockMessages[view.searchBlock || "unknown"])}</span></span>
            </label>

            <section aria-labelledby="radarr-request-summary" className="space-y-1.5 rounded-2xl border border-primary/30 bg-primary/5 p-3 text-xs leading-5">
              <h3 id="radarr-request-summary" className="text-sm font-semibold"><T>Summary</T></h3>
              <p className="flex gap-2"><Bookmark aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-primary" /><span>{phrase(language, plan.monitor ? "Monitoring: will be turned on." : "Monitoring: already on, unchanged.")}</span></p>
              <p className="flex gap-2"><Search aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-primary" /><span>{phrase(language, plan.search ? "Search now: yes. A download starts only if Radarr finds a suitable release." : "Search now: no. Radarr checks its RSS feeds for new releases of monitored movies.")}</span></p>
              <p className="flex gap-2 text-muted-foreground"><Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" /><span><T>Nothing is unmonitored, deleted or replaced. Your Cinetra status and rating stay unchanged: a downloaded movie is never marked watched.</T></span></p>
            </section>
          </>}
        <Button asChild variant="ghost" size="sm" className="gap-1.5 px-0 text-primary hover:bg-transparent hover:text-primary"><a href={view.radarrUrl} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" className="size-4" /><T>Open in Radarr</T><span className="sr-only"> <T>(opens in a new tab)</T></span></a></Button>
      </div>}

      {error && <div role="alert" className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">{phrase(language, error)}</div>}

      <div className="sticky bottom-0 -mx-5 mt-5 border-t bg-background/95 px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur sm:-mx-6 sm:px-6 sm:pb-6">
        {problem && view && <p className="mb-2 text-xs text-muted-foreground">{phrase(language, problem)}</p>}
        <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 sm:flex sm:justify-end">
          <Button type="button" variant="ghost" className="min-h-11" disabled={submitting} onClick={() => onOpenChange(false)}>{phrase(language, view?.fileState === "on_disk" ? "Close" : "Cancel")}</Button>
          {view?.fileState !== "on_disk" && <Button type="button" className="h-auto min-h-11 gap-2 whitespace-normal py-2 leading-tight" disabled={!!problem || submitting} onClick={submit}>
            {submitting ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : plan?.search ? <Search aria-hidden="true" className="size-4" /> : plan?.monitor ? <Bookmark aria-hidden="true" className="size-4" /> : <Download aria-hidden="true" className="size-4" />}
            {phrase(language, submitting ? "Updating Radarr…" : plan ? requestActionLabel(plan) : "Confirm and monitor")}
          </Button>}
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}
