import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { toast } from "sonner";
import { AlertTriangle, Bookmark, Check, ChevronDown, Clock, Download, Info, Loader2, RotateCw, Search } from "lucide-react";
import { T, phrase, useLanguage } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SonarrService } from "@/services/sonarr.service";
import {
  REQUEST_MODES, createSubmitGuard, displayYear, episodeRequest, fill, formatAirDate, modeDescriptions, modeLabels, planIsEmpty, planSelection, reloadAfter,
  requestErrorMessage, seasonCounts, seasonSelection, selectionProblem, stateLabels, toggle, toggleMany, visibleSeasons, withoutSpecials,
  type EpisodeState, type EpisodeView, type EpisodesView, type SeasonView, type Selection, type SelectionPlan, type SeriesSummary,
} from "@/lib/sonarr";

/**
 * Request precise episodes from Sonarr for a series that is already there: the entire series, specific seasons or
 * specific episodes. It only turns monitoring on for the selection (and optionally searches its released, missing
 * episodes). It never unmonitors, deletes or re-downloads anything, and never touches Cinetra's viewing data.
 */
const POLL_MS = 2500;
const POLL_LIMIT = 24;
const locales = { en: "en-US", fr: "fr-FR", ar: "ar" } as const;
const errorOf = (error: unknown) => axios.isAxiosError(error) ? { code: (error.response?.data as { code?: string } | undefined)?.code, status: error.response?.status } : { code: undefined, status: undefined };
const initialSelection: Selection = { mode: "seasons", seasons: [], episodeIds: [], search: false };

export default function RequestEpisodesDialog({ open, onOpenChange, showId, series, justAdded = false }: {
  open: boolean; onOpenChange: (open: boolean) => void; showId: string; series: SeriesSummary; justAdded?: boolean;
}) {
  const { language } = useLanguage();
  const [view, setView] = useState<EpisodesView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [polls, setPolls] = useState(0);
  const [reload, setReload] = useState(0);
  const [selection, setSelection] = useState<Selection>(initialSelection);
  const [showSpecials, setShowSpecials] = useState(false);
  const [expanded, setExpanded] = useState<number[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const guard = useRef(createSubmitGuard());

  useEffect(() => {
    if (!open) return;
    setSelection(initialSelection); setShowSpecials(false); setExpanded([]); setError(""); setPolls(0); setView(null);
  }, [open]);

  // Load Sonarr's seasons/episodes; right after adding, Sonarr needs a few seconds to fill them in, so poll briefly.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoadError("");
    SonarrService.getEpisodes(showId, controller.signal).then(result => {
      setView(result);
      if (result.pending && polls < POLL_LIMIT) timer = setTimeout(() => setPolls(value => value + 1), POLL_MS);
      if (!result.pending) setExpanded(current => current.length ? current : defaultExpanded(result));
    }).catch(caught => { if (!axios.isCancel(caught)) setLoadError(requestErrorMessage(errorOf(caught).code, errorOf(caught).status)); });
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [open, showId, polls, reload]);

  const plan = useMemo(() => view && !view.pending ? planSelection(view, selection) : null, [view, selection]);
  const problem = selectionProblem(view, selection, plan);
  const seasons = view ? visibleSeasons(view, showSpecials) : [];
  const hasSpecials = !!view?.seasons.some(season => season.seasonNumber === 0 && season.episodes.length);
  const locale = locales[language] || "en-US";

  const setMode = (mode: Selection["mode"]) => setSelection(current => ({ ...current, mode }));
  const submit = async () => {
    if (!view || !plan || problem) return;
    setError("");
    await guard.current(async () => {
      setSubmitting(true);
      try {
        const result = await SonarrService.requestEpisodes(showId, episodeRequest(view, selection, plan));
        setView(result.view);
        const parts = [fill(phrase(language, "Episodes newly monitored: {n}"), { n: result.monitored })];
        if (result.searched) parts.push(fill(phrase(language, "Searching now: {n}"), { n: result.searched }));
        toast.success(phrase(language, "Sonarr updated"), { description: parts.join(" · ") });
        onOpenChange(false);
      } catch (caught) {
        const { code, status } = errorOf(caught);
        setError(requestErrorMessage(code, status));
        if (reloadAfter(code)) { setSelection(current => ({ ...current, search: false })); setReload(value => value + 1); }
      } finally { setSubmitting(false); }
    });
  };

  return <Dialog open={open} onOpenChange={value => { if (!submitting) onOpenChange(value); }}>
    <DialogContent className="grid-cols-[minmax(0,1fr)] gap-0 pb-0 sm:max-w-xl sm:pb-0" onInteractOutside={event => { if (submitting) event.preventDefault(); }}>
      <DialogHeader className="pr-10 text-left">
        <p className="cinema-eyebrow"><T>Sonarr</T></p>
        <DialogTitle className="text-xl"><T>Request episodes</T></DialogTitle>
        <DialogDescription>
          <bdi>{series.title}</bdi>{displayYear(series) ? ` (${displayYear(series)})` : ""} · <T>Choose exactly what Sonarr should monitor.</T>
        </DialogDescription>
      </DialogHeader>

      {justAdded && <p role="status" className="mt-4 flex gap-2 rounded-xl border border-primary/30 bg-primary/10 p-3 text-xs leading-5"><Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" /><span><T>Added to Sonarr with nothing monitored. Now choose what to request.</T></span></p>}

      {loadError && <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">
        <span>{phrase(language, loadError)}</span>
        <Button type="button" size="sm" variant="ghost" className="gap-1.5" onClick={() => { setPolls(0); setReload(value => value + 1); }}><RotateCw aria-hidden="true" className="size-4" /><T>Retry</T></Button>
      </div>}
      {!view && !loadError && <p className="mt-5 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 aria-hidden="true" className="size-4 animate-spin" /><T>Loading episodes from Sonarr…</T></p>}
      {view?.pending && !loadError && <div role="status" className="mt-5 space-y-2 text-sm text-muted-foreground">
        {polls < POLL_LIMIT
          ? <p className="flex items-center gap-2"><Loader2 aria-hidden="true" className="size-4 animate-spin" /><T>Sonarr is loading the episodes…</T></p>
          : <p className="flex flex-wrap items-center gap-2"><T>Sonarr is still loading episodes.</T>
            <Button type="button" size="sm" variant="ghost" className="gap-1.5" onClick={() => setPolls(0)}><RotateCw aria-hidden="true" className="size-4" /><T>Check again</T></Button></p>}
      </div>}

      {view && !view.pending && plan && <div className="mt-4 space-y-4">
        <div role="radiogroup" aria-label={phrase(language, "What to request")} className="grid grid-cols-3 gap-1 rounded-2xl border bg-card/60 p-1">
          {REQUEST_MODES.map(mode => <button key={mode} type="button" role="radio" aria-checked={selection.mode === mode} disabled={submitting} onClick={() => setMode(mode)}
            className={`min-h-11 rounded-xl px-2 text-xs font-medium leading-tight transition-colors focus-visible:outline-2 focus-visible:outline-primary sm:text-sm ${selection.mode === mode ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
            {phrase(language, modeLabels[mode])}
          </button>)}
        </div>
        <p className="text-xs text-muted-foreground">{phrase(language, modeDescriptions[selection.mode])} <T>Numbering follows Sonarr.</T></p>

        {selection.mode === "series" && <SeriesOverview seasons={visibleSeasons(view, false)} />}
        {selection.mode === "seasons" && <ul className="space-y-2">
          {seasons.map(season => <li key={season.seasonNumber}>
            <label className="flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border bg-card/40 px-3 py-2.5 has-[:checked]:border-primary/50 has-[:checked]:bg-primary/5">
              <input type="checkbox" className="size-5 shrink-0 accent-[var(--primary)]" disabled={submitting} checked={selection.seasons.includes(season.seasonNumber)}
                onChange={event => setSelection(current => ({ ...current, seasons: toggle(current.seasons, season.seasonNumber, event.target.checked) }))} />
              <SeasonLine season={season} />
            </label>
          </li>)}
        </ul>}
        {selection.mode === "episodes" && <ul className="space-y-2">
          {seasons.map(season => <EpisodeSeason key={season.seasonNumber} season={season} locale={locale} disabled={submitting}
            open={expanded.includes(season.seasonNumber)} onToggleOpen={() => setExpanded(current => toggle(current, season.seasonNumber, !current.includes(season.seasonNumber)))}
            selected={selection.episodeIds} onSelect={(ids, on) => setSelection(current => ({ ...current, episodeIds: toggleMany(current.episodeIds, ids, on) }))} />)}
        </ul>}

        {hasSpecials && selection.mode !== "series" && <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
          <input type="checkbox" className="size-5 shrink-0 accent-[var(--primary)]" checked={showSpecials} disabled={submitting}
            onChange={event => { setShowSpecials(event.target.checked); if (!event.target.checked) setSelection(current => withoutSpecials(view, current)); }} />
          <span><span className="font-medium"><T>Show specials</T></span><span className="block text-xs text-muted-foreground"><T>Season 0 is excluded unless you choose it.</T></span></span>
        </label>}

        <label className={`flex min-h-11 items-start gap-3 rounded-xl border bg-card/40 p-3 text-sm ${plan.searchable ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}>
          <input type="checkbox" className="mt-0.5 size-5 shrink-0 accent-[var(--primary)]" checked={selection.search && plan.searchable > 0} disabled={submitting || !plan.searchable}
            onChange={event => setSelection(current => ({ ...current, search: event.target.checked }))} />
          <span><span className="font-medium"><T>Search for missing episodes now</T></span>
            <span className="block text-xs text-muted-foreground">{plan.searchable
              ? fill(phrase(language, "Searches only the {n} released episodes in this selection that have no file."), { n: plan.searchable })
              : phrase(language, plan.selectedIds.length ? "Nothing in this selection is both released and missing." : "Select episodes to see what can be searched.")}</span></span>
        </label>

        <Summary plan={plan} selection={selection} />
      </div>}

      {error && <div role="alert" className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">{phrase(language, error)}</div>}

      <div className="sticky bottom-0 -mx-5 mt-5 border-t bg-background/95 px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur sm:-mx-6 sm:px-6 sm:pb-6">
        {problem && view && !view.pending && <p className="mb-2 text-xs text-muted-foreground">{phrase(language, problem)}</p>}
        <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 sm:flex sm:justify-end">
          <Button type="button" variant="ghost" className="min-h-11" disabled={submitting} onClick={() => onOpenChange(false)}><T>Cancel</T></Button>
          <Button type="button" className="h-auto min-h-11 gap-2 whitespace-normal py-2 leading-tight" disabled={!!problem || submitting} onClick={submit}>
            {submitting ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : selection.search && plan?.searchIds.length ? <Search aria-hidden="true" className="size-4" /> : <Bookmark aria-hidden="true" className="size-4" />}
            {phrase(language, submitting ? "Updating Sonarr…" : selection.search && plan?.searchIds.length ? "Confirm, monitor and search" : "Confirm and monitor")}
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}

/** Latest regular season with something missing, else the latest regular season. */
function defaultExpanded(view: EpisodesView) {
  const regular = view.seasons.filter(season => season.seasonNumber > 0 && season.episodes.length);
  const withMissing = [...regular].reverse().find(season => season.episodes.some(episode => episode.state === "missing"));
  const pick = withMissing || regular[regular.length - 1];
  return pick ? [pick.seasonNumber] : [];
}

function seasonName(language: Parameters<typeof phrase>[0], seasonNumber: number) {
  return seasonNumber === 0 ? phrase(language, "Specials") : fill(phrase(language, "Season {n}"), { n: seasonNumber });
}

function SeasonLine({ season }: { season: SeasonView }) {
  const { language } = useLanguage();
  const counts = seasonCounts(season.episodes);
  return <span className="min-w-0 flex-1">
    <span className="flex items-center gap-2 font-medium">{seasonName(language, season.seasonNumber)}
      {season.monitored && <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[0.7rem] font-medium text-primary"><Bookmark aria-hidden="true" className="size-3" /><T>Monitored</T></span>}
    </span>
    <Counts counts={counts} />
  </span>;
}

function Counts({ counts }: { counts: ReturnType<typeof seasonCounts> }) {
  const { language } = useLanguage();
  return <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
    <span>{fill(phrase(language, "Episodes: {n}"), { n: counts.total })}</span>
    {counts.downloaded > 0 && <span className="text-primary">{fill(phrase(language, "On disk: {n}"), { n: counts.downloaded })}</span>}
    {counts.missing > 0 && <span className="text-amber-500 dark:text-amber-300">{fill(phrase(language, "Missing: {n}"), { n: counts.missing })}</span>}
    {counts.unreleased > 0 && <span>{fill(phrase(language, "Not released: {n}"), { n: counts.unreleased })}</span>}
  </span>;
}

function SeriesOverview({ seasons }: { seasons: SeasonView[] }) {
  const { language } = useLanguage();
  const counts = seasonCounts(seasons.flatMap(season => season.episodes));
  return <div className="rounded-xl border bg-card/40 p-3 text-sm">
    <p className="font-medium">{fill(phrase(language, "Regular seasons: {n}"), { n: seasons.length })}</p>
    <Counts counts={counts} />
  </div>;
}

const stateStyle: Record<EpisodeState, string> = {
  downloaded: "bg-primary/15 text-primary",
  missing: "bg-amber-400/15 text-amber-600 dark:text-amber-300",
  unreleased: "bg-muted text-muted-foreground",
};
const stateIcon = { downloaded: Download, missing: AlertTriangle, unreleased: Clock } as const;

function EpisodeSeason({ season, open, onToggleOpen, selected, onSelect, locale, disabled }: {
  season: SeasonView; open: boolean; onToggleOpen: () => void; selected: number[]; onSelect: (ids: number[], on: boolean) => void; locale: string; disabled: boolean;
}) {
  const { language } = useLanguage();
  const all = seasonSelection(season, selected);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => { if (box.current) box.current.indeterminate = all === "some"; }, [all]);
  const missing = season.episodes.filter(episode => episode.state === "missing").map(episode => episode.id);
  const pickedHere = season.episodes.filter(episode => selected.includes(episode.id)).length;
  const listId = `sonarr-season-${season.seasonNumber}`;
  return <li className="overflow-hidden rounded-xl border bg-card/40">
    <div className="flex min-h-14 items-center gap-3 px-3 py-2">
      <input ref={box} type="checkbox" className="size-5 shrink-0 accent-[var(--primary)]" disabled={disabled} checked={all === "all"}
        aria-label={fill(phrase(language, "Select every episode of {season}"), { season: seasonName(language, season.seasonNumber) })}
        onChange={event => onSelect(season.episodes.map(episode => episode.id), event.target.checked)} />
      <button type="button" className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={open} aria-controls={listId} onClick={onToggleOpen}>
        <SeasonLine season={season} />
        {pickedHere > 0 && <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">{pickedHere}</span>}
        <ChevronDown aria-hidden="true" className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
    </div>
    {open && <div id={listId} className="border-t">
      {missing.length > 0 && <div className="flex justify-end px-3 pt-2">
        <button type="button" disabled={disabled} className="min-h-9 rounded-lg px-2 text-xs font-medium text-primary hover:bg-primary/10" onClick={() => onSelect(missing, true)}><T>Select missing</T></button>
      </div>}
      <ul className="divide-y">
        {season.episodes.map(episode => <EpisodeRow key={episode.id} episode={episode} locale={locale} disabled={disabled} checked={selected.includes(episode.id)} onChange={on => onSelect([episode.id], on)} />)}
      </ul>
    </div>}
  </li>;
}

function EpisodeRow({ episode, checked, onChange, locale, disabled }: { episode: EpisodeView; checked: boolean; onChange: (on: boolean) => void; locale: string; disabled: boolean }) {
  const { language } = useLanguage();
  const Icon = stateIcon[episode.state];
  const date = formatAirDate(episode.airDateUtc, locale);
  return <li>
    <label className="flex min-h-14 cursor-pointer items-center gap-3 px-3 py-2 has-[:checked]:bg-primary/5">
      <input type="checkbox" className="size-5 shrink-0 accent-[var(--primary)]" disabled={disabled} checked={checked} onChange={event => onChange(event.target.checked)} />
      <span className="w-9 shrink-0 font-mono text-xs text-muted-foreground" dir="ltr">E{String(episode.episodeNumber).padStart(2, "0")}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{episode.title ? <bdi>{episode.title}</bdi> : <span className="text-muted-foreground"><T>Untitled</T></span>}</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">{date || phrase(language, "No air date yet")}
          {episode.monitored && <span className="inline-flex items-center gap-0.5 text-primary"><Bookmark aria-hidden="true" className="size-3" /><span className="sr-only sm:not-sr-only"><T>Monitored</T></span></span>}
        </span>
      </span>
      <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[0.7rem] font-medium ${stateStyle[episode.state]}`}>
        <Icon aria-hidden="true" className="size-3" />{phrase(language, stateLabels[episode.state])}
      </span>
    </label>
  </li>;
}

function Summary({ plan, selection }: { plan: SelectionPlan; selection: Selection }) {
  const { language } = useLanguage();
  if (!plan.selectedIds.length) return null;
  const seasonList = plan.seasonNumbers.map(number => seasonName(language, number)).join(", ");
  const empty = planIsEmpty(plan);
  return <section aria-labelledby="sonarr-summary" className="space-y-2 rounded-2xl border border-primary/30 bg-primary/5 p-3 text-sm">
    <h3 id="sonarr-summary" className="font-semibold"><T>Summary</T></h3>
    <ul className="space-y-1.5 text-xs leading-5">
      <li className="flex gap-2"><Bookmark aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-primary" /><span>
        {fill(phrase(language, "Episodes to monitor: {n}"), { n: plan.monitorIds.length })}
        {plan.counts.monitored > 0 && <span className="text-muted-foreground"> · {fill(phrase(language, "already monitored: {n}"), { n: plan.counts.monitored })}</span>}
      </span></li>
      {plan.seasonNumbers.length > 0 && <li className="flex gap-2"><Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-primary" /><span>
        {fill(phrase(language, "Seasons set to monitored: {seasons}. Episodes Sonarr adds to them later are monitored too."), { seasons: seasonList })}
      </span></li>}
      {plan.enableSeries && <li className="flex gap-2"><Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-primary" /><span><T>Series monitoring will be turned on (required for downloads).</T></span></li>}
      {plan.alsoActivated > 0 && <li className="flex gap-2"><AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-amber-400" /><span>
        {fill(phrase(language, "{n} other episodes were already marked monitored in Sonarr and become active too. Cinetra leaves them as they are."), { n: plan.alsoActivated })}
      </span></li>}
      <li className="flex gap-2"><Search aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-primary" /><span>
        {selection.search && plan.searchIds.length
          ? fill(phrase(language, "Search now: {n} released, missing episodes. Nothing else is searched."), { n: plan.searchIds.length })
          : phrase(language, "No search now. Sonarr grabs monitored episodes as they appear in its RSS feeds.")}
      </span></li>
      {(plan.counts.downloaded > 0 || plan.counts.unreleased > 0) && <li className="flex gap-2 text-muted-foreground"><Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" /><span>
        {fill(phrase(language, "In this selection: {d} on disk, {m} missing, {u} not released yet."), { d: plan.counts.downloaded, m: plan.counts.missing, u: plan.counts.unreleased })}
      </span></li>}
    </ul>
    <p className="text-xs text-muted-foreground">{phrase(language, empty ? "Everything selected is already monitored." : "Nothing is unmonitored, deleted or re-downloaded. Your Cinetra progress is unchanged.")}</p>
  </section>;
}
