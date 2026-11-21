/**
 * My Cinema Stats: pure, read-only aggregation over records that already exist. No database or provider access.
 *
 * Rules (kept identical to what the rest of Cinetra shows):
 * - Watched episodes come from the same merge every page uses (saved position + individual records − unwatch
 *   exceptions), restricted to released regular episodes, each episode counted once. Like Home's "Episodes watched",
 *   only shows whose counts are verified (reliable released-episode metadata, no unresolved saved-position conflict)
 *   are added up; the others are reported, never guessed.
 * - A movie is watched when its personal status is Watched. Personal ratings (1-10) exist for movies only; TMDB
 *   community ratings are never used.
 * - Watch time is an estimate: TMDB runtimes, each watched episode/movie counted once. An episode without a listed
 *   runtime borrows the median of its show's listed runtimes and is reported separately as estimated.
 * - Years use only real recorded timestamps (episode records and logged movie viewings). Saved positions, Watched
 *   statuses and release dates never produce a viewing date.
 */
import { buildTrackingSummary, mergeShowEpisodes, type Catalog, type TrackedShow, type UnwatchRecord, type WatchRecord } from './tracking-summary.model';
import { episodeKey } from './legacy-progress.model';
import { isEpisodeReleased } from './release-rule.model';

export type StatsShowInput = {
  show: TrackedShow;
  catalog: Catalog | null;
  watches: WatchRecord[];
  unwatches: UnwatchRecord[];
  /** TMDB genre names; null when unknown. */
  genres: string[] | null;
};
export type StatsMovieInput = {
  id: string; name: string; posterURL: string | null; status: string | null; rating: number | null;
  /** TMDB runtime (minutes) and genres; null when the movie has no TMDB link or TMDB could not be read. */
  info: { runtime: number | null; genres: string[] } | null;
  /** Logged viewings (MovieWatch). */
  viewings: Date[];
};

type Month = { episodes: number; movieViewings: number; minutes: number };
type TitleRef = { id: string; name: string; posterURL: string | null };

const validRuntime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1000;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};
const effectiveStatus = (show: TrackedShow) => show.status || (show.completed ? 'completed' : null);
const cleanGenres = (genres: string[] | null | undefined) => genres ? [...new Set(genres.filter(g => typeof g === 'string' && g.trim()).map(g => g.trim()))] : null;

/** A validated IANA time zone (the viewer's), or UTC. */
export function resolveTimeZone(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 64) return 'UTC';
  try { return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone; } catch { return 'UTC'; }
}

function yearMonthIn(timeZone: string) {
  const format = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric' });
  return (date: Date) => {
    const parts = format.formatToParts(date);
    return { year: Number(parts.find(p => p.type === 'year')!.value), month: Number(parts.find(p => p.type === 'month')!.value) - 1 };
  };
}

/** One show's effectively watched, released regular episodes (each once) with runtime and record date. */
export function watchedEpisodesOf(input: StatsShowInput, today: string) {
  if (!input.catalog) return [];
  const { episodes } = mergeShowEpisodes(input.show, input.catalog, input.watches, today, input.unwatches);
  const regular = episodes.filter(e => e.season > 0 && e.number > 0);
  const listed = regular.map(e => e.runtime).filter(validRuntime);
  const fallback = listed.length ? median(listed) : null;
  const seen = new Set<string>();
  return regular.filter(e => {
    const key = episodeKey(e.season, e.number);
    if (!e.watched || !isEpisodeReleased(e, today) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(e => ({
    season: e.season, number: e.number,
    listedMinutes: validRuntime(e.runtime) ? e.runtime : null,
    estimatedMinutes: validRuntime(e.runtime) ? null : fallback,
    // Only an individual record carries a real date; a saved position never does.
    watchedAt: (e.watchSource === 'explicit' || e.watchSource === 'both') && e.watchedAt ? e.watchedAt : null,
  }));
}

export function buildCinemaStats(showInputs: StatsShowInput[], movieInputs: StatsMovieInput[], options: { today: string; timeZone: string; now?: Date }) {
  const { today } = options;
  const timeZone = resolveTimeZone(options.timeZone);
  const now = options.now || new Date();
  // Release eligibility uses the exact instant (same rule as Home); a caller that only knows a day gets its start.
  const releaseNow = options.now ? options.now.toISOString() : today;
  const toYearMonth = yearMonthIn(timeZone);

  type YearAcc = { months: Month[]; episodes: number; movieViewings: number; minutes: number; itemsWithoutRuntime: number; bulkLoggedEpisodes: number; distinctMovies: Set<string>; shows: Map<string, TitleRef & { episodes: number; minutes: number }>; genres: Map<string, { titles: Set<string>; minutes: number }> };
  const years = new Map<number, YearAcc>();
  const yearOf = (year: number) => {
    let acc = years.get(year);
    if (!acc) {
      acc = { months: Array.from({ length: 12 }, () => ({ episodes: 0, movieViewings: 0, minutes: 0 })), episodes: 0, movieViewings: 0, minutes: 0, itemsWithoutRuntime: 0, bulkLoggedEpisodes: 0, distinctMovies: new Set(), shows: new Map(), genres: new Map() };
      years.set(year, acc);
    }
    return acc;
  };
  const addYearGenres = (acc: YearAcc, titleKey: string, genres: string[] | null, minutes: number) => {
    for (const name of genres || []) {
      const entry = acc.genres.get(name) || { titles: new Set<string>(), minutes: 0 };
      entry.titles.add(titleKey); entry.minutes += minutes;
      acc.genres.set(name, entry);
    }
  };

  const genres = new Map<string, { titles: number; shows: number; movies: number; minutes: number }>();
  const addGenres = (list: string[] | null, kind: 'shows' | 'movies', minutes: number) => {
    for (const name of list || []) {
      const entry = genres.get(name) || { titles: 0, shows: 0, movies: 0, minutes: 0 };
      entry.titles++; entry[kind]++; entry.minutes += minutes;
      genres.set(name, entry);
    }
  };
  let titlesWithoutGenres = 0;

  // ---- TV -------------------------------------------------------------------------------------------------------
  const tv = {
    shows: showInputs.length, watchedEpisodes: 0, episodesFromRecords: 0, episodesFromSavedPositions: 0, showsStarted: 0,
    statusCounts: { watching: 0, completed: 0, dropped: 0, none: 0 },
    fullyWatched: 0, caughtUp: 0, countedShows: 0,
    /** Shows with recorded progress whose episode counts cannot be verified (left out of every total). */
    showsNotCounted: 0,
    listedMinutes: 0, estimatedMinutes: 0, episodesEstimated: 0, episodesWithoutRuntime: 0,
  };
  for (const input of showInputs) {
    const status = effectiveStatus(input.show);
    if (status === 'watching' || status === 'completed' || status === 'dropped') tv.statusCounts[status]++; else tv.statusCounts.none++;
    const summary = buildTrackingSummary(input.show, input.catalog, input.catalog ? null : 'TMDB metadata unavailable', input.watches, releaseNow, null, input.unwatches);
    const hasActivity = input.show.seasonsWatched > 0 || input.show.episodesWatched > 0 || input.watches.length > 0;
    // Same rule as Home's "Episodes watched": only verified counts are added up.
    const verified = summary.countDataAvailable && summary.progressPercent !== null;
    if (!verified) { if (hasActivity) tv.showsNotCounted++; continue; }
    tv.countedShows++;
    if (summary.viewingState === 'fully_watched') tv.fullyWatched++;
    if (summary.viewingState === 'caught_up') tv.caughtUp++;
    const watched = watchedEpisodesOf(input, releaseNow);
    if (!watched.length) continue;
    tv.showsStarted++;
    tv.watchedEpisodes += watched.length;
    let showMinutes = 0;
    for (const episode of watched) {
      if (episode.watchedAt) tv.episodesFromRecords++; else tv.episodesFromSavedPositions++;
      if (episode.listedMinutes !== null) { tv.listedMinutes += episode.listedMinutes; showMinutes += episode.listedMinutes; }
      else if (episode.estimatedMinutes !== null) { tv.estimatedMinutes += episode.estimatedMinutes; tv.episodesEstimated++; showMinutes += episode.estimatedMinutes; }
      else tv.episodesWithoutRuntime++;
    }
    const showGenres = cleanGenres(input.genres);
    if (showGenres?.length) addGenres(showGenres, 'shows', showMinutes); else titlesWithoutGenres++;

    // Dated records. Episodes recorded in the same instant were logged together (e.g. "mark season watched").
    const sameInstant = new Map<number, number>();
    for (const episode of watched) if (episode.watchedAt) sameInstant.set(episode.watchedAt.getTime(), (sameInstant.get(episode.watchedAt.getTime()) || 0) + 1);
    for (const episode of watched) {
      if (!episode.watchedAt || episode.watchedAt > now) continue;
      const { year, month } = toYearMonth(episode.watchedAt);
      const acc = yearOf(year);
      const minutes = episode.listedMinutes ?? episode.estimatedMinutes ?? 0;
      if (episode.listedMinutes === null && episode.estimatedMinutes === null) acc.itemsWithoutRuntime++;
      if ((sameInstant.get(episode.watchedAt.getTime()) || 0) > 1) acc.bulkLoggedEpisodes++;
      acc.episodes++; acc.minutes += minutes;
      acc.months[month].episodes++; acc.months[month].minutes += minutes;
      const ref = acc.shows.get(input.show.id) || { id: input.show.id, name: input.show.name, posterURL: input.show.posterURL, episodes: 0, minutes: 0 };
      ref.episodes++; ref.minutes += minutes;
      acc.shows.set(input.show.id, ref);
      addYearGenres(acc, `show:${input.show.id}`, showGenres, minutes);
    }
  }

  // ---- Movies ---------------------------------------------------------------------------------------------------
  const movies = { total: movieInputs.length, watched: 0, watchlist: 0, dropped: 0, none: 0, listedMinutes: 0, withoutRuntime: 0, loggedViewings: 0, watchedWithoutViewingDate: 0 };
  for (const movie of movieInputs) {
    const status = movie.status === 'watched' || movie.status === 'watchlist' || movie.status === 'dropped' ? movie.status : 'none';
    movies[status]++;
    const runtime = validRuntime(movie.info?.runtime) ? movie.info!.runtime! : null;
    const movieGenres = cleanGenres(movie.info?.genres);
    if (status === 'watched') {
      if (runtime !== null) movies.listedMinutes += runtime; else movies.withoutRuntime++;
      if (movieGenres?.length) addGenres(movieGenres, 'movies', runtime ?? 0); else titlesWithoutGenres++;
    }
    const viewings = movie.viewings.filter(date => date instanceof Date && !Number.isNaN(date.getTime()) && date <= now);
    movies.loggedViewings += viewings.length;
    if (status === 'watched' && !viewings.length) movies.watchedWithoutViewingDate++;
    for (const date of viewings) {
      const { year, month } = toYearMonth(date);
      const acc = yearOf(year);
      if (runtime === null) acc.itemsWithoutRuntime++;
      acc.movieViewings++; acc.minutes += runtime ?? 0; acc.distinctMovies.add(movie.id);
      acc.months[month].movieViewings++; acc.months[month].minutes += runtime ?? 0;
      addYearGenres(acc, `movie:${movie.id}`, movieGenres, runtime ?? 0);
    }
  }

  // ---- Ratings (personal, movies only) --------------------------------------------------------------------------
  const rated = movieInputs.filter(m => typeof m.rating === 'number' && Number.isInteger(m.rating) && m.rating >= 1 && m.rating <= 10);
  const distribution = Array.from({ length: 10 }, (_, i) => rated.filter(m => m.rating === i + 1).length);
  const average = rated.length ? Math.round(rated.reduce((n, m) => n + m.rating!, 0) / rated.length * 10) / 10 : null;
  const topMovies = [...rated].sort((a, b) => b.rating! - a.rating! || a.name.localeCompare(b.name)).slice(0, 5)
    .map(m => ({ id: m.id, name: m.name, posterURL: m.posterURL, rating: m.rating!, status: m.status }));

  const byMinutes = <T extends { minutes: number; titles: number; name: string }>(a: T, b: T) => b.minutes - a.minutes || b.titles - a.titles || a.name.localeCompare(b.name);
  const tvMinutes = tv.listedMinutes + tv.estimatedMinutes;
  return {
    generatedAt: now.toISOString(), today, timeZone,
    watchTime: {
      totalMinutes: tvMinutes + movies.listedMinutes,
      tv: { minutes: tvMinutes, listedMinutes: tv.listedMinutes, estimatedMinutes: tv.estimatedMinutes, episodesEstimated: tv.episodesEstimated, episodesWithoutRuntime: tv.episodesWithoutRuntime },
      movies: { minutes: movies.listedMinutes, moviesWithoutRuntime: movies.withoutRuntime },
    },
    tv: {
      shows: tv.shows, watchedEpisodes: tv.watchedEpisodes, episodesFromRecords: tv.episodesFromRecords, episodesFromSavedPositions: tv.episodesFromSavedPositions,
      showsStarted: tv.showsStarted, countedShows: tv.countedShows, showsNotCounted: tv.showsNotCounted,
      statusCounts: tv.statusCounts, completed: tv.statusCounts.completed, fullyWatched: tv.fullyWatched, caughtUp: tv.caughtUp,
    },
    movies: { total: movies.total, watched: movies.watched, watchlist: movies.watchlist, dropped: movies.dropped, none: movies.none, loggedViewings: movies.loggedViewings },
    genres: {
      items: [...genres.entries()].map(([name, g]) => ({ name, ...g })).sort(byMinutes).slice(0, 12),
      titlesWithoutGenres,
    },
    ratings: {
      movies: { count: rated.length, average, distribution, top: topMovies },
      /** Cinetra stores no personal ratings for TV shows. */
      shows: { available: false as const },
    },
    years: {
      items: [...years.entries()].sort((a, b) => b[0] - a[0]).map(([year, acc]) => ({
        year, episodes: acc.episodes, movieViewings: acc.movieViewings, distinctMovies: acc.distinctMovies.size, minutes: acc.minutes,
        itemsWithoutRuntime: acc.itemsWithoutRuntime, bulkLoggedEpisodes: acc.bulkLoggedEpisodes, months: acc.months,
        topShows: [...acc.shows.values()].sort((a, b) => b.episodes - a.episodes || b.minutes - a.minutes || a.name.localeCompare(b.name)).slice(0, 5),
        topGenres: [...acc.genres.entries()].map(([name, g]) => ({ name, titles: g.titles.size, minutes: g.minutes })).sort(byMinutes).slice(0, 5),
      })),
      undated: { savedPositionEpisodes: tv.episodesFromSavedPositions, watchedMoviesWithoutViewingDate: movies.watchedWithoutViewingDate },
    },
  };
}

export type CinemaStats = ReturnType<typeof buildCinemaStats>;
