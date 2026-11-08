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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [linkQuery, setLinkQuery] = useState("");
  const [linkResults, setLinkResults] = useState<{ id: number; tvmazeId?: number; name: string }[]>([]);
  const search = useDebounce(linkQuery, 300);

  const refresh = async (id: string, selectedSeason?: number) => {
    const nextSummary = await ShowService.getTrackingSummary(id);
    const nextSeason = selectedSeason && selectedSeason > 0 ? selectedSeason : nextSummary.nextEpisode?.season || nextSummary.lastEpisode?.season || 1;
    const nextGuide = await ShowService.getEpisodeGuide(id, nextSeason).catch(async () => {
      const first = await ShowService.getEpisodeGuide(id, 1);
      setSeason(1);
      return first;
    });
    setSummary(nextSummary);
    setGuide(nextGuide);
    setSeason(nextGuide.season);
    window.dispatchEvent(new Event('tracking-updated'));
  };

  useEffect(() => {
    if (!selectedShow) { setGuide(null); setSummary(null); return; }
    let active = true;
    setBusy(true); setError(""); setGuide(null); setSummary(null);
    ShowService.getTrackingSummary(selectedShow).then(async data => {
      const initialSeason = data.nextEpisode?.season || data.lastEpisode?.season || 1;
      const loaded = await ShowService.getEpisodeGuide(selectedShow, initialSeason).catch(() => ShowService.getEpisodeGuide(selectedShow, 1));
      if (active) { setSummary(data); setGuide(loaded); setSeason(loaded.season); }
    }).catch(() => { if (active) setError('Episode guide unavailable for this show. Try connecting a TMDB match below.'); })
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
  const linkShow = async (result: { id: number; tvmazeId?: number }) => {
    if (!selectedShow) return;
    await act(async () => {
      const updated = await ShowService.updateShow(selectedShow, result.id ? { tmdbId: result.id } : { tvmazeId: result.tvmazeId });
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
    <DialogContent className="flex max-h-[92vh] flex-col overflow-hidden p-0 sm:max-w-4xl">
      <DialogHeader className="border-b bg-gradient-to-r from-primary/10 to-transparent px-5 py-5 sm:px-7">
        <p className="cinema-eyebrow">The watch room</p>
        <DialogTitle className="pr-8 text-2xl sm:text-3xl">{show?.name || 'TV show'}</DialogTitle>
        <DialogDescription>Episode tracking · {summary?.source || 'Loading guide'}</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 overflow-y-auto px-5 pb-7 sm:px-7">
        {show && <div className="flex gap-4 py-6 sm:gap-6">
          {show.posterURL ? <img src={show.posterURL} alt="" className="cinema-poster h-36 w-24 shrink-0 rounded-xl object-cover sm:h-44 sm:w-30" /> : <div className="flex h-36 w-24 shrink-0 items-center justify-center rounded-xl bg-muted"><Tv /></div>}
          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex flex-wrap items-center gap-2"><span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Watching status</span>
              <select aria-label="Watching status" className="min-h-10 rounded-xl border bg-background px-3 text-sm" value={show.status || summary?.status || (show.completed ? 'completed' : 'watching')} onChange={e => updateStatus(e.target.value as NonNullable<ShowType['status']>)}>
                <option value="watching">Watching</option><option value="completed">Completed</option><option value="planned">Plan to watch</option><option value="paused">Paused</option><option value="dropped">Dropped</option>
              </select>
            </div>
            <p className="line-clamp-4 text-sm leading-6 text-muted-foreground">{show.overview || 'No overview available.'}</p>
            {summary && <p className="text-xs text-muted-foreground">{summary.watchedCount} watched · {summary.remainingCount} released remaining · {summary.releasedCount} released total</p>}
          </div>
        </div>}
        {error && <div role="alert" className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">{error}</div>}
        {busy && !summary && <p className="py-8 text-sm text-muted-foreground">Loading real episode data…</p>}
        {show && summary && summary.watchedCount === 0 && (show.seasonsWatched > 0 || show.episodesWatched > 0) && <div className="mb-5 rounded-2xl border border-primary/40 bg-primary/5 p-4"><p className="font-semibold">Bring in your earlier progress</p><p className="mt-1 text-sm text-muted-foreground">Your saved counters say {show.seasonsWatched} full season(s) and {show.episodesWatched} episode(s) in the next season. Import will mark the corresponding released episodes watched. Review the counts before importing.</p><Button size="sm" className="mt-3" disabled={busy} onClick={() => { if (window.confirm(`Import ${show.seasonsWatched} full season(s) and ${show.episodesWatched} episode(s) into episode history?`)) act(() => ShowService.importLegacyProgress(show.id)); }}>Import saved progress</Button></div>}
        {summary && <div className="space-y-5">
          <section className="cinema-surface p-5 sm:p-6">
            <div className="mb-4 flex items-end justify-between"><div><p className="cinema-eyebrow">Your progress</p><p className="mt-1 text-3xl font-semibold">{summary.progressPercent}% <span className="text-sm font-normal text-muted-foreground">of released episodes</span></p></div><span className="text-sm text-muted-foreground">{summary.watchedCount}/{summary.releasedCount}</span></div>
            <div role="progressbar" aria-valuenow={summary.progressPercent} aria-valuemin={0} aria-valuemax={100} aria-label="Watching progress" className="cinema-progress h-2"><span style={{ width: `${summary.progressPercent}%` }} /></div>
          </section>
          <div className="grid gap-3 sm:grid-cols-2">
            <section className="cinema-surface border-primary/30 bg-primary/5 p-5">
              <p className="cinema-eyebrow mb-2">Watch next</p>
              {summary.nextEpisode ? <><h3 className="font-semibold">{code(summary.nextEpisode)} · {summary.nextEpisode.name}</h3><p className="mt-1 text-xs text-muted-foreground">Released {summary.nextEpisode.airDate} · {summary.remainingCount} remaining</p><Button className="mt-4 w-full gap-2" disabled={busy} onClick={() => act(() => ShowService.setEpisodeWatched(summary.showId, summary.nextEpisode!.season, summary.nextEpisode!.number, true), summary.nextEpisode!.season)}><Play className="size-4" />Mark next episode watched</Button></> : <p className="text-sm text-muted-foreground">All released episodes watched.</p>}
            </section>
            <section className="cinema-surface p-5"><p className="cinema-eyebrow mb-2">Last watched</p>
              <p className="font-semibold">{summary.lastEpisode ? `${code(summary.lastEpisode)} · ${summary.lastEpisode.name}` : 'No episodes logged yet'}</p>
              <p className="mt-2 text-xs text-muted-foreground">{summary.upcomingEpisode ? `Upcoming: ${code(summary.upcomingEpisode)} · ${summary.upcomingEpisode.airDate}` : 'No upcoming air date announced'}</p>
            </section>
          </div>
          <section className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="cinema-eyebrow">Episode guide</p><h3 className="mt-1 text-xl font-semibold">Seasons & episodes</h3></div><select aria-label="Season" className="min-h-10 max-w-full rounded-xl border bg-background px-3 text-sm" value={season} onChange={e => selectSeason(Number(e.target.value))}>{guide?.seasons.map(item => <option key={item.number} value={item.number}>Season {item.number} · {item.episodeCount} episodes</option>)}</select></div>
            {guide && <><Button variant="outline" size="sm" disabled={busy || !guide.episodes.some(e => e.airDate && e.airDate <= today() && !e.watchedAt)} onClick={() => act(() => ShowService.markSeasonWatched(summary.showId, season))}>Mark released season episodes watched</Button>
              <div className="space-y-1">{guide.episodes.map(e => {
                const aired = !!e.airDate && e.airDate <= today();
                return <button key={e.number} type="button" aria-label={`${e.watchedAt ? 'Mark unwatched' : 'Mark watched'} ${code({ ...e, season })} ${e.name}`} aria-pressed={!!e.watchedAt} disabled={busy || !aired} onClick={() => act(() => ShowService.setEpisodeWatched(summary.showId, season, e.number, !e.watchedAt))} className="flex min-h-14 w-full items-center gap-3 rounded-xl border bg-card/50 px-3 py-3 text-left transition-[background-color,border-color] hover:border-primary/50 hover:bg-primary/5 disabled:cursor-default disabled:opacity-65">
                  <span className={`flex size-7 shrink-0 items-center justify-center rounded-full border ${e.watchedAt ? 'border-primary bg-primary text-primary-foreground' : ''}`}>{e.watchedAt && <Check className="size-4" />}</span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">S{String(season).padStart(2,'0')}E{String(e.number).padStart(2,'0')} · {e.name}</span><span className="text-xs text-muted-foreground">{e.airDate || 'Air date TBA'}</span></span>
                  {!aired && <CalendarDays className="size-4 shrink-0 text-muted-foreground" />}
                </button>;
              })}</div></>}
          </section>
          {summary.recentHistory.length > 0 && <section><h3 className="mb-2 text-lg font-semibold">Recently watched</h3><div className="flex flex-wrap gap-2">{summary.recentHistory.map(item => <span key={`${item.season}-${item.episode}`} className="rounded-lg bg-muted px-3 py-2 text-xs">S{item.season}E{item.episode} · {new Date(item.watchedAt).toLocaleDateString()}</span>)}</div></section>}
        </div>}
        {!summary && show && <div className="space-y-3 py-3"><p className="text-sm text-muted-foreground">Find the exact show to connect its episode guide.</p><Input aria-label="Find show for episode guide" placeholder="Search for a show" value={linkQuery} onChange={e => setLinkQuery(e.target.value)} />{linkResults.map(result => <button key={result.tvmazeId || result.id} type="button" className="block w-full rounded-lg border p-3 text-left text-sm hover:border-primary" onClick={() => linkShow(result)}>{result.name}</button>)}</div>}
        {show && <div className="mt-7 border-t pt-5"><Button variant="ghost" size="sm" className="gap-2 text-destructive" disabled={busy} onClick={() => { if (window.confirm(`Delete ${show.name} and its watch history?`)) deleteShow(); }}><Trash2 className="size-4" />Delete show</Button></div>}
      </div>
    </DialogContent>
  </Dialog>;
}
