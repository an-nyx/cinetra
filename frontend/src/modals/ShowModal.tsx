import { posterSrc } from "@/lib/poster";
import { useEffect, useState } from "react";
import { ShowService } from "@/services";
import type { EpisodeGuide, TrackingSummary, TrackedEpisode } from "@/services/show.service";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ShowType } from "@/types/index.ts";
import { Check, CalendarDays, Pencil, Play, Trash2, Tv } from "lucide-react";
import EditShowMatch from "./EditShowMatch";

interface Props {
  selectedShow: string | null;
  closeModal: () => void;
  shows: ShowType[];
  setShows: React.Dispatch<React.SetStateAction<ShowType[]>>;
  type: "show" | "movie";
  /** Open straight into Edit show (e.g. "Fix match" from Needs review). */
  initialEditMatch?: boolean;
}
const code = (episode: TrackedEpisode) => `S${String(episode.season).padStart(2, '0')}E${String(episode.number).padStart(2, '0')}`;
const today = () => new Date().toISOString().slice(0, 10);

export default function ShowModal({ selectedShow, closeModal, shows, setShows, initialEditMatch = false }: Props) {
  const show = shows.find(item => item.id === selectedShow);
  const [summary, setSummary] = useState<TrackingSummary | null>(null);
  const [guide, setGuide] = useState<EpisodeGuide | null>(null);
  const [season, setSeason] = useState(1);
  const [editing, setEditing] = useState(false);
  const [editSeason, setEditSeason] = useState(1);
  const [editEpisode, setEditEpisode] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editingMatch, setEditingMatch] = useState(false);
  const [matchNotice, setMatchNotice] = useState("");

  const refresh = async (id: string, selectedSeason?: number) => {
    const data = await ShowService.getTrackingSummary(id);
    setSummary(data);
    const nextSeason = selectedSeason || data.nextEpisode?.season || data.lastEpisode?.season || 1;
    const loaded = await ShowService.getEpisodeGuide(id, nextSeason).catch(() => null);
    setGuide(loaded);
    if (loaded) setSeason(loaded.season);
    window.dispatchEvent(new Event('tracking-updated'));
  };

  useEffect(() => {
    if (!selectedShow) { setGuide(null); setSummary(null); return; }
    let active = true;
    setBusy(true); setError(""); setGuide(null); setSummary(null); setEditing(false);
    ShowService.getTrackingSummary(selectedShow).then(async data => {
      if (!active) return;
      setSummary(data);
      const loaded = await ShowService.getEpisodeGuide(selectedShow, data.nextEpisode?.season || data.lastEpisode?.season || 1).catch(() => null);
      if (active) { setGuide(loaded); if (loaded) setSeason(loaded.season); }
    }).catch(() => { if (active) setError('Could not load saved progress. Please retry.'); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [selectedShow]);

  useEffect(() => { setEditingMatch(!!selectedShow && initialEditMatch); setMatchNotice(""); }, [selectedShow, initialEditMatch]);

  // After Edit show: reload the guide and show; if saved progress no longer fits, open Edit progress for review.
  const matchApplied = async ({ needsReview }: { needsReview: boolean }) => {
    if (!selectedShow) return;
    setEditingMatch(false);
    await act(async () => {
      const updated = await ShowService.getShowById(selectedShow);
      setShows(current => current.map(item => item.id === updated.id ? updated : item));
    }, 1);
    setMatchNotice(needsReview ? 'Linked to the new series. Your saved progress was kept unchanged; it does not fit this series, so please review it below.' : 'Linked to the new series. Your progress, status and favorite were kept.');
    if (needsReview) { setEditing(true); window.setTimeout(() => document.getElementById('saved-position')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); }
  };

  const act = async (action: () => Promise<unknown>, selectedSeason = season) => {
    if (!selectedShow || busy) return;
    setBusy(true); setError("");
    try {
      await action();
      // Marking the next episode can advance the saved checkpoint server-side; show the stored position at once.
      const [, updated] = await Promise.all([refresh(selectedShow, selectedSeason), ShowService.getShowById(selectedShow).catch(() => null)]);
      if (updated) setShows(current => current.map(item => item.id === updated.id ? updated : item));
    }
    catch { setError('Could not save progress. Please try again.'); }
    finally { setBusy(false); }
  };
  const selectSeason = async (value: number) => {
    if (!selectedShow) return;
    setBusy(true); setError("");
    try { setGuide(await ShowService.getEpisodeGuide(selectedShow, value)); setSeason(value); }
    catch { setError('Could not load this season.'); }
    finally { setBusy(false); }
  };
  const updateStatus = async (status: NonNullable<ShowType['status']>) => {
    if (!selectedShow) return;
    await act(async () => {
      const updated = await ShowService.updateShow(selectedShow, { status, completed: status === 'completed' });
      setShows(current => current.map(item => item.id === updated.id ? updated : item));
    });
  };
  const deleteShow = async () => {
    if (!selectedShow) return;
    setBusy(true);
    try { await ShowService.deleteShow(selectedShow); setShows(current => current.filter(item => item.id !== selectedShow)); closeModal(); }
    catch { setError('Could not delete this show.'); setBusy(false); }
  };

  return <Dialog open={!!selectedShow} onOpenChange={open => { if (!open) closeModal(); }}>
    <DialogContent className="fixed inset-0 left-0 top-0 h-[100dvh] max-h-[100dvh] w-screen max-w-none translate-x-0 translate-y-0 flex flex-col overflow-hidden rounded-none p-0 [&>[data-slot=dialog-close]]:top-[max(0.5rem,env(safe-area-inset-top))] sm:[&>[data-slot=dialog-close]]:top-3 sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[92vh] sm:w-full sm:max-w-4xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg">
      <DialogHeader className="shrink-0 border-b bg-background px-5 pb-4 pt-[max(1.25rem,env(safe-area-inset-top))] sm:px-7 sm:py-5">
        <p className="cinema-eyebrow">The watch room</p>
        <DialogTitle className="pr-8 text-2xl sm:text-3xl">{show?.name || 'TV show'}</DialogTitle>
        <DialogDescription>Episode tracking · {summary ? summary.source || 'Guide unavailable' : 'Loading guide'}</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-5 pb-[max(1.75rem,env(safe-area-inset-bottom))] sm:px-7">
        {editingMatch && show ? <EditShowMatch showId={show.id} showName={show.name} showPosterURL={show.posterURL || null} currentTmdbId={show.tmdbId ?? null} onCancel={() => setEditingMatch(false)} onApplied={matchApplied} /> : <>
          {matchNotice && <p role="status" className="mt-4 rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm">{matchNotice}</p>}
          {show && <div className="flex gap-4 py-6 sm:gap-6">
            {show.posterURL ? <img src={posterSrc(show.posterURL, "w342")} alt="" className="cinema-poster h-36 w-24 shrink-0 rounded-xl object-cover sm:h-44 sm:w-30" /> : <div className="flex h-36 w-24 shrink-0 items-center justify-center rounded-xl bg-muted"><Tv /></div>}
            <div className="min-w-0 flex-1 space-y-3">
              <div className="flex flex-wrap items-center gap-2"><span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Personal status</span>
                <div role="group" aria-label="Personal status" className="flex flex-wrap rounded-xl border bg-card p-1">
                  {(['watching', 'completed', 'dropped'] as const).map(value => <button key={value} type="button" aria-pressed={(show.status || (show.completed ? 'completed' : null)) === value} disabled={busy} onClick={() => updateStatus(value)} className={`min-h-10 rounded-lg px-4 text-sm font-medium capitalize ${(show.status || (show.completed ? 'completed' : null)) === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>{value}</button>)}
                </div>
                {show.status && !['watching', 'completed', 'dropped'].includes(show.status) && <span className="text-xs text-muted-foreground">Saved legacy status: {show.status}. Choose a new status only if you want to change it.</span>}
                {!show.status && !show.completed && <span className="text-xs text-muted-foreground">No status selected</span>}
              </div>
              <p className="line-clamp-4 text-sm leading-6 text-muted-foreground">{show.overview || 'No overview available.'}</p>
              {summary && <p className="text-xs text-muted-foreground">{summary.countDataAvailable ? `${summary.watchedCount} effectively watched · ${summary.releasedCount} released episodes` : 'Episode counts unavailable; your saved viewing position is preserved below.'}</p>}
              <Button type="button" variant="outline" size="sm" className="gap-2" disabled={busy} onClick={() => { setMatchNotice(""); setEditingMatch(true); }}><Pencil className="size-4" />Edit show</Button>
            </div>
          </div>}
          {error && <div role="alert" className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">{error}</div>}
          {busy && !summary && <p className="py-8 text-sm text-muted-foreground">Loading real episode data…</p>}
          {show && <section id="saved-position" className="mb-5 rounded-2xl border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-semibold">Saved viewing position</p><p className="text-sm text-muted-foreground">Saved position: S{String(show.seasonsWatched).padStart(2, '0')}E{String(show.episodesWatched).padStart(2, '0')}</p><p className="text-sm font-medium">{show.episodesWatched === 0 ? show.seasonsWatched > 1 ? `Seasons 1–${show.seasonsWatched - 1} complete; Season ${show.seasonsWatched} not started.` : 'Season 1 not started.' : `${show.seasonsWatched > 1 ? `Seasons 1–${show.seasonsWatched - 1} complete; ` : ''}${show.episodesWatched} episodes watched in Season ${show.seasonsWatched}.`}</p></div><Button type="button" variant="outline" onClick={() => { setEditSeason(show.seasonsWatched || 1); setEditEpisode(show.episodesWatched); setEditing(!editing); }}>Edit progress</Button></div>
            {editing && <div className="mt-4 space-y-3"><p className="text-sm text-muted-foreground">Select the season and number of episodes watched in it. Saving changes only this position; confirmed episode history stays untouched.</p><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Season<select aria-label="Progress season" className="mt-1 block min-h-11 w-full max-w-full rounded-lg border bg-background px-3" value={editSeason} onChange={e => { const value = Number(e.target.value); setEditSeason(value); setEditEpisode(0); if (selectedShow) ShowService.getEpisodeGuide(selectedShow, value).then(setGuide).catch(() => setGuide(null)); }}>{Array.from(new Set([editSeason, ...Array.from({ length: Math.max(guide?.seasons.length || 0, editSeason, 1) + 1 }, (_, i) => i + 1)])).map(n => <option key={n} value={n}>Season {n}</option>)}</select></label><label className="text-sm">Episodes watched in season{guide?.season === editSeason && guide.episodes.length ? <select aria-label="Episodes watched in season" className="mt-1 block min-h-11 w-full max-w-full rounded-lg border bg-background px-3" value={editEpisode} onChange={e => setEditEpisode(Number(e.target.value))}><option value={0}>0 · Season not started</option>{guide.episodes.map(e => <option key={e.number} value={e.number}>{e.number} · {e.name}</option>)}{editEpisode > 0 && !guide.episodes.some(e => e.number === editEpisode) && <option value={editEpisode}>{editEpisode} · Saved position (metadata missing)</option>}</select> : <input aria-label="Episodes watched in season" type="number" min="0" max="999" className="mt-1 block min-h-11 w-full rounded-lg border bg-background px-3" value={editEpisode} onChange={e => setEditEpisode(Number(e.target.value))} />}</label></div><p className="text-xs text-muted-foreground">Changing this position changes which episodes are covered by it, including episodes in earlier seasons. Individual watch records are preserved.</p><Button disabled={busy || !Number.isInteger(editEpisode) || editEpisode < 0 || editEpisode > 999} onClick={() => act(async () => { const updated = await ShowService.updateShow(show.id, { seasonsWatched: editSeason, episodesWatched: editEpisode }); setShows(current => current.map(item => item.id === updated.id ? updated : item)); setEditing(false); })}>Save position</Button></div>}
          </section>}
          {summary && <div className="space-y-5">
            {summary.newSeasonToWatch && <section className="rounded-xl border border-primary/30 bg-primary/5 p-4" role="status"><h3 className="font-semibold">New season to watch</h3><p className="mt-1 text-sm text-muted-foreground">Season {summary.newSeasonToWatch.season} · {summary.newSeasonToWatch.count} released, unwatched episode{summary.newSeasonToWatch.count === 1 ? '' : 's'}. Your personal status is still Completed.</p><Button className="mt-3" variant="outline" disabled={busy} onClick={() => updateStatus('watching')}>Resume Watching</Button></section>}
            <section className="cinema-surface p-5 sm:p-6">
              {summary.statusProgressNote && <p role="status" className="mb-4 rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm">{summary.statusProgressNote}</p>}
              <div className="mb-2 flex items-end justify-between"><div><p className="cinema-eyebrow">Your progress</p><p className="mt-1 text-3xl font-semibold">{summary.progressPercent === null ? summary.progressUnavailable?.label || "Unavailable" : `${summary.progressPercent}%`} {summary.progressPercent !== null && <span className="text-sm font-normal text-muted-foreground">of released episodes</span>}</p></div><span className="text-sm text-muted-foreground">{summary.countDataAvailable ? `${summary.watchedCount}/${summary.releasedCount} watched` : 'Episode count unavailable'}</span></div>
              {summary.progressPercent === null && summary.progressUnavailable && <p role="status" className="mb-3 rounded-xl border bg-muted/40 p-3 text-sm text-muted-foreground"><span className="font-medium text-foreground">Why no percentage: </span>{summary.progressUnavailable.detail}</p>}
              <p className="mb-4 text-xs text-muted-foreground">{summary.explicitWatchedCount} individually logged · {summary.legacyInferredCount} covered by saved position</p>
              {summary.progressPercent !== null && <div role="progressbar" aria-valuenow={summary.progressPercent} aria-valuemin={0} aria-valuemax={100} aria-label="Released episode progress" className="cinema-progress h-2"><span style={{ width: `${summary.progressPercent}%` }} /></div>}
              {summary.legacyPosition && <p className="mt-2 text-xs text-muted-foreground">The saved position is reflected in watched episodes without creating episode records.</p>}
              {summary.legacyPosition?.needsReview && <p role="status" className="mt-2 text-sm text-amber-300">The saved position does not fit the available TMDB episode metadata. It is preserved and needs review.</p>}
              {summary.viewingState === 'fully_watched' && <p className="mt-2 font-medium text-primary">Fully watched · series completion verified</p>}
              {summary.viewingState === 'caught_up' && <p className="mt-2 text-sm text-muted-foreground">Caught up with currently released episodes. Future episodes may follow.</p>}
              {summary.viewingState === 'not_started' && <p className="mt-2 text-sm text-muted-foreground">Not started · no saved position or watched episodes yet.</p>}
            </section>
            <div className="grid gap-3 sm:grid-cols-2">
              <section className="cinema-surface border-primary/30 bg-primary/5 p-5">
                <p className="cinema-eyebrow mb-2">Watch next</p>
                {summary.nextEpisode ? <><h3 className="font-semibold">{code(summary.nextEpisode)} · {summary.nextEpisode.name}</h3><p className="mt-1 text-xs text-muted-foreground">Released {summary.nextEpisode.airDate} · {summary.remainingCount} remaining</p><Button className="mt-4 w-full gap-2" disabled={busy} onClick={() => act(() => ShowService.setEpisodeWatched(summary.showId, summary.nextEpisode!.season, summary.nextEpisode!.number, true), summary.nextEpisode!.season)}><Play className="size-4" />Mark next episode watched</Button></> : <p className="text-sm text-muted-foreground">{summary.viewingState === "fully_watched" ? "Final regular episode watched. The series is confirmed ended." : summary.viewingState === "caught_up" ? "Caught up with currently released episodes; future episodes may follow." : summary.legacyPosition ? "Next episode unknown from saved position." : summary.guideAvailable ? "No released episode to track." : "Episode guide unavailable. Your saved position remains editable above."}</p>}
              </section>
              <section className="cinema-surface p-5"><p className="cinema-eyebrow mb-2">Last watched</p>
                <p className="font-semibold">{summary.lastEpisode ? `${code(summary.lastEpisode)} · ${summary.lastEpisode.name}` : summary.legacyPosition ? `Saved through S${String(summary.legacyPosition.fullSeasons).padStart(2, '0')}E${String(summary.legacyPosition.episodesInNextSeason).padStart(2, '0')}` : 'No episodes logged yet'}</p>
                {!summary.lastEpisode && summary.legacyPosition && <p className="mt-1 text-xs text-muted-foreground">Position saved by the legacy counter; no individual watch date is recorded.</p>}
                <p className="mt-2 text-xs text-muted-foreground">{summary.upcomingEpisode ? `Upcoming: ${code(summary.upcomingEpisode)} · ${summary.upcomingEpisode.airDate}` : 'No upcoming air date announced'}</p>
              </section>
            </div>
            {guide && <section className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="cinema-eyebrow">Episode guide</p><h3 className="mt-1 text-xl font-semibold">Seasons & episodes</h3></div><select aria-label="Season" className="min-h-10 max-w-full rounded-xl border bg-background px-3 text-sm" value={season} onChange={e => selectSeason(Number(e.target.value))}>{guide?.seasons.map(item => <option key={item.number} value={item.number}>Season {item.number} · {item.episodeCount} episodes</option>)}</select></div>
              {summary.legacyInferredCount > 0 && <p className="text-xs text-muted-foreground">Saved position and individual watches are separate. Tap an individual watch to remove it; a saved-position check remains until you edit that position.</p>}
              {guide && <><Button variant="outline" size="sm" disabled={busy || !guide.episodes.some(e => e.airDate && e.airDate <= today() && !e.watched)} onClick={() => act(() => ShowService.markSeasonWatched(summary.showId, season))}>Mark released season episodes watched</Button>
                <div className="space-y-1">{guide.episodes.map(e => {
                  const aired = !!e.airDate && e.airDate <= today();
                  const inferred = e.watchSource === 'legacy';
                  const logged = e.watchSource === 'explicit' || e.watchSource === 'both';
                  const codeLabel = code({ ...e, season });
                  return <button key={e.number} type="button" aria-label={`${logged ? 'Remove individual watch' : inferred ? 'Edit saved position for' : 'Mark watched'} ${codeLabel} ${e.name}`} aria-pressed={e.watched} disabled={busy || (!aired && !logged)} title={inferred ? 'Edit saved position' : undefined} onClick={() => inferred ? (setEditSeason(show?.seasonsWatched || 1), setEditEpisode(show?.episodesWatched || 0), setEditing(true), setError('This episode is covered by your saved position. Edit progress below to correct it; individual watches remain unchanged.'), document.getElementById('saved-position')?.scrollIntoView({ behavior: 'smooth', block: 'start' })) : act(() => ShowService.setEpisodeWatched(summary.showId, season, e.number, !logged))} className="flex min-h-14 w-full items-center gap-3 rounded-xl border bg-card/50 px-3 py-3 text-left transition-[background-color,border-color] hover:border-primary/50 hover:bg-primary/5 disabled:cursor-default disabled:opacity-65">
                    <span className={`flex size-7 shrink-0 items-center justify-center rounded-full border ${e.watched ? 'border-primary bg-primary text-primary-foreground' : ''}`}>{e.watched && <Check className="size-4" />}</span>
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">S{String(season).padStart(2,'0')}E{String(e.number).padStart(2,'0')} · {e.name}</span><span className="text-xs text-muted-foreground">{e.airDate || 'Air date TBA'}{e.watchSource === 'both' ? ' · Individually logged and saved position' : inferred ? ' · Saved position · tap to edit' : logged ? ' · Individually logged · tap to remove' : ''}</span></span>
                    {!aired && <CalendarDays className="size-4 shrink-0 text-muted-foreground" />}
                  </button>;
                })}</div></>}
            </section>}
            {!guide && <p className="text-sm text-muted-foreground">No verified episode guide is available for this show. You can still edit the saved position above.</p>}
            {summary.recentHistory.length > 0 && <section><h3 className="mb-2 text-lg font-semibold">Recently watched</h3><div className="flex flex-wrap gap-2">{summary.recentHistory.map(item => <span key={`${item.season}-${item.episode}`} className="rounded-lg bg-muted px-3 py-2 text-xs">S{item.season}E{item.episode} · {new Date(item.watchedAt).toLocaleDateString()}</span>)}</div></section>}
          </div>}
          {show && !guide && !busy && !show.tmdbId && <div className="space-y-3 py-3"><p className="text-sm text-muted-foreground">This show is not linked to TMDB, so its episode guide is unavailable.</p><Button type="button" className="gap-2" onClick={() => { setMatchNotice(""); setEditingMatch(true); }}><Pencil className="size-4" />Link to TMDB</Button></div>}
          {show && <div className="mt-7 border-t pt-5"><Button variant="ghost" size="sm" className="gap-2 text-destructive" disabled={busy} onClick={() => { if (window.confirm(`Delete ${show.name} and its watch history?`)) deleteShow(); }}><Trash2 className="size-4" />Delete show</Button></div>}
        </>}
      </div>
    </DialogContent>
  </Dialog>;
}
