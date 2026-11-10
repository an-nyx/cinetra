import { localeFor, localizedEpisodeLine, localizedShortDay } from "@/i18n/calendar";
import { verifiedShowCounts, unavailableShowCounts } from "@/i18n/tracking";
import { T, phrase, useLanguage } from "@/i18n";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { AlertTriangle, Check, ChevronDown, ChevronRight, RefreshCw, Tv } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import ShowModal from "@/modals/ShowModal";
import { ShowService } from "@/services";
import type { TrackingSummary } from "@/services/show.service";
import type { ShowType } from "@/types";
import { posterSrc } from "@/lib/poster";
import { episodeCode, homeDashboard, savedPositionCode } from "@/lib/tracking";
import { groupReleaseEvents, timeLabel } from "@/lib/upcoming-calendar";
import { useMovieDiscovery } from "@/hooks/use-movie-discovery";
import { filterMovieReleases } from "@/lib/movie-calendar";
import { useNow, useUpcomingSchedule } from "@/hooks/use-upcoming";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const nextCode = (item: TrackingSummary) => item.nextEpisode ? episodeCode(item.nextEpisode.season, item.nextEpisode.number) : null;
function relativeTime(iso: string, now: Date) {
  const days = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(new Date(iso).setHours(0, 0, 0, 0)).getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function Poster({ url, size = "w154", className }: { url: string | null; size?: "w92" | "w154" | "w185" | "w342"; className: string }) {
  return url
    ? <img src={posterSrc(url, size)} alt="" loading="lazy" decoding="async" className={`dash-poster ${className}`} />
    : <span className={`dash-poster flex items-center justify-center text-muted-foreground ${className}`}><Tv className="size-5" /></span>;
}

export default function WelcomePage() {
  const { language } = useLanguage();
  const [shows, setShows] = useState<ShowType[]>([]);
  const [tracking, setTracking] = useState<TrackingSummary[]>([]);
  const [selectedShow, setSelectedShow] = useState("");
  const [editMatch, setEditMatch] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [allNew, setAllNew] = useState(false);
  const now = useNow();
  // Coming soon reads the same TVMaze schedule and grouping as the Upcoming page, and loads on its own (never blocks Home).
  const upcoming = useUpcomingSchedule();
  const movieDiscovery = useMovieDiscovery();
  const upcomingMovies = useMemo(() => filterMovieReleases(movieDiscovery.data?.releases || [], "all", now).slice(0, 3), [movieDiscovery.data, now]);

  const load = useCallback(async () => {
    try { const [library, progress] = await Promise.all([ShowService.getAllShows(), ShowService.getLibraryTracking()]); setShows(library); setTracking(progress); setError(""); }
    catch { setError("Could not load your tracking dashboard."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); window.addEventListener("tracking-updated", load); return () => window.removeEventListener("tracking-updated", load); }, [load]);

  const dash = useMemo(() => homeDashboard(tracking), [tracking]);
  const comingSoon = useMemo(() => groupReleaseEvents(upcoming.schedule?.releases || [], now).slice(0, 3), [upcoming.schedule, now]);
  const open = (showId: string, fixMatch = false) => { setEditMatch(fixMatch); setSelectedShow(showId); };
  const markNext = async (item: TrackingSummary) => {
    if (!item.nextEpisode || busy) return;
    setBusy(item.showId);
    try { await ShowService.setEpisodeWatched(item.showId, item.nextEpisode.season, item.nextEpisode.number, true); await load(); }
    catch { setError(`Could not update ${item.name}.`); }
    finally { setBusy(null); }
  };
  const featured = dash.featured;
  const newShown = allNew ? dash.newEpisodes : dash.newEpisodes.slice(0, 3);

  return <div className="mx-auto w-full min-w-0 max-w-5xl space-y-5 px-4 pb-4 pt-3 md:px-8 md:pt-6">
    <h1 className="sr-only"><T>Home</T></h1>
    {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm">{phrase(language, error)}</p>}

    {loading ? <div className="space-y-5" aria-label={phrase(language, "Loading dashboard") } aria-busy="true">
      <Skeleton className="h-[148px] rounded-2xl" />
      <div className="grid grid-cols-3 gap-2">{[1, 2, 3].map(n => <Skeleton key={n} className="h-[62px] rounded-xl" />)}</div>
      <div className="flex gap-2.5 overflow-hidden">{[1, 2, 3].map(n => <Skeleton key={n} className="h-56 w-[30%] shrink-0 rounded-xl" />)}</div>
    </div> : <>
      {/* A. Featured up next */}
      <section aria-labelledby="up-next-heading" className="dash-card p-3">
        <div className="flex items-center justify-between">
          <h2 id="up-next-heading" className="cinema-eyebrow"><T>Up next</T></h2>
          <Button variant="ghost" size="icon" onClick={load} aria-label={phrase(language, "Refresh dashboard") } className="-my-2 -mr-2 rounded-full"><RefreshCw className="size-4" /></Button>
        </div>
        {featured ? <div className="mt-1 flex gap-3">
          <button type="button" onClick={() => open(featured.showId)} aria-label={`Open ${featured.name}`} className="shrink-0"><Poster url={featured.posterURL} size="w185" className="h-[108px] w-[72px] cinema-poster" /></button>
          <div className="min-w-0 flex-1">
            <button type="button" onClick={() => open(featured.showId)} className="block max-w-full text-left"><span className="line-clamp-2 break-words text-base font-semibold leading-snug hover:text-primary">{featured.name}</span></button>
            <p className="mt-0.5 truncate text-xs text-muted-foreground"><span className="font-medium text-foreground/90"><T>Next</T> {nextCode(featured)}</span>{featured.nextEpisode?.name ? ` · ${featured.nextEpisode.name}` : ""}</p>
            {savedPositionCode(featured) && <p className="truncate text-[11px] text-muted-foreground"><T>Saved</T> {savedPositionCode(featured)}</p>}
            <div className="mt-1.5 flex items-center gap-2">
              {featured.progressPercent !== null && <div className="mini-progress min-w-8 flex-1" role="progressbar" aria-label={phrase(language, "Released episodes watched") } aria-valuenow={featured.progressPercent} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${featured.progressPercent}%` }} /></div>}
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{featured.progressPercent !== null ? `${featured.progressPercent}% · ` : ""}{featured.countDataAvailable ? `${featured.remainingCount} unwatched` : phrase(language, "Count unavailable")}</span>
            </div>
            <div className="mt-2 flex justify-end">
              <Button size="sm" className="h-9 max-w-full gap-1 rounded-full px-3 text-xs" disabled={!!busy} onClick={() => markNext(featured)} aria-label={`Mark ${nextCode(featured)} of ${featured.name} watched`}><Check className="size-3.5" /><T>Mark next watched</T></Button>
            </div>
          </div>
        </div> : <p className="mt-1 text-sm text-muted-foreground">{phrase(language, shows.length ? "You're caught up — no released episode is waiting." : "Add a show to start tracking.")} <Link to="/shows" className="text-primary"><T>Go to Shows</T></Link></p>}
      </section>

      {/* B. Statistics */}
      <section aria-label={phrase(language, "Watching statistics") } className="grid grid-cols-3 gap-2">
        {([[shows.length, "Total shows"], [dash.watching, "Watching"], [dash.episodesWatched ?? "—", "Episodes watched"]] as const).map(([value, label]) => <div key={label} className="dash-card px-2.5 py-2">
          <p className="text-lg font-semibold tabular-nums leading-tight">{typeof value === "number" ? value.toLocaleString() : value}</p>
          <p className="text-[11px] leading-tight text-muted-foreground">{phrase(language, label)}</p>
        </div>)}
      </section>
      {dash.verifiedShows > 0 && dash.verifiedShows < shows.length && <p className="-mt-3.5 text-[11px] text-muted-foreground/80">{verifiedShowCounts(language, dash.verifiedShows, shows.length)}</p>}

      {/* C. Continue watching */}
      {dash.continueWatching.length > 0 && <section aria-labelledby="continue-heading">
        <div className="dash-heading"><h2 id="continue-heading"><T>Continue watching</T></h2><Link to="/shows?status=watching" className="dash-link"><T>See all</T><ChevronRight className="size-3.5" /></Link></div>
        <ul className="h-rail pb-1">{dash.continueWatching.map(item => <li key={item.showId} className="w-[30%] min-w-[104px] max-w-[150px] shrink-0 md:w-[150px]">
          <div className="relative">
            <button type="button" onClick={() => open(item.showId)} aria-label={`Open ${item.name}, next ${nextCode(item)}`} className="block w-full text-left">
              <Poster url={item.posterURL} size="w185" className="aspect-[2/3] w-full" />
              <span className="mt-1.5 block truncate text-xs font-semibold">{item.name}</span>
              <span className="block truncate text-[11px] text-muted-foreground"><T>Next</T> {nextCode(item)}</span>
            </button>
            {/* Poster-sized overlay so the action sits on the poster's corner without covering the title. */}
            <span className="pointer-events-none absolute inset-x-0 top-0 aspect-[2/3]">
              <button type="button" disabled={!!busy} onClick={() => markNext(item)} aria-label={`Mark ${nextCode(item)} of ${item.name} watched`} className="touch-target pointer-events-auto absolute bottom-1.5 right-1.5 flex size-8 items-center justify-center rounded-full border border-primary/40 bg-background/85 text-primary shadow-lg backdrop-blur disabled:opacity-50">
                <Check className={`size-4 ${busy === item.showId ? "animate-pulse" : ""}`} />
              </button>
            </span>
          </div>
          {item.progressPercent !== null && <div className="mt-1 flex items-center gap-1.5"><div className="mini-progress flex-1"><span style={{ width: `${item.progressPercent}%` }} /></div><span className="text-[10px] tabular-nums text-muted-foreground">{item.progressPercent}%</span></div>}
        </li>)}</ul>
      </section>}

      {/* D. New episodes available (TMDB released episodes) */}
      {dash.newEpisodes.length > 0 && <section aria-labelledby="new-heading">
        <div className="dash-heading"><h2 id="new-heading"><T>New episodes available</T></h2>{dash.newEpisodes.length > 3 && <button type="button" className="dash-link" aria-expanded={allNew} onClick={() => setAllNew(value => !value)}>{allNew ? phrase(language, "Show less") : `${phrase(language, "See all")} ${dash.newEpisodes.length}`}</button>}</div>
        <ul className="space-y-1.5">{newShown.map(item => <li key={item.showId}><button type="button" onClick={() => open(item.showId)} className="dash-card dash-row flex min-h-14 w-full items-center gap-3 p-2 text-left">
          <Poster url={item.posterURL} size="w92" className="h-[54px] w-9" />
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{item.name}</span>
            <span className="block truncate text-xs text-muted-foreground">{item.newSeasonToWatch ? `Season ${item.newSeasonToWatch.season} is out · ` : ""}{plural(item.remainingCount, "released episode")} unwatched</span></span>
          <span className="release-tag shrink-0">{item.newSeasonToWatch ? "New season" : `${item.newEpisodes} new`}</span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </button></li>)}</ul>
      </section>}

      {/* E. Coming soon (TVMaze, same as Upcoming) */}
      {(upcoming.loading || comingSoon.length > 0) && !upcoming.error && <section aria-labelledby="soon-heading">
        <div className="dash-heading"><h2 id="soon-heading"><T>Coming soon</T></h2><Link to="/upcoming" className="dash-link"><T>Upcoming</T><ChevronRight className="size-3.5" /></Link></div>
        {upcoming.loading && !upcoming.schedule ? <div className="space-y-1.5" aria-busy="true">{[1, 2, 3].map(n => <Skeleton key={n} className="h-14 rounded-xl" />)}{upcoming.building && <p className="text-[11px] text-muted-foreground"><T>Preparing schedule…</T> {upcoming.building.done}/{upcoming.building.total}</p>}</div>
          : <ul className="space-y-1.5">{comingSoon.map(event => <li key={event.key}><button type="button" onClick={() => open(event.showId)} className="dash-card dash-row flex min-h-14 w-full items-center gap-3 p-2 text-left">
            <Poster url={event.posterURL} size="w92" className="h-[54px] w-9" />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{event.showName}</span><span className="block truncate text-xs text-muted-foreground">{localizedEpisodeLine(language, event)}</span></span>
            <span className="shrink-0 text-right text-xs"><span className="block font-semibold text-primary">{localizedShortDay(language, event.day, now)}</span>{timeLabel(event.timestamp, localeFor(language)) && <span className="block text-[11px] text-muted-foreground">{timeLabel(event.timestamp, localeFor(language))}</span>}</span>
          </button></li>)}</ul>}
      </section>}

      {upcomingMovies.length > 0 && <section aria-labelledby="upcoming-movies-heading">
        <div className="dash-heading"><h2 id="upcoming-movies-heading"><T>Upcoming Movies</T></h2><Link to="/upcoming?category=movies" className="dash-link"><T>See all</T><ChevronRight className="size-3.5" /></Link></div>
        <ul className="space-y-1.5">{upcomingMovies.map(movie => <li key={movie.tmdbId}><Link to="/upcoming?category=movies" className="dash-card dash-row flex min-h-14 items-center gap-3 p-2">
          <Poster url={movie.posterURL} size="w92" className="h-[54px] w-9" />
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{movie.title}</span><span className="block truncate text-xs text-muted-foreground">{movie.collectionName}</span></span>
          <span className="shrink-0 text-xs font-semibold text-primary">{localizedShortDay(language, movie.date!, now)}</span>
        </Link></li>)}</ul>
      </section>}

      {/* F. Recently watched (recorded watch times only) */}
      {dash.recent.length > 0 && <section aria-labelledby="recent-heading">
        <div className="dash-heading"><h2 id="recent-heading"><T>Recently watched</T></h2></div>
        <ul className="dash-card divide-y divide-border/60 px-1">{dash.recent.slice(0, 3).map(({ item, event }) => <li key={`${item.showId}-${event.season}-${event.episode}`}><button type="button" onClick={() => open(item.showId)} className="flex min-h-12 w-full items-center gap-3 px-2 py-1.5 text-left">
          <Poster url={item.posterURL} size="w92" className="h-10 w-7" />
          <span className="flex min-w-0 flex-1 gap-1 text-sm"><span className="truncate">{item.name}</span><span className="shrink-0 text-muted-foreground">· {episodeCode(event.season, event.episode)}</span></span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{relativeTime(event.watchedAt, now)}</span>
        </button></li>)}</ul>
      </section>}

      {/* Watchlist (hidden when empty) */}
      {dash.watchlist.length > 0 && <section aria-labelledby="watchlist-heading">
        <div className="dash-heading"><h2 id="watchlist-heading"><T>Watchlist</T></h2><Link to="/shows?status=planned" className="dash-link"><T>See all</T><ChevronRight className="size-3.5" /></Link></div>
        <ul className="h-rail">{dash.watchlist.slice(0, 8).map(item => <li key={item.showId} className="w-[22%] min-w-[72px] max-w-[96px] shrink-0"><button type="button" onClick={() => open(item.showId)} aria-label={`Open ${item.name}`} className="block w-full text-left">
          <Poster url={item.posterURL} size="w154" className="aspect-[2/3] w-full" /><span className="mt-1 block truncate text-[11px] text-muted-foreground">{item.name}</span>
        </button></li>)}</ul>
      </section>}

      {/* Saved progress that cannot be placed on episodes (kept, never hidden) */}
      {dash.attention.length > 0 && <details className="dash-card group px-3 py-1">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-semibold [&::-webkit-details-marker]:hidden"><AlertTriangle className="size-4 text-amber-400" /><T>Needs review</T><span className="text-xs font-normal text-muted-foreground">{dash.attention.length}</span><ChevronDown className="ml-auto size-4 text-muted-foreground transition-transform group-open:rotate-180" /></summary>
        <p className="pb-2 text-xs text-muted-foreground"><T>Saved progress for these shows cannot be placed on episodes. Nothing has been changed.</T></p>
        <ul className="space-y-1 pb-2">{dash.attention.map(({ item, reason }) => <li key={item.showId} className="flex min-w-0 items-center gap-2">
          <button type="button" onClick={() => open(item.showId)} className="min-w-0 flex-1 py-1 text-left"><span className="block truncate text-sm font-medium">{item.name}</span><span className="block truncate text-xs text-muted-foreground">{reason}</span></button>
          <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => open(item.showId, true)}>{phrase(language, item.progressUnavailable?.code === "no_tmdb_association" ? "Link to TMDB" : "Fix match")}</Button>
        </li>)}</ul>
      </details>}

      {dash.unavailable > 0 && <p className="text-[11px] text-muted-foreground">{unavailableShowCounts(language, dash.unavailable)}</p>}
    </>}
    <ShowModal type="show" selectedShow={selectedShow} closeModal={() => { setSelectedShow(""); setEditMatch(false); }} shows={shows} setShows={setShows} initialEditMatch={editMatch} />
  </div>;
}
