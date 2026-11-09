import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { CalendarDays, Info, RefreshCw, Tv } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import ShowModal from '@/modals/ShowModal';
import { ShowService } from '@/services';
import type { ReturningTba, UpcomingRelease } from '@/services/show.service';
import type { ShowType } from '@/types';

type Filter = 'all' | 'today' | 'week' | 'month' | 'premieres';
const filters: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All Upcoming' }, { id: 'today', label: 'Today' },
  { id: 'week', label: 'This Week' }, { id: 'month', label: 'This Month' },
  { id: 'premieres', label: 'Season Premieres' },
];
const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const localDateKey = (release: UpcomingRelease) => release.airTimestamp ? dateKey(new Date(release.airTimestamp)) : release.airDate;
const isUpcoming = (release: UpcomingRelease, now: Date) => release.airTimestamp ? new Date(release.airTimestamp).getTime() > now.getTime() : release.airDate >= dateKey(now);
const dateText = (release: UpcomingRelease) => release.airTimestamp
  ? new Date(release.airTimestamp).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
  : new Date(`${release.airDate}T12:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
const timeText = (release: UpcomingRelease) => release.airTimestamp
  ? new Date(release.airTimestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  : null;
const countText = (value: number, unit: string) => `${value} ${unit}${value === 1 ? '' : 's'}`;
function countdown(release: UpcomingRelease, now: Date) {
  if (!release.airTimestamp) {
    const day = new Date(`${release.airDate}T12:00:00`);
    const current = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
    const days = Math.round((day.getTime() - current.getTime()) / 86_400_000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    if (days < 14) return countText(days, 'Day');
    if (days < 60) return countText(Math.floor(days / 7), 'Week');
    return countText(Math.floor(days / 30), 'Month');
  }
  const minutes = Math.max(1, Math.ceil((new Date(release.airTimestamp).getTime() - now.getTime()) / 60_000));
  if (minutes < 60) return countText(minutes, 'Minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return countText(hours, 'Hour');
  const days = Math.floor(hours / 24);
  if (days < 14) return countText(days, 'Day');
  if (days < 60) return countText(Math.floor(days / 7), 'Week');
  return countText(Math.floor(days / 30), 'Month');
}
function passesFilter(release: UpcomingRelease, filter: Filter, now: Date) {
  if (filter === 'all') return true;
  if (filter === 'premieres') return release.seasonPremiere;
  const day = localDateKey(release);
  if (filter === 'today') return day === dateKey(now);
  if (filter === 'month') return day.slice(0, 7) === dateKey(now).slice(0, 7);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return day >= dateKey(start) && day < dateKey(end);
}

export default function UpcomingPage() {
  const [releases, setReleases] = useState<UpcomingRelease[]>([]);
  const [returningTba, setReturningTba] = useState<ReturningTba[]>([]);
  const [shows, setShows] = useState<ShowType[]>([]);
  const [failedShows, setFailedShows] = useState(0);
  const [tmdbFailureTypes, setTMDBFailureTypes] = useState<Record<string, number>>({});
  const [showsWithoutTMDBId, setShowsWithoutTMDBId] = useState(0);
  const [scheduleConflicts, setScheduleConflicts] = useState(0);
  const [ambiguousSchedules, setAmbiguousSchedules] = useState(0);
  const [coverage, setCoverage] = useState<{ evaluated: number; tmdbEntries: number; tvmazeEntries: number; unlinked: { tmdb: number; tvmaze: number; unmatched: number } | null }>({ evaluated: 0, tmdbEntries: 0, tvmazeEntries: 0, unlinked: null });
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedShow, setSelectedShow] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => new Date());
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await ShowService.getUpcomingReleases();
      setReleases(data.releases);
      setReturningTba(data.returningTba || []);
      setFailedShows(data.failedShows);
      setTMDBFailureTypes(data.tmdbFailureTypes || {});
      setShowsWithoutTMDBId(data.showsWithoutTMDBId || 0);
      setScheduleConflicts(data.scheduleConflicts || 0);
      setAmbiguousSchedules(data.tvmazeAmbiguousShows || 0);
      setCoverage({ evaluated: data.evaluatedShows || 0, tmdbEntries: data.scheduledTMDBEpisodes || 0, tvmazeEntries: data.scheduledTVMazeEpisodes || 0, unlinked: data.unlinkedScheduleMatches || null });
      ShowService.getAllShows().then(setShows).catch(() => {});
      setNow(new Date());
      setError('');
    } catch { setError('Upcoming releases could not be loaded. Please try again.'); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const tick = window.setInterval(() => setNow(new Date()), 60_000);
    const sync = window.setInterval(refresh, 16 * 60_000);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', refresh);
    window.addEventListener('tracking-updated', refresh);
    return () => { window.clearInterval(tick); window.clearInterval(sync); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('online', refresh); window.removeEventListener('tracking-updated', refresh); };
  }, [refresh]);
  const visible = useMemo(() => releases.filter(release => isUpcoming(release, now) && passesFilter(release, filter, now))
    .sort((a, b) => (a.airTimestamp ? Date.parse(a.airTimestamp) : Date.parse(`${a.airDate}T00:00:00`)) - (b.airTimestamp ? Date.parse(b.airTimestamp) : Date.parse(`${b.airDate}T00:00:00`)) || a.showName.localeCompare(b.showName)), [releases, filter, now]);
  const nextRelease = useMemo(() => releases.filter(release => isUpcoming(release, now))
    .sort((a, b) => (a.airTimestamp ? Date.parse(a.airTimestamp) : Date.parse(`${a.airDate}T00:00:00`)) - (b.airTimestamp ? Date.parse(b.airTimestamp) : Date.parse(`${b.airDate}T00:00:00`)))[0], [releases, now]);

  return <div className="mx-auto w-full max-w-6xl space-y-7 px-4 py-7 pb-24 md:px-8 md:py-10">
    <header className="flex flex-col justify-between gap-5 rounded-2xl border border-primary/15 bg-card px-5 py-6 sm:flex-row sm:items-end sm:px-7">
      <div className="max-w-2xl"><p className="cinema-eyebrow">Your tracked shows</p><h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">Upcoming<span className="text-primary">.</span></h1><p className="mt-2 text-sm text-muted-foreground sm:text-base">Confirmed episode dates and returning shows from your library</p>
        {nextRelease && <p className="mt-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-white/70 sm:text-sm"><span className="cinema-tag">Next to air</span><strong className="font-semibold text-white">{nextRelease.showName}</strong><span>· {countdown(nextRelease, now)}</span></p>}
      </div>
      <Button type="button" variant="outline" size="sm" className="gap-2" onClick={refresh} disabled={refreshing}><RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} />Refresh</Button>
    </header>
    <nav aria-label="Upcoming filters" className="flex flex-wrap items-center gap-2">{filters.map(option => <button key={option.id} type="button" aria-pressed={filter === option.id} onClick={() => setFilter(option.id)} className="upcoming-filter px-3.5 py-2 text-xs font-semibold sm:text-sm">{option.label}</button>)}<span className="ml-auto text-xs text-muted-foreground">{visible.length} release{visible.length === 1 ? '' : 's'}</span></nav>
    {error && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm">{error}</p>}
    {!loading && (tmdbFailureTypes.http_401 || 0) > 0 && <p role="status" className="text-xs text-destructive">TMDB rejected authentication, so some schedules are missing. See Schedule coverage below.</p>}
    {loading ? <div aria-label="Loading upcoming releases" className="space-y-3">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}</div> : visible.length ? <section aria-label="Scheduled upcoming episodes" className="space-y-3">
      {visible.map((release, index) => <button key={`${release.showId}:${release.season ?? ''}:${release.number ?? ''}:${release.airDate}:${release.name}`} type="button" data-next={index === 0 ? 'true' : undefined} aria-label={`Open ${release.showName}${release.season && release.number ? `, season ${release.season} episode ${release.number}` : ''}, ${dateText(release)}, in ${countdown(release, now)}`} onClick={() => setSelectedShow(release.showId)} className="group flex min-h-28 w-full min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-card px-3 py-3 text-left transition-colors hover:border-primary/35 hover:bg-card/80 sm:gap-5 sm:px-4">
        {release.posterURL ? <img src={release.posterURL} alt="" loading="lazy" className="cinema-poster h-20 w-14 shrink-0 rounded-lg object-cover sm:h-24 sm:w-16" /> : <span className="flex h-20 w-14 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground sm:h-24 sm:w-16"><Tv className="size-6" /></span>}
        <span className="min-w-0 flex-1"><span className="line-clamp-2 break-words text-base font-semibold leading-snug group-hover:text-primary sm:text-lg">{release.showName}</span><span className="mt-1 line-clamp-2 break-words text-sm text-muted-foreground">{release.season && release.number ? `${release.seasonPremiere ? `Season ${release.season} Premiere` : `S${String(release.season).padStart(2, '0')}E${String(release.number).padStart(2, '0')}`}${release.name ? ` · ${release.name}` : ''}` : release.name || 'Scheduled episode'}</span><span className="mt-1 block text-xs text-muted-foreground">{release.scheduleSource}{release.scheduleIdentity && release.scheduleIdentity !== 'linked' ? ' · matched by title' : ''}{release.scheduleConflict ? ' · Conflicting dates; TMDB date shown' : ''}</span></span>
        <span className="shrink-0 text-right"><span className="block text-sm font-semibold text-primary">{countdown(release, now)}</span><span className="mt-1 block text-xs text-muted-foreground">{dateText(release)}{timeText(release) ? ` · ${timeText(release)}` : ''}</span></span>
      </button>)}
    </section> : <div className="rounded-2xl border bg-card px-5 py-10 text-center"><CalendarDays className="mx-auto size-9 text-primary" /><h2 className="mt-3 text-lg font-semibold">No dated upcoming episodes yet.</h2><p className="mt-2 text-sm text-muted-foreground">A release appears here when a provider confirms a date for a show in your library.</p>{!returningTba.length && <Button asChild className="mt-5"><Link to="/shows">Go to TV show library</Link></Button>}</div>}
    {!loading && returningTba.length > 0 && <section aria-label="Returning shows with no date" className="space-y-3"><div><h2 className="text-lg font-semibold">Returning — Date TBA</h2><p className="text-sm text-muted-foreground">These shows are returning or in production, but no episode date is confirmed.</p></div>{returningTba.map(show => <button type="button" key={show.showId} onClick={() => setSelectedShow(show.showId)} className="flex min-h-20 w-full items-center gap-3 rounded-xl border border-border/70 bg-card px-3 py-3 text-left sm:gap-4 sm:px-4">{show.posterURL ? <img src={show.posterURL} alt="" loading="lazy" className="cinema-poster h-14 w-10 shrink-0 rounded-md object-cover" /> : <Tv className="size-8 shrink-0 text-muted-foreground" />}<span className="min-w-0 flex-1"><span className="line-clamp-2 break-words font-semibold">{show.showName}</span><span className="text-xs text-muted-foreground">{show.broadcastStatus}</span></span><span className="shrink-0 text-xs text-muted-foreground">Date TBA</span></button>)}</section>}
    {!loading && <details className="group rounded-xl border border-border/60 bg-card/60 px-4 py-3 text-sm text-muted-foreground">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 font-medium text-foreground/80 [&::-webkit-details-marker]:hidden"><Info className="size-4 shrink-0 text-primary" />Schedule coverage<span className="ml-auto text-xs font-normal text-muted-foreground group-open:hidden">Show</span><span className="ml-auto hidden text-xs font-normal text-muted-foreground group-open:inline">Hide</span></summary>
      <ul className="mt-2 space-y-1.5 text-xs leading-relaxed">
        <li>{coverage.evaluated} show{coverage.evaluated === 1 ? '' : 's'} checked · {coverage.tmdbEntries} date{coverage.tmdbEntries === 1 ? '' : 's'} from TMDB · {coverage.tvmazeEntries} added from TVMaze.</li>
        {showsWithoutTMDBId > 0 && <li>{showsWithoutTMDBId} show{showsWithoutTMDBId === 1 ? ' is' : 's are'} not linked to TMDB{coverage.unlinked ? `: ${coverage.unlinked.tmdb} matched on TMDB by title and description, ${coverage.unlinked.tvmaze} on TVMaze, ${coverage.unlinked.unmatched} not matched` : ''}. Title matches are used for schedules only and are never saved.</li>}
        {failedShows > 0 && <li>Schedules could not be loaded for {failedShows} linked show{failedShows === 1 ? '' : 's'}{Object.keys(tmdbFailureTypes).length ? ` (${Object.entries(tmdbFailureTypes).map(([type, count]) => `${type.replace('http_', 'HTTP ')}: ${count}`).join(', ')})` : ''}.</li>}
        {scheduleConflicts > 0 && <li>TMDB and TVMaze disagree on {scheduleConflicts} date{scheduleConflicts === 1 ? '' : 's'}; TMDB’s date is shown.</li>}
        {ambiguousSchedules > 0 && <li>{ambiguousSchedules} TVMaze match{ambiguousSchedules === 1 ? ' was' : 'es were'} ambiguous and left out.</li>}
      </ul>
    </details>}
    <ShowModal type="show" selectedShow={selectedShow} closeModal={() => setSelectedShow('')} shows={shows} setShows={setShows} />
  </div>;
}
