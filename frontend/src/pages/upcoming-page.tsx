import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { AlarmClock, CalendarDays, RefreshCw, Tv } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import ShowModal from '@/modals/ShowModal';
import { ShowService } from '@/services';
import type { UpcomingRelease } from '@/services/show.service';
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
  const [shows, setShows] = useState<ShowType[]>([]);
  const [failedShows, setFailedShows] = useState(0);
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
      setFailedShows(data.failedShows);
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
    <header className="upcoming-hero flex flex-col justify-between gap-5 px-6 py-6 sm:flex-row sm:items-end sm:px-9 sm:py-8">
      {nextRelease?.posterURL && <img className="upcoming-hero-art" src={nextRelease.posterURL} alt="" aria-hidden="true" />}
      <div className="relative max-w-2xl"><p className="cinema-eyebrow">The release reel</p><h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">Upcoming<span className="text-primary">.</span></h1><p className="mt-2 text-sm text-white/70 sm:text-base">Don’t miss out on these upcoming releases</p>
        {nextRelease && <p className="mt-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-white/70 sm:text-sm"><span className="cinema-tag">Next to air</span><strong className="font-semibold text-white">{nextRelease.showName}</strong><span>· {countdown(nextRelease, now)}</span></p>}
      </div>
      <Button type="button" variant="outline" size="sm" className="relative gap-2 border-white/25 bg-white/5 text-white hover:bg-white/10 hover:text-white" onClick={refresh} disabled={refreshing}><RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} />Refresh</Button>
    </header>
    <nav aria-label="Upcoming filters" className="flex flex-wrap items-center gap-2">{filters.map(option => <button key={option.id} type="button" aria-pressed={filter === option.id} onClick={() => setFilter(option.id)} className="upcoming-filter px-3.5 py-2 text-xs font-semibold sm:text-sm">{option.label}</button>)}<span className="ml-auto text-xs text-muted-foreground">{visible.length} release{visible.length === 1 ? '' : 's'}</span></nav>
    {error && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm">{error}</p>}
    {failedShows > 0 && <p role="status" className="rounded-xl border bg-card p-3 text-sm text-muted-foreground">Release data is unavailable for {failedShows} tracked show{failedShows === 1 ? '' : 's'}. The timeline shows the remaining shows.</p>}
    {loading ? <div aria-label="Loading upcoming releases" className="space-y-5">{Array.from({ length: 4 }, (_, i) => <div key={i} className="flex gap-4"><Skeleton className="h-32 w-12 shrink-0 rounded-full sm:w-24" /><Skeleton className="h-32 flex-1 rounded-xl" /></div>)}</div> : visible.length ? <section aria-label="Upcoming release timeline" className="relative">
      <div aria-hidden="true" className="upcoming-rail absolute inset-x-auto bottom-3 left-0 top-3 w-12 rounded-full sm:bottom-4 sm:top-4 sm:w-24" />
      <ol className="relative space-y-2 sm:space-y-3">{visible.map((release, index) => {
        const [amount, ...units] = countdown(release, now).split(' ');
        return <li key={`${release.showId}:${release.season}:${release.number}`} className="grid grid-cols-[48px_minmax(0,1fr)] gap-3 sm:grid-cols-[96px_minmax(0,1fr)] sm:gap-7">
          <div aria-hidden="true" className="flex min-h-30 flex-col items-center pt-6 text-white sm:min-h-40 sm:pt-8">
            <span className={`flex size-4 items-center justify-center rounded-full border-[4px] border-white/80 bg-white/45 sm:size-5 ${index === 0 ? 'upcoming-marker' : ''}`}><span className="size-1 rounded-full bg-white" /></span>
            <span className="mt-2 flex max-w-full flex-col items-center text-center text-[10px] font-semibold leading-[1.2] sm:mt-3 sm:text-sm"><span>{amount}</span>{units.length > 0 && <span>{units.join(' ')}</span>}</span>
          </div>
          <button type="button" data-next={index === 0 ? 'true' : undefined} aria-label={`Open ${release.showName}, season ${release.season} episode ${release.number}, ${dateText(release)}${timeText(release) ? ` at ${timeText(release)}` : ''}, in ${countdown(release, now)}`} onClick={() => setSelectedShow(release.showId)} className="upcoming-entry group flex min-w-0 items-start gap-3 p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:items-center sm:gap-5 sm:p-4">
            {release.posterURL ? <img src={release.posterURL} alt="" loading="lazy" className="cinema-poster h-[88px] w-[60px] shrink-0 rounded-lg object-cover sm:h-36 sm:w-24" /> : <span className="flex h-[88px] w-[60px] shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground sm:h-36 sm:w-24"><Tv className="size-7" /></span>}
            <span className="min-w-0 flex-1">
              {index === 0 && <span className="cinema-eyebrow mb-1 block text-[9px]">First on the reel</span>}
              <span className="block text-base font-semibold leading-tight group-hover:text-primary sm:text-xl">{release.showName}</span>
              <span className="mt-2 flex items-center gap-1.5 text-sm font-medium sm:mt-5 sm:text-base"><Tv className="size-4 shrink-0" />{release.seasonPremiere ? `Season ${release.season} Premiere` : `S${String(release.season).padStart(2, '0')}E${String(release.number).padStart(2, '0')}`}</span>
              {release.name && <span className="mt-0.5 block truncate text-xs text-muted-foreground sm:text-sm" title={release.name}>{release.name}</span>}
              <span className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground sm:mt-5 sm:text-sm"><AlarmClock className="mt-0.5 size-4 shrink-0" /><span>{dateText(release)}{timeText(release) ? ` at ${timeText(release)}` : ''}</span></span>
            </span>
          </button>
        </li>;
      })}</ol>
    </section> : <div className="rounded-2xl border bg-card px-5 py-12 text-center"><CalendarDays className="mx-auto size-10 text-primary" /><h2 className="mt-4 text-lg font-semibold">No upcoming episodes for your tracked shows.</h2><p className="mt-2 text-sm text-muted-foreground">Release dates appear here when they are announced for shows in your library.</p><Button asChild className="mt-5"><Link to="/shows">Go to TV show library</Link></Button></div>}
    <ShowModal type="show" selectedShow={selectedShow} closeModal={() => setSelectedShow('')} shows={shows} setShows={setShows} />
  </div>;
}
