import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { AlertTriangle, CalendarDays, ChevronDown, Info, RefreshCw, Tv } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import ShowModal from "@/modals/ShowModal";
import { ShowService } from "@/services";
import type { ShowType } from "@/types";
import { posterSrc } from "@/lib/poster";
import { useNow, useUpcomingSchedule } from "@/hooks/use-upcoming";
import {
  calendarFilters, calendarStats, dayHeading, episodeCode, eventEpisodeLine, filterEvents, groupByDay, groupReleaseEvents, relativeDay, timeLabel,
  type CalendarFilter, type ReleaseEvent,
} from "@/lib/upcoming-calendar";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const emptyText: Record<CalendarFilter, string> = {
  all: "No confirmed new episodes yet.", today: "Nothing new airs today.", week: "Nothing new this week.",
  month: "Nothing new this month.", premieres: "No season premieres scheduled.",
};

function Poster({ url, className }: { url: string | null; className: string }) {
  return url
    ? <img src={posterSrc(url, "w154")} alt="" loading="lazy" decoding="async" className={`dash-poster ${className}`} />
    : <span className={`dash-poster flex items-center justify-center text-muted-foreground ${className}`}><Tv className="size-4" /></span>;
}

function ReleaseCard({ event, onOpen }: { event: ReleaseEvent; onOpen: (showId: string) => void }) {
  const [open, setOpen] = useState(false);
  const grouped = event.episodes.length > 1;
  const single = event.episodes[0];
  const time = timeLabel(event.timestamp);
  const line = eventEpisodeLine(event);
  return <article className="dash-card dash-row overflow-hidden">
    <div className="flex min-w-0 items-stretch">
      <button type="button" onClick={() => onOpen(event.showId)} aria-label={`Open ${event.showName}: ${line}${time ? `, ${time}` : ""}`} className="flex min-w-0 flex-1 items-center gap-3 p-2.5 text-left">
        <Poster url={event.posterURL} className="h-[66px] w-11" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="line-clamp-2 break-words text-[0.9rem] font-semibold leading-snug">{event.showName}</span>
          </span>
          <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
            {event.premiere && <span className="release-tag whitespace-nowrap">Premiere</span>}
            <span className="min-w-0 break-words">{line}</span>
          </span>
          {!grouped && single.name && !/^Episode \d+$/i.test(single.name) && <span className="mt-0.5 block truncate text-xs text-foreground/75">{single.name}</span>}
          {grouped && <span className="mt-0.5 block text-xs text-foreground/75">{plural(event.episodes.length, "episode")}</span>}
        </span>
        <span className="shrink-0 self-start pt-0.5 text-right">
          {time ? <span className="block text-xs font-semibold text-primary">{time}</span> : null}
          {event.channel && <span className="mt-0.5 hidden max-w-[5.5rem] truncate text-[11px] text-muted-foreground min-[360px]:block">{event.channel}</span>}
        </span>
      </button>
      {grouped && <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} the ${event.episodes.length} episodes of ${event.showName}`} className="flex w-11 shrink-0 items-center justify-center border-l border-border/60 text-muted-foreground hover:text-primary">
        <ChevronDown className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>}
    </div>
    {grouped && open && <ol className="border-t border-border/60 px-3 py-1.5 text-xs">
      {event.episodes.map(episode => <li key={episode.id} className="flex min-h-8 items-center gap-2 py-1">
        <span className="w-14 shrink-0 font-mono text-[11px] text-muted-foreground">{episodeCode(episode.season, episode.number)}</span>
        <span className="min-w-0 flex-1 break-words">{episode.name || "Title not announced"}</span>
        {episode.airTimestamp && episode.airTimestamp !== event.timestamp && <span className="shrink-0 text-muted-foreground">{timeLabel(episode.airTimestamp)}</span>}
      </li>)}
    </ol>}
  </article>;
}

export default function UpcomingPage() {
  const { schedule, building, loading, refreshing, error, refresh } = useUpcomingSchedule();
  const now = useNow();
  const [filter, setFilter] = useState<CalendarFilter>("all");
  const [shows, setShows] = useState<ShowType[]>([]);
  const [selectedShow, setSelectedShow] = useState("");
  useEffect(() => { ShowService.getAllShows().then(setShows).catch(() => {}); }, []);

  const events = useMemo(() => groupReleaseEvents(schedule?.releases || [], now), [schedule, now]);
  const visible = useMemo(() => filterEvents(events, filter, now), [events, filter, now]);
  const days = useMemo(() => groupByDay(visible), [visible]);
  const stats = calendarStats(events);
  const counts = useMemo(() => Object.fromEntries(calendarFilters.map(f => [f.id, filterEvents(events, f.id, now).length])) as Record<CalendarFilter, number>, [events, now]);
  const coverage = schedule?.coverage;
  const updated = schedule ? new Date(schedule.generatedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : null;

  return <div className="mx-auto w-full min-w-0 max-w-3xl px-4 pb-4 pt-3 md:px-8 md:pt-6">
    <header className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">Upcoming</h1>
        <p className="text-xs text-muted-foreground">New episodes from your shows, by release date</p>
      </div>
      <Button type="button" variant="outline" size="icon" className="shrink-0 rounded-full" onClick={refresh} disabled={refreshing || loading} aria-label="Refresh schedule">
        <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
      </Button>
    </header>

    {schedule && <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-label="Release statistics">
      <span><strong className="font-semibold text-foreground">{stats.episodes}</strong> {stats.episodes === 1 ? "episode" : "episodes"}</span>
      <span><strong className="font-semibold text-foreground">{stats.shows}</strong> {stats.shows === 1 ? "show" : "shows"}</span>
      <span><strong className="font-semibold text-primary">{stats.premieres}</strong> {stats.premieres === 1 ? "premiere" : "premieres"}</span>
      {updated && <span className="ml-auto">Updated {updated}</span>}
    </p>}
    {schedule?.stale && <p role="status" className="mt-2 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
      <AlertTriangle className="mt-px size-3.5 shrink-0" />TVMaze could not be reached for some shows; their last saved schedule is shown and may be out of date.
    </p>}

    <nav aria-label="Upcoming filters" className="filter-rail mt-3">
      {calendarFilters.map(option => <button key={option.id} type="button" aria-pressed={filter === option.id} onClick={() => setFilter(option.id)} className="upcoming-filter min-h-10 shrink-0 whitespace-nowrap px-3.5 text-xs font-semibold">
        {option.label}{schedule && <span className="ml-1.5 opacity-70">{counts[option.id]}</span>}
      </button>)}
    </nav>

    {error && <div role="alert" className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm"><span>{error}</span><Button size="sm" variant="outline" onClick={refresh}>Retry</Button></div>}

    {loading && !schedule ? <div className="mt-4 space-y-2" aria-label="Loading upcoming releases" aria-busy="true">
      {building && building.total > 0 && <div className="dash-card p-3 text-xs text-muted-foreground" role="status">
        <p>Preparing your TVMaze schedule… {building.done} of {building.total} shows checked</p>
        <div className="mini-progress mt-2"><span style={{ width: `${Math.round((building.done / building.total) * 100)}%` }} /></div>
      </div>}
      <Skeleton className="h-5 w-40 rounded-md" />
      {[1, 2, 3, 4].map(n => <Skeleton key={n} className="h-[86px] rounded-2xl" />)}
    </div> : schedule && <>
      {days.length ? <section aria-label="Scheduled new episodes" className="mt-2">
        {days.map(({ day, events: dayEvents }) => <section key={day} aria-labelledby={`day-${day}`} className="release-day-group">
          <h2 id={`day-${day}`} className="release-day flex items-baseline justify-between text-[11px] font-bold tracking-[0.12em] text-muted-foreground">
            <span>{dayHeading(day)}</span>{relativeDay(day, now) && <span className="text-primary">{relativeDay(day, now)}</span>}
          </h2>
          <div className="space-y-2 pb-2">{dayEvents.map(event => <ReleaseCard key={event.key} event={event} onOpen={setSelectedShow} />)}</div>
        </section>)}
      </section> : !error && <div className="dash-card mt-4 px-4 py-6 text-center">
        <CalendarDays className="mx-auto size-7 text-primary" />
        <h2 className="mt-2 text-sm font-semibold">{emptyText[filter]}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{filter === "all" ? "Episodes appear here once TVMaze confirms a date for a show in your library." : "Try another filter."}</p>
        {filter === "all" && !schedule.coverage.evaluatedShows && <Button asChild size="sm" className="mt-3"><Link to="/shows">Add shows</Link></Button>}
      </div>}

      {schedule.returningTba.length > 0 && <details className="dash-card group mt-4 px-3 py-1">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-semibold [&::-webkit-details-marker]:hidden">
          Returning — Date TBA<span className="text-xs font-normal text-muted-foreground">{schedule.returningTba.length}</span><ChevronDown className="ml-auto size-4 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <p className="pb-2 text-xs text-muted-foreground">TVMaze lists these shows as continuing, but no new episode has a confirmed date.</p>
        <ul className="space-y-1 pb-2">{schedule.returningTba.map(show => <li key={show.showId}><button type="button" onClick={() => setSelectedShow(show.showId)} className="flex min-h-12 w-full items-center gap-3 rounded-lg px-1 py-1 text-left hover:bg-muted/40">
          <Poster url={show.posterURL} className="h-12 w-8" />
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{show.showName}</span><span className="block text-xs text-muted-foreground">{show.announcedEpisodes ? `${plural(show.announcedEpisodes, "episode")} announced, no date` : show.tvmazeStatus === "Running" ? "Between seasons" : show.tvmazeStatus}</span></span>
          <span className="shrink-0 text-[11px] text-muted-foreground">Date TBA</span>
        </button></li>)}</ul>
      </details>}

      {schedule.needsReview.length > 0 && <details className="dash-card group mt-3 px-3 py-1">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-semibold [&::-webkit-details-marker]:hidden">
          <AlertTriangle className="size-4 text-amber-400" />Schedule match needs review<span className="text-xs font-normal text-muted-foreground">{schedule.needsReview.length}</span><ChevronDown className="ml-auto size-4 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <p className="pb-2 text-xs text-muted-foreground">These shows could not be matched to TVMaze with certainty, so no dates are shown for them. Nothing was changed.</p>
        <ul className="space-y-1 pb-2">{schedule.needsReview.map(item => <li key={item.showId}><button type="button" onClick={() => setSelectedShow(item.showId)} className="flex min-h-12 w-full items-center gap-3 rounded-lg px-1 py-1 text-left hover:bg-muted/40">
          <Poster url={item.posterURL} className="h-12 w-8" />
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{item.showName}</span><span className="block text-xs leading-snug text-muted-foreground">{item.detail}</span></span>
        </button></li>)}</ul>
      </details>}

      {coverage && <details className="group mt-3 rounded-xl px-3 text-xs text-muted-foreground">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 font-medium [&::-webkit-details-marker]:hidden"><Info className="size-3.5 text-primary" />Schedule source: TVMaze<ChevronDown className="ml-auto size-4 transition-transform group-open:rotate-180" /></summary>
        <ul className="space-y-1 pb-3 leading-relaxed">
          <li>{plural(coverage.evaluatedShows, "show")} checked · {coverage.verifiedShows} matched on TVMaze ({coverage.verifiedByExternalId} by TheTVDB/IMDb ID{coverage.verifiedByTitle ? `, ${coverage.verifiedByTitle} by title, premiere and synopsis` : ""}).</li>
          {coverage.unresolvedShows > 0 && <li>{coverage.unresolvedShows} not matched with certainty (listed above).</li>}
          {coverage.unavailableShows > 0 && <li>{coverage.unavailableShows} could not be checked right now.</li>}
          <li>Only first-run episodes are listed: {coverage.excludedEpisodes.repeats} repeat{coverage.excludedEpisodes.repeats === 1 ? "" : "s"}, {coverage.excludedEpisodes.duplicates} duplicate{coverage.excludedEpisodes.duplicates === 1 ? "" : "s"} and {coverage.excludedEpisodes.specials} special{coverage.excludedEpisodes.specials === 1 ? "" : "s"} left out.</li>
          <li>Times are shown in your time zone when TVMaze confirms them; otherwise only the date is shown.</li>
        </ul>
      </details>}
    </>}
    <ShowModal type="show" selectedShow={selectedShow} closeModal={() => setSelectedShow("")} shows={shows} setShows={setShows} />
  </div>;
}
