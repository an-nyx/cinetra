import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { toast } from "sonner";
import { Check, ExternalLink, Info, ListChecks, Loader2, Plus, RotateCw, Tv } from "lucide-react";
import { T, phrase, useLanguage } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SonarrService } from "@/services/sonarr.service";
import { posterSrc } from "@/lib/poster";
import RequestEpisodesDialog from "@/components/sonarr-episodes";
import {
  addErrorMessage, addRequest, createStatusCache, createSubmitGuard, displayYear, formatFreeSpace, initialForm, panelView, validateForm,
  type AddForm, type SeriesSummary, type SonarrOptions, type SonarrStatus,
} from "@/lib/sonarr";

/**
 * "Add to Sonarr" / "Request episodes" for a library TV show. Download management only: it never changes Cinetra's watched episodes,
 * progress, status, favorites or ratings. The browser talks to Cinetra's backend only.
 */
const statusCache = createStatusCache();
const REMEMBER_KEY = "cinetra-sonarr-choices";
const remembered = () => { try { return JSON.parse(localStorage.getItem(REMEMBER_KEY) || "null"); } catch { return null; } };
const remember = (form: AddForm) => { try { localStorage.setItem(REMEMBER_KEY, JSON.stringify({ rootFolderId: form.rootFolderId, qualityProfileId: form.qualityProfileId })); } catch { /* storage unavailable */ } };
const errorOf = (error: unknown) => axios.isAxiosError(error) ? { code: (error.response?.data as { code?: string } | undefined)?.code, status: error.response?.status, data: error.response?.data as { status?: SonarrStatus } | undefined } : { code: undefined, status: undefined, data: undefined };

const fieldClass = "mt-1.5 block min-h-11 w-full max-w-full rounded-xl border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-primary";

export default function SonarrPanel({ showId, cinetraPosterURL }: { showId: string; cinetraPosterURL: string | null }) {
  const { language } = useLanguage();
  const [status, setStatus] = useState<SonarrStatus | null>(() => statusCache.get(showId));
  const [loadFailed, setLoadFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [requesting, setRequesting] = useState<false | "existing" | "added">(false);

  useEffect(() => {
    const cached = statusCache.get(showId);
    setLoadFailed(false);
    if (cached && attempt === 0) { setStatus(cached); return; }
    setStatus(null);
    const controller = new AbortController();
    SonarrService.getStatus(showId, controller.signal)
      .then(result => { statusCache.set(showId, result); setStatus(result); })
      .catch(error => { if (!axios.isCancel(error)) setLoadFailed(true); });
    return () => controller.abort();
  }, [showId, attempt]);

  const updateStatus = (next: SonarrStatus) => { statusCache.set(showId, next); setStatus(next); };
  const view = panelView(status, loadFailed);

  if (view.kind === "hidden") return null;
  if (view.kind === "loading") return <Button type="button" variant="outline" size="sm" disabled className="gap-2"><Loader2 className="size-4 animate-spin" /><T>Sonarr</T></Button>;
  if (view.kind === "notice") return <p role="status" className="flex basis-full items-start gap-1.5 text-xs leading-5 text-muted-foreground">
    <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" /><span>{phrase(language, view.message)}{view.retry && <> <button type="button" className="inline-flex min-h-6 items-center gap-1 font-medium text-primary hover:underline" onClick={() => setAttempt(value => value + 1)}><RotateCw aria-hidden="true" className="size-3" /><T>Retry</T></button></>}</span>
  </p>;
  if (view.kind === "exists") return <div className="flex flex-wrap items-center gap-2">
    <Button type="button" variant="outline" size="sm" className="gap-2 border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary" onClick={() => setRequesting("existing")}><ListChecks aria-hidden="true" className="size-4" /><T>Request episodes</T></Button>
    <span className="inline-flex h-8 items-center gap-1 text-xs text-muted-foreground"><Check aria-hidden="true" className="size-3.5 text-primary" /><T>In Sonarr</T></span>
    <Button asChild variant="ghost" size="sm" className="gap-1.5 text-primary hover:text-primary"><a href={view.sonarrUrl} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" className="size-4" /><T>Open in Sonarr</T></a></Button>
    <RequestEpisodesDialog open={!!requesting} onOpenChange={value => { if (!value) setRequesting(false); }} showId={showId} series={view.series} justAdded={requesting === "added"} />
  </div>;

  return <>
    <Button type="button" variant="outline" size="sm" className="gap-2 border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary" onClick={() => setConfirming(true)}><Plus aria-hidden="true" className="size-4" /><T>Add to Sonarr</T></Button>
    <ConfirmAddDialog open={confirming} onOpenChange={setConfirming} showId={showId} series={view.series} cinetraPosterURL={cinetraPosterURL}
      onDone={(next, added) => { updateStatus(next); setConfirming(false); if (next.state === "exists") setRequesting(added ? "added" : "existing"); }} onRecheck={() => setAttempt(value => value + 1)} />
  </>;
}

function ConfirmAddDialog({ open, onOpenChange, showId, series, cinetraPosterURL, onDone, onRecheck }: {
  open: boolean; onOpenChange: (open: boolean) => void; showId: string; series: SeriesSummary; cinetraPosterURL: string | null;
  onDone: (status: SonarrStatus, added: boolean) => void; onRecheck: () => void;
}) {
  const { language } = useLanguage();
  const [options, setOptions] = useState<SonarrOptions | null>(null);
  const [optionsError, setOptionsError] = useState("");
  const [form, setForm] = useState<AddForm | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const guard = useRef(createSubmitGuard());
  const [posterFailed, setPosterFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setError(""); setOptionsError(""); setOptions(null); setForm(null); setPosterFailed(false);
    SonarrService.getOptions().then(result => { if (!active) return; setOptions(result); setForm(initialForm(result, remembered())); })
      .catch(caught => { if (active) setOptionsError(addErrorMessage(errorOf(caught).code, errorOf(caught).status)); });
    return () => { active = false; };
  }, [open]);

  const invalid = form ? validateForm(form, options) : null;
  const submit = async () => {
    if (!form || invalid) return;
    setError("");
    await guard.current(async () => {
      setSubmitting(true);
      try {
        const result = await SonarrService.addSeries(showId, addRequest(form, series.tvdbId));
        remember(form);
        onDone(result.status, true);
        toast.success(phrase(language, "Added to Sonarr"), { description: phrase(language, "Nothing is monitored yet. Choose what to request next.") });
      } catch (caught) {
        const { code, status, data } = errorOf(caught);
        if (code === "already_exists" && data?.status?.state === "exists") { onDone(data.status, false); toast(phrase(language, "This series is already in Sonarr.")); return; }
        if (code === "uncertain" || code === "identity_changed") onRecheck();
        setError(addErrorMessage(code, status));
      } finally { setSubmitting(false); }
    });
  };

  const poster = !posterFailed && series.posterUrl ? series.posterUrl : cinetraPosterURL ? posterSrc(cinetraPosterURL, "w342") : null;
  const usableFolders = options?.rootFolders.filter(folder => folder.accessible) || [];

  return <Dialog open={open} onOpenChange={value => { if (!submitting) onOpenChange(value); }}>
    <DialogContent className="grid-cols-[minmax(0,1fr)] gap-0 sm:max-w-lg" onInteractOutside={event => { if (submitting) event.preventDefault(); }}>
      <DialogHeader className="pr-10 text-left">
        <p className="cinema-eyebrow"><T>Sonarr</T></p>
        <DialogTitle className="text-xl"><T>Add to Sonarr</T></DialogTitle>
        <DialogDescription><T>Step 1 of 2: add the series with nothing monitored. Next, choose exactly which seasons or episodes to request.</T></DialogDescription>
      </DialogHeader>

      <div className="mt-4 flex gap-3 rounded-2xl border bg-card/60 p-3">
        {poster ? <img src={poster} alt="" className="h-24 w-16 shrink-0 rounded-lg object-cover" onError={() => setPosterFailed(true)} /> : <div className="flex h-24 w-16 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Tv className="size-5" /></div>}
        <div className="min-w-0 space-y-1">
          <p className="font-semibold leading-snug"><bdi>{series.title}</bdi>{displayYear(series) ? <span className="font-normal text-muted-foreground"> ({displayYear(series)})</span> : null}</p>
          <p className="text-xs text-muted-foreground">{[series.network, series.seasonCount ? `${series.seasonCount} ${phrase(language, series.seasonCount === 1 ? "season" : "seasons")}` : null].filter(Boolean).join(" · ")}</p>
          <p className="text-xs text-muted-foreground"><bdi dir="ltr">TVDB {series.tvdbId}</bdi> · {phrase(language, series.source === "tmdb_external_ids" ? "Verified from TMDB's TVDB mapping" : "Verified from Sonarr's TMDB mapping")}</p>
        </div>
      </div>

      {optionsError && <div role="alert" className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">{phrase(language, optionsError)}</div>}
      {!options && !optionsError && <p className="mt-5 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /><T>Loading Sonarr options…</T></p>}

      {options && form && <div className="mt-4 space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium"><T>Root folder</T>
            <select className={fieldClass} value={form.rootFolderId ?? ""} disabled={submitting} onChange={event => setForm({ ...form, rootFolderId: event.target.value ? Number(event.target.value) : null })}>
              {form.rootFolderId === null && <option value="">{phrase(language, "Choose…")}</option>}
              {options.rootFolders.map(folder => <option key={folder.id} value={folder.id} disabled={!folder.accessible}>{folder.path}{formatFreeSpace(folder.freeSpace) ? ` · ${formatFreeSpace(folder.freeSpace)} ${phrase(language, "free")}` : ""}{folder.accessible ? "" : ` · ${phrase(language, "unavailable")}`}</option>)}
            </select>
          </label>
          <label className="block text-sm font-medium"><T>Quality profile</T>
            <select className={fieldClass} value={form.qualityProfileId ?? ""} disabled={submitting} onChange={event => setForm({ ...form, qualityProfileId: event.target.value ? Number(event.target.value) : null })}>
              {form.qualityProfileId === null && <option value="">{phrase(language, "Choose…")}</option>}
              {options.qualityProfiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
            </select>
          </label>
        </div>
        {!usableFolders.length && <p className="text-xs text-destructive"><T>Sonarr has no accessible root folder.</T></p>}

        <div className="rounded-xl border bg-card/40 p-3">
          <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm">
            <input type="checkbox" className="mt-0.5 size-5 shrink-0 accent-[var(--primary)]" checked={form.monitorNewItems === "all"} disabled={submitting} onChange={event => setForm({ ...form, monitorNewItems: event.target.checked ? "all" : "none" })} />
            <span><span className="font-medium"><T>Monitor new seasons</T></span><span className="block text-xs text-muted-foreground"><T>Seasons added later are monitored automatically.</T></span></span>
          </label>
        </div>
        <p role="note" className="flex gap-2 rounded-xl border bg-muted/40 p-3 text-xs leading-5 text-muted-foreground"><Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" /><span><T>Adding monitors nothing and starts no search. Nothing downloads until you confirm a request in the next step.</T></span></p>
        <p className="text-xs text-muted-foreground"><T>Your Cinetra progress and status stay unchanged: downloaded episodes are never marked watched.</T></p>
      </div>}

      {error && <div role="alert" className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">{phrase(language, error)}</div>}

      <div className="mt-5 flex flex-col-reverse gap-2 pb-[env(safe-area-inset-bottom)] sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" disabled={submitting} onClick={() => onOpenChange(false)}><T>Cancel</T></Button>
        <Button type="button" className="gap-2" disabled={!form || !!invalid || submitting} title={invalid ? phrase(language, invalid) : undefined} onClick={submit}>
          {submitting ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <Plus aria-hidden="true" className="size-4" />}
          {phrase(language, submitting ? "Adding…" : "Add and choose episodes")}
        </Button>
      </div>
      {form && invalid && !submitting && options && <p className="mt-2 text-right text-xs text-muted-foreground">{phrase(language, invalid)}</p>}
    </DialogContent>
  </Dialog>;
}
