import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { AlertTriangle, ChevronDown, ChevronLeft, Clapperboard, Film, Info, RefreshCw, Star, Tv } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { posterSrc } from "@/lib/poster";
import { barPercent, hasAnyStats, pickYear, rankGenres, sharePercent, splitDuration, type GenreSort } from "@/lib/cinema-stats";
import { useStatsText } from "@/i18n/stats";
import { StatsService, type CinemaStats } from "@/services/stats.service";

/*
 * Series colours (validated for colour-vision deficiency and contrast against Cinetra's light and dark surfaces):
 * TV = mint, Movies = blue. Single-series bars use the existing mint progress gradient; ratings use the gold of the
 * movie rating stars. Text never takes a series colour.
 */
const TV_FILL = "bg-[#14936a] dark:bg-[#25a87b]";
const MOVIE_FILL = "bg-[#3b6fd4] dark:bg-[#5b8def]";
const MINT_FILL = "bg-gradient-to-r from-[oklch(0.64_0.14_164)] to-primary";
const YEAR_KEY = "cinetra-stats-year";

function Poster({ url, kind, className }: { url: string | null; kind: "tv" | "movie"; className: string }) {
  const Icon = kind === "tv" ? Tv : Film;
  return url
    ? <img src={posterSrc(url, "w92")} alt="" loading="lazy" decoding="async" className={`dash-poster ${className}`} />
    : <span className={`dash-poster flex items-center justify-center text-muted-foreground ${className}`}><Icon className="size-4" /></span>;
}

export default function StatsPage() {
  const { s, locale } = useStatsText();
  const navigate = useNavigate();
  const [stats, setStats] = useState<CinemaStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [genreSort, setGenreSort] = useState<GenreSort>("time");
  const [year, setYear] = useState<number | null>(() => {
    try { const saved = Number(localStorage.getItem(YEAR_KEY)); return Number.isInteger(saved) && saved > 1900 ? saved : null; } catch { return null; }
  });

  const load = useCallback(async () => {
    setLoading(true);
    try { setStats(await StatsService.getStats()); setError(false); }
    catch { setError(true); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const years = useMemo(() => stats?.years.items.map(item => item.year) ?? [], [stats]);
  const selectedYear = pickYear(years, year);
  const chooseYear = (value: number) => {
    setYear(value);
    try { localStorage.setItem(YEAR_KEY, String(value)); } catch { /* storage unavailable */ }
  };

  const number = (value: number) => value.toLocaleString(locale);
  const duration = (minutes: number) => {
    const d = splitDuration(minutes);
    return d.hours ? `${number(d.hours)} ${s("hours")}${d.minutes ? ` ${number(d.minutes)} ${s("minutes")}` : ""}` : `${number(d.minutes)} ${s("minutes")}`;
  };
  const back = () => { if ((window.history.state as { idx?: number } | null)?.idx) navigate(-1); else navigate("/"); };

  return <div className="flex min-h-svh min-w-0 flex-col">
    <header className="app-header sticky top-0 z-30 flex min-h-16 shrink-0 items-center gap-1 border-b bg-background/95 px-2 md:px-6 md:backdrop-blur-xl">
      <Button variant="ghost" size="icon" onClick={back} aria-label={s("back")} className="rounded-full"><ChevronLeft className="size-5 rtl:rotate-180" /></Button>
      <h1 className="min-w-0 truncate text-base font-semibold tracking-tight">{s("title")}</h1>
      <Button variant="ghost" size="icon" onClick={load} disabled={loading} aria-label={s("refresh")} className="ms-auto rounded-full"><RefreshCw className={`size-4 ${loading && stats ? "animate-spin" : ""}`} /></Button>
    </header>

    <main id="main-content" className="mx-auto w-full min-w-0 max-w-3xl space-y-4 px-4 pb-[calc(2rem+env(safe-area-inset-bottom))] pt-4 md:px-8 md:pt-6">
      {loading && !stats ? <div className="space-y-4" aria-busy="true" aria-label={s("loading")}>
        <Skeleton className="h-44 rounded-2xl" />
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">{[1, 2, 3, 4].map(n => <Skeleton key={n} className="h-[84px] rounded-xl" />)}</div>
        <Skeleton className="h-56 rounded-2xl" />
        <Skeleton className="h-56 rounded-2xl" />
      </div>
        : error && !stats ? <div role="alert" className="dash-card px-4 py-8 text-center">
          <AlertTriangle className="mx-auto size-7 text-amber-400" />
          <p className="mt-2 text-sm font-semibold">{s("error")}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={load}>{s("retry")}</Button>
        </div>
          : stats && !hasAnyStats(stats) ? <div className="dash-card px-4 py-10 text-center">
            <Clapperboard className="mx-auto size-8 text-primary" />
            <h2 className="mt-3 text-base font-semibold">{s("emptyTitle")}</h2>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{s("emptyBody")}</p>
            <div className="mt-4 flex justify-center gap-2"><Button asChild size="sm"><Link to="/shows">{s("goShows")}</Link></Button><Button asChild size="sm" variant="outline"><Link to="/movies">{s("goMovies")}</Link></Button></div>
          </div>
            : stats && <>
              {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm">{s("error")}</p>}
              {stats.metadataPending > 0 && <div role="status" className="flex items-center justify-between gap-3 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                <span>{s("pending")}</span><Button size="sm" variant="outline" onClick={load} disabled={loading}>{s("refresh")}</Button>
              </div>}
              <WatchTime stats={stats} number={number} duration={duration} s={s} />
              <Kpis stats={stats} number={number} s={s} />
              <Genres stats={stats} sort={genreSort} setSort={setGenreSort} duration={duration} s={s} />
              <Ratings stats={stats} number={number} s={s} />
              <YearInCinema stats={stats} year={selectedYear} chooseYear={chooseYear} number={number} duration={duration} s={s} locale={locale} />
              <Methodology stats={stats} number={number} s={s} />
            </>}
    </main>
  </div>;
}

type Text = ReturnType<typeof useStatsText>["s"];
type Fmt = { number: (n: number) => string; s: Text };

function WatchTime({ stats, number, duration, s }: Fmt & { stats: CinemaStats; duration: (m: number) => string }) {
  const { totalMinutes, tv, movies } = stats.watchTime;
  const total = splitDuration(totalMinutes);
  const tvShare = sharePercent(tv.minutes, totalMinutes);
  const segments = [
    { key: "tv", label: s("tv"), minutes: tv.minutes, share: tvShare, fill: TV_FILL },
    { key: "movies", label: s("movies"), minutes: movies.minutes, share: totalMinutes > 0 ? 100 - tvShare : 0, fill: MOVIE_FILL },
  ];
  return <section aria-labelledby="watch-time-heading" className="upcoming-hero p-4 md:p-5">
    <h2 id="watch-time-heading" className="cinema-eyebrow">{s("watchTime")}</h2>
    <p className="mt-2 flex items-baseline gap-1.5 tabular-nums">
      <span className="text-5xl font-semibold leading-none tracking-tight">{number(total.hours)}</span><span className="text-lg font-medium text-white/80">{s("hours")}</span>
      {total.minutes > 0 && <><span className="ms-1 text-2xl font-semibold leading-none">{number(total.minutes)}</span><span className="text-sm text-white/80">{s("minutes")}</span></>}
    </p>
    {total.days > 0 && <p className="mt-1 text-sm text-white/75">{s("days", { n: total.days })}</p>}
    {totalMinutes > 0 && <>
      <div className="mt-4 flex h-2.5 gap-[2px] overflow-hidden rounded-full bg-white/10" role="img" aria-label={segments.map(seg => `${seg.label}: ${duration(seg.minutes)}`).join(", ")}>
        {segments.filter(seg => seg.share > 0).map(seg => <span key={seg.key} className={`${seg.fill} h-full first:rounded-s-full last:rounded-e-full`} style={{ width: `${seg.share}%` }} title={`${seg.label}: ${duration(seg.minutes)}`} />)}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-2 text-xs">
        {segments.map(seg => <li key={seg.key} className="flex min-w-0 items-start gap-2">
          <span className={`${seg.fill} mt-1 size-2.5 shrink-0 rounded-full`} aria-hidden="true" />
          <span className="min-w-0"><span className="block truncate text-white/75">{seg.label}</span><span className="block font-semibold tabular-nums text-white">{duration(seg.minutes)} <span className="font-normal text-white/60">· {number(seg.share)}%</span></span></span>
        </li>)}
      </ul>
    </>}
    <p className="mt-3 text-[11px] leading-snug text-white/60">{s("watchTimeNote")}</p>
  </section>;
}

function Kpis({ stats, number, s }: Fmt & { stats: CinemaStats }) {
  const avg = stats.ratings.movies.average;
  const tiles = [
    { label: s("episodesWatched"), value: number(stats.tv.watchedEpisodes), detail: stats.tv.watchedEpisodes ? s("episodeSources", { a: stats.tv.episodesFromRecords, b: stats.tv.episodesFromSavedPositions }) : null },
    { label: s("showsCompleted"), value: number(stats.tv.completed), detail: s("statusSplit", { a: stats.tv.statusCounts.watching, b: stats.tv.statusCounts.dropped }) },
    { label: s("moviesWatched"), value: number(stats.movies.watched), detail: s("watchlistDetail", { n: stats.movies.watchlist }) },
    { label: s("avgRating"), value: avg === null ? "—" : avg.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), suffix: avg === null ? null : "/10", detail: avg === null ? s("notRated") : s("ratedDetail", { n: stats.ratings.movies.count }) },
  ];
  return <section>
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      {tiles.map(tile => <div key={tile.label} className="dash-card min-w-0 px-3 py-2.5">
        <p className="truncate text-[11px] font-medium text-muted-foreground">{tile.label}</p>
        <p className="mt-0.5 text-2xl font-semibold leading-tight tabular-nums">{tile.value}{tile.suffix && <span className="ms-0.5 text-sm font-medium text-muted-foreground">{tile.suffix}</span>}</p>
        {tile.detail && <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">{tile.detail}</p>}
      </div>)}
    </div>
    {stats.tv.showsNotCounted > 0 && <p className="mt-2 flex items-start gap-1.5 px-1 text-[11px] leading-snug text-muted-foreground"><Info className="mt-px size-3.5 shrink-0 text-primary" />{s("notCounted", { n: stats.tv.showsNotCounted })}</p>}
  </section>;
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string }[]; onChange: (id: T) => void }) {
  return <div role="group" aria-label={label} className="flex shrink-0 rounded-full border bg-muted/40 p-0.5">
    {options.map(option => <button key={option.id} type="button" aria-pressed={value === option.id} onClick={() => onChange(option.id)}
      className={`relative min-h-8 rounded-full px-3 text-xs font-semibold transition-colors touch-target ${value === option.id ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"}`}>{option.label}</button>)}
  </div>;
}

function Genres({ stats, sort, setSort, duration, s }: { s: Text; stats: CinemaStats; sort: GenreSort; setSort: (v: GenreSort) => void; duration: (m: number) => string }) {
  const items = rankGenres(stats.genres.items, sort);
  const max = Math.max(0, ...items.map(g => sort === "time" ? g.minutes : g.titles));
  return <section aria-labelledby="genres-heading" className="dash-card p-3 md:p-4">
    <div className="dash-heading"><h2 id="genres-heading">{s("genres")}</h2>
      {items.length > 0 && <Segmented label={s("sortGenres")} value={sort} onChange={setSort} options={[{ id: "time", label: s("byTime") }, { id: "titles", label: s("byTitles") }]} />}
    </div>
    {items.length ? <ul className="mt-2 space-y-2.5">
      {items.map(genre => {
        const value = sort === "time" ? genre.minutes : genre.titles;
        const label = sort === "time" ? duration(genre.minutes) : s("titles", { n: genre.titles });
        return <li key={genre.name} title={`${genre.name}: ${duration(genre.minutes)} · ${s("titles", { n: genre.titles })}`}>
          <div className="flex items-baseline justify-between gap-3 text-xs"><span className="truncate font-medium">{genre.name}</span><span className="shrink-0 tabular-nums text-muted-foreground">{label}</span></div>
          <div className="mt-1 h-1.5 rounded-full bg-muted/60"><span className={`block h-full rounded-full ${MINT_FILL}`} style={{ width: `${barPercent(value, max)}%` }} /></div>
        </li>;
      })}
    </ul> : <p className="mt-1 text-sm text-muted-foreground">{s("genresEmpty")}</p>}
    {stats.genres.titlesWithoutGenres > 0 && <p className="mt-3 text-[11px] text-muted-foreground">{s("genresMissing", { n: stats.genres.titlesWithoutGenres })}</p>}
  </section>;
}

function Ratings({ stats, number, s }: Fmt & { stats: CinemaStats }) {
  const { count, average, distribution, top } = stats.ratings.movies;
  const max = Math.max(0, ...distribution);
  return <section aria-labelledby="ratings-heading" className="dash-card p-3 md:p-4">
    <div className="dash-heading"><h2 id="ratings-heading">{s("ratings")}</h2>
      {average !== null && <span className="flex items-center gap-1 text-sm font-semibold tabular-nums"><Star className="size-4 fill-amber-300 text-amber-300" aria-hidden="true" />{average.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}<span className="text-xs font-normal text-muted-foreground">/10</span></span>}
    </div>
    {count ? <div className="mt-2 grid gap-4 md:grid-cols-2">
      <div>
        <h3 className="text-[11px] font-medium text-muted-foreground">{s("distribution")}</h3>
        <div className="mt-2 flex h-28 items-end gap-[2px]" role="list" aria-label={s("distribution")}>
          {distribution.map((n, i) => <div key={i} role="listitem" aria-label={s("ratingBar", { a: i + 1, b: n })} title={s("ratingBar", { a: i + 1, b: n })} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end">
            {n > 0 && <span className="mb-0.5 text-[10px] tabular-nums text-muted-foreground">{number(n)}</span>}
            <span className={`w-full max-w-6 rounded-t-[4px] ${n ? "bg-amber-300/85" : "bg-muted/60"}`} style={{ height: n ? `${barPercent(n, max)}%` : "2px" }} />
          </div>)}
        </div>
        <div className="mt-1 flex gap-[2px] text-center text-[10px] tabular-nums text-muted-foreground" aria-hidden="true">{distribution.map((_, i) => <span key={i} className="flex-1">{i + 1}</span>)}</div>
      </div>
      <div>
        <h3 className="text-[11px] font-medium text-muted-foreground">{s("highestRated")}</h3>
        <ol className="mt-1.5 space-y-1">
          {top.map((movie, index) => <li key={movie.id} className="flex min-h-12 items-center gap-3">
            <span className="w-3 shrink-0 text-center text-xs tabular-nums text-muted-foreground">{index + 1}</span>
            <Poster url={movie.posterURL} kind="movie" className="h-12 w-8" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{movie.name}</span>
            <span className="flex shrink-0 items-center gap-1 text-xs font-semibold tabular-nums" aria-label={s("yourRating", { n: movie.rating })}><Star className="size-3.5 fill-amber-300 text-amber-300" aria-hidden="true" />{number(movie.rating)}</span>
          </li>)}
        </ol>
      </div>
    </div> : <p className="mt-1 text-sm text-muted-foreground">{s("ratingsEmpty")}</p>}
    <p className="mt-3 text-[11px] leading-snug text-muted-foreground">{s("ratingsNote")}</p>
  </section>;
}

function YearInCinema({ stats, year, chooseYear, number, duration, s, locale }: Fmt & { stats: CinemaStats; year: number | null; chooseYear: (y: number) => void; duration: (m: number) => string; locale: string }) {
  const entry = stats.years.items.find(item => item.year === year) || null;
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => { setActive(null); }, [year]);
  const monthName = (index: number, style: "long" | "narrow") => new Date(Date.UTC(2000, index, 15)).toLocaleDateString(locale, { month: style, timeZone: "UTC" });
  const max = entry ? Math.max(0, ...entry.months.map(m => m.minutes)) : 0;
  const peak = entry && max > 0 ? entry.months.findIndex(m => m.minutes === max) : null;
  const shown = active ?? peak;
  const showMonth = shown !== null && entry ? entry.months[shown] : null;

  return <section aria-labelledby="year-heading" className="dash-card p-3 md:p-4">
    <div className="dash-heading"><h2 id="year-heading">{s("yearInCinema")}</h2></div>
    {stats.years.items.length > 0 && <nav aria-label={s("chooseYear")} className="filter-rail mt-1">
      {stats.years.items.map(item => <button key={item.year} type="button" aria-pressed={item.year === year} onClick={() => chooseYear(item.year)} className="upcoming-filter min-h-10 shrink-0 px-3.5 text-xs font-semibold tabular-nums">{item.year}</button>)}
    </nav>}
    {entry ? <>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {([[s("yearEpisodes"), number(entry.episodes)], [s("yearMovies"), number(entry.movieViewings)], [s("yearTime"), duration(entry.minutes)]] as const).map(([label, value]) => <div key={label} className="min-w-0 rounded-xl bg-muted/40 px-2.5 py-2">
          <p className="truncate text-[11px] text-muted-foreground">{label}</p><p className="text-sm font-semibold leading-tight tabular-nums sm:text-base">{value}</p>
        </div>)}
      </div>

      <h3 className="mt-4 text-[11px] font-medium text-muted-foreground">{s("monthly")}</h3>
      <p className="mt-0.5 min-h-4 text-xs tabular-nums" aria-live="polite">{showMonth && shown !== null ? <><span className="font-semibold">{monthName(shown, "long")}</span> · {duration(showMonth.minutes)} · <span className="text-muted-foreground">{s("monthDetail", { a: showMonth.episodes, b: showMonth.movieViewings })}</span></> : null}</p>
      <div className="mt-2 flex h-28 items-end gap-[2px]" onPointerLeave={() => setActive(null)}>
        {entry.months.map((month, index) => <button key={index} type="button" aria-label={`${monthName(index, "long")}: ${duration(month.minutes)}, ${s("monthDetail", { a: month.episodes, b: month.movieViewings })}`} aria-pressed={shown === index}
          onPointerEnter={() => setActive(index)} onFocus={() => setActive(index)} onClick={() => setActive(index)}
          className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end rounded-md focus-visible:outline-2 focus-visible:outline-primary">
          <span className={`w-full max-w-6 rounded-t-[4px] transition-opacity ${month.minutes ? MINT_FILL : "bg-muted/60"} ${shown !== null && shown !== index && month.minutes ? "opacity-55" : ""}`} style={{ height: month.minutes ? `${barPercent(month.minutes, max)}%` : "2px" }} />
        </button>)}
      </div>
      <div className="mt-1 flex gap-[2px] text-center text-[10px] text-muted-foreground" aria-hidden="true">{entry.months.map((_, i) => <span key={i} className="flex-1">{monthName(i, "narrow")}</span>)}</div>
      <table className="sr-only"><caption>{s("monthly")} {entry.year}</caption><tbody>{entry.months.map((m, i) => <tr key={i}><th scope="row">{monthName(i, "long")}</th><td>{duration(m.minutes)}</td><td>{s("monthDetail", { a: m.episodes, b: m.movieViewings })}</td></tr>)}</tbody></table>

      {(entry.topShows.length > 0 || entry.topGenres.length > 0) && <div className="mt-4 grid gap-4 md:grid-cols-2">
        {entry.topShows.length > 0 && <div>
          <h3 className="text-[11px] font-medium text-muted-foreground">{s("topShows")}</h3>
          <ol className="mt-1.5 space-y-1">{entry.topShows.map(show => <li key={show.id} className="flex min-h-12 items-center gap-3">
            <Poster url={show.posterURL} kind="tv" className="h-12 w-8" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{show.name}</span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{s("episodesShort", { n: show.episodes })}</span>
          </li>)}</ol>
        </div>}
        {entry.topGenres.length > 0 && <div>
          <h3 className="text-[11px] font-medium text-muted-foreground">{s("topGenres")}</h3>
          <ul className="mt-2 flex flex-wrap gap-1.5">{entry.topGenres.map(genre => <li key={genre.name} className="cinema-tag" title={`${genre.name}: ${duration(genre.minutes)} · ${s("titles", { n: genre.titles })}`}>{genre.name}</li>)}</ul>
        </div>}
      </div>}
      <ul className="mt-4 space-y-1 text-[11px] leading-snug text-muted-foreground">
        <li>{s("yearNote")}</li>
        {entry.bulkLoggedEpisodes > 0 && <li>{s("bulk", { n: entry.bulkLoggedEpisodes })}</li>}
        {entry.itemsWithoutRuntime > 0 && <li>{s("yearNoRuntime", { n: entry.itemsWithoutRuntime })}</li>}
      </ul>
    </> : <div className="mt-2 rounded-xl bg-muted/30 px-3 py-4 text-center">
      <p className="text-sm font-semibold">{s("yearEmpty")}</p>
      <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">{s("yearEmptyBody")}</p>
    </div>}
  </section>;
}

function Methodology({ stats, number, s }: Fmt & { stats: CinemaStats }) {
  const { tv, movies } = stats.watchTime;
  const withoutRuntime = tv.episodesWithoutRuntime + movies.moviesWithoutRuntime;
  const { savedPositionEpisodes, watchedMoviesWithoutViewingDate } = stats.years.undated;
  return <details className="group rounded-xl px-1 text-xs text-muted-foreground">
    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 font-medium [&::-webkit-details-marker]:hidden"><Info className="size-3.5 text-primary" />{s("howCalculated")}<ChevronDown className="ms-auto size-4 transition-transform group-open:rotate-180" /></summary>
    <ul className="space-y-1.5 pb-3 leading-relaxed">
      <li>{s("watchTimeNote")}</li>
      {stats.tv.completed > 0 && <li>{s("showsCompleted")}: {number(stats.tv.completed)} · {s("completedDetail", { n: stats.tv.fullyWatched })}</li>}
      {tv.episodesEstimated > 0 && <li>{s("estimatedEpisodes", { n: tv.episodesEstimated })}</li>}
      {withoutRuntime > 0 && <li>{s("noRuntime", { n: withoutRuntime })}</li>}
      {(savedPositionEpisodes > 0 || watchedMoviesWithoutViewingDate > 0) && <li>{s("undated", { a: savedPositionEpisodes, b: watchedMoviesWithoutViewingDate })}</li>}
      <li>{s("timeZone", { n: stats.timeZone })}</li>
      <li>{s("ratingsNote")}</li>
      {stats.tv.showsNotCounted > 0 && <li>{s("notCounted", { n: stats.tv.showsNotCounted })}</li>}
    </ul>
  </details>;
}
