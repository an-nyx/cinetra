import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { toast } from "sonner";
import { Bookmark, Check, Download, ExternalLink, Film, Info, Loader2, Plus, RotateCw, Search } from "lucide-react";
import { T, phrase, useLanguage } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RadarrService } from "@/services/radarr.service";
import { posterSrc } from "@/lib/poster";
import RequestMovieDialog from "@/components/radarr-request";
import StatusBadge from "@/components/radarr-badge";
import {
  addActionLabel, addErrorMessage, addOutcome, addRequest, availabilityLabels, badges, createLatest, createStatusCache, createSubmitGuard, displayYear,
  formatFreeSpace, initialForm, panelView, setMonitored, validateForm,
  type AddForm, type MovieSummary, type RadarrOptions, type RadarrStatus,
} from "@/lib/radarr";

/**
 * "Add to Radarr" / "Request movie" for a library movie. Download management only: it never changes the movie's Cinetra
 * status, watch history, rating, notes or favorite. The browser talks to Cinetra's backend only.
 */
const statusCache = createStatusCache();
const REMEMBER_KEY = "cinetra-radarr-choices";
const remembered = () => { try { return JSON.parse(localStorage.getItem(REMEMBER_KEY) || "null"); } catch { return null; } };
const remember = (form: AddForm) => { try { localStorage.setItem(REMEMBER_KEY, JSON.stringify({ rootFolderId: form.rootFolderId, qualityProfileId: form.qualityProfileId })); } catch { /* storage unavailable */ } };
const errorOf = (error: unknown) => axios.isAxiosError(error) ? { code: (error.response?.data as { code?: string } | undefined)?.code, status: error.response?.status, data: error.response?.data as { status?: RadarrStatus } | undefined } : { code: undefined, status: undefined, data: undefined };

const fieldClass = "mt-1.5 block min-h-11 w-full max-w-full rounded-xl border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-primary";
const accentButton = "gap-2 border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary";

export default function RadarrPanel({ movieId, cinetraPosterURL }: { movieId: string; cinetraPosterURL: string | null }) {
  const { language } = useLanguage();
  const [status, setStatus] = useState<RadarrStatus | null>(() => statusCache.get(movieId));
  const [loadFailed, setLoadFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [requesting, setRequesting] = useState<false | "existing" | "added">(false);
  const latest = useRef(createLatest());

  useEffect(() => {
    const cached = statusCache.get(movieId);
    setLoadFailed(false);
    if (cached && attempt === 0) { setStatus(cached); return; }
    setStatus(null);
    const controller = new AbortController();
    const token = latest.current.next();
    RadarrService.getStatus(movieId, controller.signal)
      .then(result => { if (!latest.current.isLatest(token)) return; statusCache.set(movieId, result); setStatus(result); })
      .catch(error => { if (!axios.isCancel(error) && latest.current.isLatest(token)) setLoadFailed(true); });
    return () => controller.abort();
  }, [movieId, attempt]);

  /** A confirmed change replaces the status and invalidates any status request still in flight. */
  const updateStatus = (next: RadarrStatus) => { latest.current.next(); statusCache.set(movieId, next); setStatus(next); setLoadFailed(false); };
  const view = panelView(status, loadFailed);

  if (view.kind === "hidden") return null;
  return <section aria-label={phrase(language, "Radarr")} className="flex min-w-0 flex-wrap items-center gap-2">
    {view.kind === "loading" && <Button type="button" variant="outline" size="sm" disabled className="gap-2"><Loader2 className="size-4 animate-spin" /><T>Radarr</T></Button>}
    {view.kind === "notice" && <p role="status" className="flex basis-full items-start gap-1.5 text-xs leading-5 text-muted-foreground">
      <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" /><span>{phrase(language, view.message)}{view.retry && <> <button type="button" className="inline-flex min-h-6 items-center gap-1 font-medium text-primary hover:underline" onClick={() => setAttempt(value => value + 1)}><RotateCw aria-hidden="true" className="size-3" /><T>Retry</T></button></>}</span>
    </p>}
    {view.kind === "add" && <>
      <Button type="button" variant="outline" size="sm" className={accentButton} onClick={() => setConfirming(true)}><Plus aria-hidden="true" className="size-4" /><T>Add to Radarr</T></Button>
      <span className="text-xs text-muted-foreground"><T>Not in Radarr</T></span>
      <ConfirmAddDialog open={confirming} onOpenChange={setConfirming} movieId={movieId} movie={view.movie} cinetraPosterURL={cinetraPosterURL}
        onDone={(next, openRequest) => { updateStatus(next); setConfirming(false); if (openRequest && next.state === "exists") setRequesting(openRequest); }} onRecheck={() => setAttempt(value => value + 1)} />
    </>}
    {view.kind === "exists" && <>
      {view.requestable && <Button type="button" variant="outline" size="sm" className={accentButton} onClick={() => setRequesting("existing")}><Download aria-hidden="true" className="size-4" /><T>Request movie</T></Button>}
      <span className="inline-flex h-8 items-center gap-1 text-xs text-muted-foreground"><Check aria-hidden="true" className="size-3.5 text-primary" /><T>In Radarr</T></span>
      {badges(view.radarr).map(badge => <StatusBadge key={badge.key} badge={badge} />)}
      <Button asChild variant="ghost" size="sm" className="gap-1.5 text-primary hover:text-primary"><a href={view.radarrUrl} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" className="size-4" /><T>Open in Radarr</T><span className="sr-only"> <T>(opens in a new tab)</T></span></a></Button>
      <RequestMovieDialog open={!!requesting} onOpenChange={value => { if (!value) setRequesting(false); }} movieId={movieId} movie={view.movie} justAdded={requesting === "added"} onDone={updateStatus} />
    </>}
  </section>;
}

function ConfirmAddDialog({ open, onOpenChange, movieId, movie, cinetraPosterURL, onDone, onRecheck }: {
  open: boolean; onOpenChange: (open: boolean) => void; movieId: string; movie: MovieSummary; cinetraPosterURL: string | null;
  onDone: (status: RadarrStatus, openRequest: false | "added" | "existing") => void; onRecheck: () => void;
}) {
  const { language } = useLanguage();
  const [options, setOptions] = useState<RadarrOptions | null>(null);
  const [optionsError, setOptionsError] = useState("");
  const [form, setForm] = useState<AddForm | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const guard = useRef(createSubmitGuard());
  const [posterFailed, setPosterFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError(""); setOptionsError(""); setOptions(null); setForm(null); setPosterFailed(false);
    RadarrService.getOptions(controller.signal).then(result => { setOptions(result); setForm(initialForm(result, remembered())); })
      .catch(caught => { if (!axios.isCancel(caught)) setOptionsError(addErrorMessage(errorOf(caught).code, errorOf(caught).status)); });
    return () => controller.abort();
  }, [open]);

  const invalid = form ? validateForm(form, options) : null;
  const submit = async () => {
    if (!form || invalid) return;
    setError("");
    await guard.current(async () => {
      setSubmitting(true);
      try {
        const result = await RadarrService.addMovie(movieId, addRequest(form, movie.tmdbId));
        remember(form);
        const outcome = addOutcome(result);
        // Nothing monitored: continue with the separate, explicit Request Movie step.
        onDone(result.status, result.monitored ? false : "added");
        const notify = outcome.tone === "success" ? toast.success : toast.warning;
        notify(phrase(language, outcome.title), { description: outcome.lines.map(line => phrase(language, line)).join(" ") });
      } catch (caught) {
        const { code, status, data } = errorOf(caught);
        if (code === "already_exists" && data?.status?.state === "exists") { onDone(data.status, false); toast(phrase(language, "This movie is already in Radarr.")); return; }
        if (code === "uncertain" || code === "unverified" || code === "identity_changed") onRecheck();
        setError(addErrorMessage(code, status));
      } finally { setSubmitting(false); }
    });
  };

  const poster = !posterFailed && movie.posterUrl ? movie.posterUrl : cinetraPosterURL ? posterSrc(cinetraPosterURL, "w342") : null;
  const usableFolders = options?.rootFolders.filter(folder => folder.accessible) || [];
  const year = displayYear(movie);

  return <Dialog open={open} onOpenChange={value => { if (!submitting) onOpenChange(value); }}>
    <DialogContent className="grid-cols-[minmax(0,1fr)] gap-0 sm:max-w-lg" onInteractOutside={event => { if (submitting) event.preventDefault(); }}>
      <DialogHeader className="pr-10 text-left">
        <p className="cinema-eyebrow"><T>Radarr</T></p>
        <DialogTitle className="text-xl"><T>Add to Radarr</T></DialogTitle>
        <DialogDescription><T>{"Adding puts the movie in Radarr's library. By default nothing is monitored and no search starts: you can request it in the next step."}</T></DialogDescription>
      </DialogHeader>

      <div className="mt-4 flex gap-3 rounded-2xl border bg-card/60 p-3">
        {poster ? <img src={poster} alt="" className="h-24 w-16 shrink-0 rounded-lg object-cover" onError={() => setPosterFailed(true)} /> : <div className="flex h-24 w-16 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Film className="size-5" /></div>}
        <div className="min-w-0 space-y-1">
          <p className="font-semibold leading-snug"><bdi>{movie.title}</bdi>{year ? <span className="font-normal text-muted-foreground"> ({year})</span> : null}</p>
          <p className="text-xs text-muted-foreground">{[movie.studio, movie.runtime ? `${movie.runtime} min` : null].filter(Boolean).join(" · ")}</p>
          <p className="text-xs text-muted-foreground"><bdi dir="ltr">TMDB {movie.tmdbId}</bdi> · <T>Matched by TMDB ID</T></p>
        </div>
      </div>

      {optionsError && <div role="alert" className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">{phrase(language, optionsError)}</div>}
      {!options && !optionsError && <p className="mt-5 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /><T>Loading Radarr options…</T></p>}

      {options && form && <div className="mt-4 space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block min-w-0 text-sm font-medium"><T>Root folder</T>
            <select className={fieldClass} value={form.rootFolderId ?? ""} disabled={submitting} onChange={event => setForm({ ...form, rootFolderId: event.target.value ? Number(event.target.value) : null })}>
              {form.rootFolderId === null && <option value="">{phrase(language, "Choose…")}</option>}
              {options.rootFolders.map(folder => <option key={folder.id} value={folder.id} disabled={!folder.accessible}>{folder.path}{formatFreeSpace(folder.freeSpace) ? ` · ${formatFreeSpace(folder.freeSpace)} ${phrase(language, "free")}` : ""}{folder.accessible ? "" : ` · ${phrase(language, "unavailable")}`}</option>)}
            </select>
          </label>
          <label className="block min-w-0 text-sm font-medium"><T>Quality profile</T>
            <select className={fieldClass} value={form.qualityProfileId ?? ""} disabled={submitting} onChange={event => setForm({ ...form, qualityProfileId: event.target.value ? Number(event.target.value) : null })}>
              {form.qualityProfileId === null && <option value="">{phrase(language, "Choose…")}</option>}
              {options.qualityProfiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
            </select>
          </label>
          <label className="block min-w-0 text-sm font-medium sm:col-span-2"><T>Minimum availability</T>
            <select className={fieldClass} value={form.minimumAvailability} disabled={submitting} onChange={event => setForm({ ...form, minimumAvailability: event.target.value as AddForm["minimumAvailability"] })}>
              {options.minimumAvailability.map(value => <option key={value} value={value}>{phrase(language, availabilityLabels[value])}</option>)}
            </select>
            <span className="mt-1 block text-xs font-normal text-muted-foreground"><T>When Radarr considers the movie available to download.</T></span>
          </label>
        </div>
        {!usableFolders.length && <p className="text-xs text-destructive"><T>Radarr has no accessible root folder.</T></p>}

        <div className="divide-y rounded-xl border bg-card/40">
          <label className="flex min-h-11 cursor-pointer items-start gap-3 p-3 text-sm">
            <input type="checkbox" className="mt-0.5 size-5 shrink-0 accent-[var(--primary)]" checked={form.monitored} disabled={submitting} onChange={event => setForm(setMonitored(form, event.target.checked))} />
            <span><span className="font-medium"><T>Monitor movie</T></span><span className="block text-xs text-muted-foreground"><T>Radarr may grab it automatically when a suitable release appears. Monitoring alone does not start a download right away.</T></span></span>
          </label>
          <label className={`flex min-h-11 items-start gap-3 p-3 text-sm ${form.monitored ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}>
            <input type="checkbox" className="mt-0.5 size-5 shrink-0 accent-[var(--primary)]" checked={form.searchForMovie} disabled={submitting || !form.monitored} onChange={event => setForm({ ...form, searchForMovie: event.target.checked })} />
            <span><span className="font-medium"><T>Search for the movie after adding</T></span><span className="block text-xs text-muted-foreground">{phrase(language, form.monitored ? "Radarr searches now and may grab a release if one is available." : "Requires monitoring.")}</span></span>
          </label>
        </div>

        <section aria-labelledby="radarr-add-summary" className="space-y-1.5 rounded-2xl border border-primary/30 bg-primary/5 p-3 text-xs leading-5">
          <h3 id="radarr-add-summary" className="text-sm font-semibold"><T>Summary</T></h3>
          <p className="flex gap-2"><Plus aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-primary" /><span><T>{"Add the movie to Radarr's library."}</T></span></p>
          <p className="flex gap-2"><Bookmark aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-primary" /><span>{phrase(language, form.monitored ? "Monitoring: on." : "Monitoring: off. Nothing will download.")}</span></p>
          <p className="flex gap-2"><Search aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-primary" /><span>{phrase(language, form.monitored && form.searchForMovie ? "Search now: yes. A download starts only if Radarr finds a suitable release." : "Search now: no.")}</span></p>
          <p className="text-muted-foreground"><T>Your Cinetra status and rating stay unchanged: a downloaded movie is never marked watched.</T></p>
        </section>
      </div>}

      {error && <div role="alert" className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">{phrase(language, error)}</div>}

      <div className="mt-5 flex flex-col-reverse gap-2 pb-[env(safe-area-inset-bottom)] sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" className="min-h-11" disabled={submitting} onClick={() => onOpenChange(false)}><T>Cancel</T></Button>
        <Button type="button" className="h-auto min-h-11 gap-2 whitespace-normal py-2 leading-tight" disabled={!form || !!invalid || submitting} title={invalid ? phrase(language, invalid) : undefined} onClick={submit}>
          {submitting ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <Plus aria-hidden="true" className="size-4" />}
          {phrase(language, submitting ? "Adding…" : addActionLabel(form))}
        </Button>
      </div>
      {form && invalid && !submitting && options && <p className="mt-2 text-right text-xs text-muted-foreground">{phrase(language, invalid)}</p>}
    </DialogContent>
  </Dialog>;
}
