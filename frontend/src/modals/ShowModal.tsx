import { useEffect, useState } from "react";
import { ShowService } from "@/services";
import type { EpisodeGuide, TrackingSummary, TrackedEpisode } from "@/services/show.service";
import useDebounce from "@/hooks/use-debounce";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ShowType } from "@/types/index.ts";
import { Check, CalendarDays, Play, Trash2, Tv } from "lucide-react";

interface Props {
  selectedShow: string | null;
  closeModal: () => void;
  shows: ShowType[];
  setShows: React.Dispatch<React.SetStateAction<ShowType[]>>;
  type: "show" | "movie";
}
const code = (episode: TrackedEpisode) => `S${String(episode.season).padStart(2, '0')}E${String(episode.number).padStart(2, '0')}`;
const today = () => new Date().toISOString().slice(0, 10);

export default function ShowModal({ selectedShow, closeModal, shows, setShows }: Props) {
  const show = shows.find(item => item.id === selectedShow);
  const [summary, setSummary] = useState<TrackingSummary | null>(null);
  const [guide, setGuide] = useState<EpisodeGuide | null>(null);
  const [season, setSeason] = useState(1);
  const [editing, setEditing] = useState(false);
  const [editSeason, setEditSeason] = useState(1);
  const [editEpisode, setEditEpisode] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [linkQuery, setLinkQuery] = useState("");
  const [linkResults, setLinkResults] = useState<{ id: number; name: string }[]>([]);
  const search = useDebounce(linkQuery, 300);

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

  useEffect(() => {
    if (!selectedShow || search.trim().length < 2) { setLinkResults([]); return; }
    let active = true;
    ShowService.searchShows(search).then(results => { if (active) setLinkResults(results); }).catch(() => { if (active) setLinkResults([]); });
    return () => { active = false; };
  }, [search, selectedShow]);

  const act = async (action: () => Promise<unknown>, selectedSeason = season) => {
    if (!selectedShow || busy) return;
    setBusy(true); setError("");
    try { await action(); await refresh(selectedShow, selectedSeason); }
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
  const linkShow = async (result: { id: number }) => {
    if (!selectedShow) return;
    await act(async () => {
      const updated = await ShowService.updateShow(selectedShow, { tmdbId: result.id });
      setShows(current => current.map(item => item.id === updated.id ? updated : item));
      setLinkQuery(''); setLinkResults([]);
    }, 1);
  };
  const deleteShow = async () => {
    if (!selectedShow) return;
    setBusy(true);
    try { await ShowService.deleteShow(selectedShow); setShows(current => current.filter(item => item.id !== selectedShow)); closeModal(); }
    catch { setError('Could not delete this show.'); setBusy(false); }
  };

  return <Dialog open={!!selectedShow} onOpenChange={open => { if (!open) closeModal(); }}>
    <DialogContent className="fixed inset-0 left-0 top-0 h-[100dvh] max-h-[100dvh] w-screen max-w-none translate-x-0 translate-y-0 flex flex-col overflow-hidden rounded-none p-0 sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[92vh] sm:w-full sm:max-w-4xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg">
      <DialogHeader className="shrink-0 border-b bg-background px-5 pb-4 pt-[max(1.25rem,env(safe-area-inset-top))] sm:px-7 sm:py-5">
        <p className="cinema-eyebrow">The watch room</p>
        <DialogTitle className="pr-8 text-2xl sm:text-3xl">{show?.name || 'TV show'}</DialogTitle>
        <DialogDescription>Episode tracking · {summary ? summary.source || 'Guide unavailable' : 'Loading guide'}</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-5 pb-[max(1.75rem,env(safe-area-inset-bottom))] sm:px-7">
        {show && <div className="flex gap-4 py-6 sm:gap-6">
          {show.posterURL ? <img src={show.posterURL} alt="" className="cinema-poster h-36 w-24 shrink-0 rounded-xl object-cover sm:h-44 sm:w-30" /> : <div className="flex h-36 w-24 shrink-0 items-center justify-center rounded-xl bg-muted"><Tv /></div>}
          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex flex-wrap items-center gap-2"><span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Watching status</span>
              <div role="group" aria-label="Watching status" className="flex rounded-xl border bg-card p-1">
                {(['watching', 'completed'] as const).map(value => <button key={value} type="button" aria-pressed={(show.status || (show.completed ? 'completed' : null)) === value} disabled={busy} onClick={() => updateStatus(value)} className={`min-h-10 rounded-lg px-4 text-sm font-medium capitalize ${(show.status || (show.completed ? 'completed' : null)) === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>{value}</button>)}
              </div>
              {show.status && !['watching', 'completed'].includes(show.status) && <span className="text-xs text-muted-foreground">Saved legacy status: {show.status}. Choose a new status only if you want to change it.</span>}
              {!show.status && !show.completed && <span className="text-xs text-muted-foreground">No status selected</span>}
            </div>
            <p className="line-clamp-4 text-sm leading-6 text-muted-foreground">{show.overview || 'No overview available.'}</p>
            {summary && <p className="text-xs text-muted-foreground">{summary.watchedCount} confirmed watched · {summary.releasedCount} released with dates</p>}
          </div>
        </div>}
        {error && <div role="alert" className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">{error}</div>}
        {busy && !summary && <p className="py-8 text-sm text-muted-foreground">Loading real episode data…</p>}
        {show && <section className="mb-5 rounded-2xl border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-semibold">Saved viewing position</p><p className="text-sm text-muted-foreground">Season {show.seasonsWatched}, episode {show.episodesWatched} saved{show.episodesWatched === 0 && show.seasonsWatched > 1 ? ` · Season ${show.seasonsWatched - 1} complete` : ''}</p><p className="text-sm font-medium">Current position: Season {show.episodesWatched === 0 ? Math.max(1, show.seasonsWatched) : show.seasonsWatched}, Episode {show.episodesWatched === 0 ? 1 : show.episodesWatched}</p></div><Button type="button" variant="outline" onClick={() => { setEditSeason(show.seasonsWatched || 1); setEditEpisode(show.episodesWatched); setEditing(!editing); }}>Edit progress</Button></div>
          {editing && <div className="mt-4 space-y-3"><p className="text-sm text-muted-foreground">Select the last episode you reached. Saving changes only this position; confirmed episode history stays untouched.</p><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Season<select aria-label="Progress season" className="mt-1 block min-h-11 w-full max-w-full rounded-lg border bg-background px-3" value={editSeason} onChange={e => { const value = Number(e.target.value); setEditSeason(value); setEditEpisode(0); if (selectedShow) ShowService.getEpisodeGuide(selectedShow, value).then(setGuide).catch(() => setGuide(null)); }}>{Array.from(new Set([editSeason, ...Array.from({ length: Math.max(guide?.seasons.length || 0, editSeason, 1) + 1 }, (_, i) => i + 1)])).map(n => <option key={n} value={n}>Season {n}</option>)}</select></label><label className="text-sm">Episode reached{guide?.season === editSeason && guide.episodes.length ? <select aria-label="Progress episode" className="mt-1 block min-h-11 w-full max-w-full rounded-lg border bg-background px-3" value={editEpisode} onChange={e => setEditEpisode(Number(e.target.value))}><option value={0}>0 · Previous season complete</option>{guide.episodes.map(e => <option key={e.number} value={e.number}>{e.number} · {e.name}</option>)}{editEpisode > 0 && !guide.episodes.some(e => e.number === editEpisode) && <option value={editEpisode}>{editEpisode} · Saved position (metadata missing)</option>}</select> : <input aria-label="Progress episode" type="number" min="0" max="999" className="mt-1 block min-h-11 w-full rounded-lg border bg-background px-3" value={editEpisode} onChange={e => setEditEpisode(Number(e.target.value))} />}</label></div><p className="text-xs text-muted-foreground">Episode 0 means the previous season is complete. A saved position is not a watched episode record.</p><Button disabled={busy || !Number.isInteger(editEpisode) || editEpisode < 0 || editEpisode > 999} onClick={() => act(async () => { const updated = await ShowService.updateShow(show.id, { seasonsWatched: editSeason - 1, episodesWatched: editEpisode }); setShows(current => current.map(item => item.id === updated.id ? updated : item)); setEditing(false); })}>Save position</Button></div>}
        </section>}
        {summary && <div className="space-y-5">
          <section className="cinema-surface p-5 sm:p-6">
            <div className="mb-4 flex items-end justify-between"><div><p className="cinema-eyebrow">Your progress</p><p className="mt-1 text-3xl font-semibold">{summary.progressPercent === null ? "Unavailable" : `${summary.progressPercent}%`} {summary.progressPercent !== null && <span className="text-sm font-normal text-muted-foreground">of released episodes</span>}</p></div><span className="text-sm text-muted-foreground">{summary.watchedCount}/{summary.releasedCount}</span></div>
            {summary.progressPercent !== null && <div role="progressbar" aria-valuenow={summary.progressPercent} aria-valuemin={0} aria-valuemax={100} aria-label="Watching progress" className="cinema-progress h-2"><span style={{ width: `${summary.progressPercent}%` }} /></div>}
            {summary.legacyPosition && <p className="mt-2 text-xs text-muted-foreground">Your saved position is preserved. An exact percentage requires confirmed episode history.</p>}
          </section>
          <div className="grid gap-3 sm:grid-cols-2">
            <section className="cinema-surface border-primary/30 bg-primary/5 p-5">
              <p className="cinema-eyebrow mb-2">Watch next</p>
              {summary.nextEpisode ? <><h3 className="font-semibold">{code(summary.nextEpisode)} · {summary.nextEpisode.name}</h3><p className="mt-1 text-xs text-muted-foreground">Released {summary.nextEpisode.airDate} · {summary.remainingCount} remaining</p><Button className="mt-4 w-full gap-2" disabled={busy} onClick={() => act(() => ShowService.setEpisodeWatched(summary.showId, summary.nextEpisode!.season, summary.nextEpisode!.number, true), summary.nextEpisode!.season)}><Play className="size-4" />Mark next episode watched</Button></> : <p className="text-sm text-muted-foreground">{summary.legacyPosition ? "Next episode unknown from saved position." : summary.guideAvailable ? "No released episode to track." : "Episode guide unavailable. Your saved position remains editable above."}</p>}
            </section>
            <section className="cinema-surface p-5"><p className="cinema-eyebrow mb-2">Last watched</p>
              <p className="font-semibold">{summary.lastEpisode ? `${code(summary.lastEpisode)} · ${summary.lastEpisode.name}` : 'No episodes logged yet'}</p>
              <p className="mt-2 text-xs text-muted-foreground">{summary.upcomingEpisode ? `Upcoming: ${code(summary.upcomingEpisode)} · ${summary.upcomingEpisode.airDate}` : 'No upcoming air date announced'}</p>
            </section>
          </div>
          {guide && <section className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="cinema-eyebrow">Episode guide</p><h3 className="mt-1 text-xl font-semibold">Seasons & episodes</h3></div><select aria-label="Season" className="min-h-10 max-w-full rounded-xl border bg-background px-3 text-sm" value={season} onChange={e => selectSeason(Number(e.target.value))}>{guide?.seasons.map(item => <option key={item.number} value={item.number}>Season {item.number} · {item.episodeCount} episodes</option>)}</select></div>
            {guide && <><Button variant="outline" size="sm" disabled={busy || !guide.episodes.some(e => e.airDate && e.airDate <= today() && !e.watchedAt)} onClick={() => act(() => ShowService.markSeasonWatched(summary.showId, season))}>Mark released season episodes watched</Button>
              <div className="space-y-1">{guide.episodes.map(e => {
                const aired = !!e.airDate && e.airDate <= today();
                return <button key={e.number} type="button" aria-label={`${e.watchedAt ? 'Mark unwatched' : 'Mark watched'} ${code({ ...e, season })} ${e.name}`} aria-pressed={!!e.watchedAt} disabled={busy || !aired} onClick={() => act(() => ShowService.setEpisodeWatched(summary.showId, season, e.number, !e.watchedAt))} className="flex min-h-14 w-full items-center gap-3 rounded-xl border bg-card/50 px-3 py-3 text-left transition-[background-color,border-color] hover:border-primary/50 hover:bg-primary/5 disabled:cursor-default disabled:opacity-65">
                  <span className={`flex size-7 shrink-0 items-center justify-center rounded-full border ${e.watchedAt ? 'border-primary bg-primary text-primary-foreground' : ''}`}>{e.watchedAt && <Check className="size-4" />}</span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">S{String(season).padStart(2,'0')}E{String(e.number).padStart(2,'0')} · {e.name}</span><span className="text-xs text-muted-foreground">{e.airDate || 'Air date TBA'}</span></span>
                  {!aired && <CalendarDays className="size-4 shrink-0 text-muted-foreground" />}
                </button>;
              })}</div></>}
          </section>}
          {!guide && <p className="text-sm text-muted-foreground">No verified episode guide is available for this show. You can still edit the saved position above.</p>}
          {summary.recentHistory.length > 0 && <section><h3 className="mb-2 text-lg font-semibold">Recently watched</h3><div className="flex flex-wrap gap-2">{summary.recentHistory.map(item => <span key={`${item.season}-${item.episode}`} className="rounded-lg bg-muted px-3 py-2 text-xs">S{item.season}E{item.episode} · {new Date(item.watchedAt).toLocaleDateString()}</span>)}</div></section>}
        </div>}
        {show && !guide && !busy && <div className="space-y-3 py-3"><p className="text-sm text-muted-foreground">Find the exact show to connect its episode guide.</p><Input aria-label="Find show for episode guide" placeholder="Search for a show" value={linkQuery} onChange={e => setLinkQuery(e.target.value)} />{linkResults.map(result => <button key={result.id} type="button" className="block w-full rounded-lg border p-3 text-left text-sm hover:border-primary" onClick={() => linkShow(result)}>{result.name}</button>)}</div>}
        {show && <div className="mt-7 border-t pt-5"><Button variant="ghost" size="sm" className="gap-2 text-destructive" disabled={busy} onClick={() => { if (window.confirm(`Delete ${show.name} and its watch history?`)) deleteShow(); }}><Trash2 className="size-4" />Delete show</Button></div>}
      </div>
    </DialogContent>
  </Dialog>;
}
