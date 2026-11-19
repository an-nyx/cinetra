/**
 * My Cinema Stats data loading. Strictly read-only: five `findMany` queries scoped to the signed-in user, the shared
 * (already warmed) TMDB episode catalogs, and long-lived caches of TMDB genres and movie runtimes. Never writes.
 */
import { prisma } from '../database/prisma';
import { catalogFor } from './episode-guide.service';
import { TMDBApiService } from './tmdb/tmdb-api.service';
import { movieInfo } from './movie-info.model';
import { mapLimit, SWRCache } from './swr-cache';
import { buildCinemaStats, resolveTimeZone, type StatsMovieInput, type StatsShowInput } from './cinema-stats.model';

const tmdb = new TMDBApiService();
const DAY = 86_400_000;
// Genres and runtimes rarely change: fresh for a week, served stale for a month while one refresh runs.
const showGenres = new SWRCache<string[]>({ freshMs: 7 * DAY, staleMs: 30 * DAY, retryMs: 10 * 60_000, maxEntries: 10_000 });
const movieDetails = new SWRCache<{ runtime: number | null; genres: string[] }>({ freshMs: 7 * DAY, staleMs: 30 * DAY, retryMs: 10 * 60_000, maxEntries: 10_000 });
/** A cold metadata cache never holds the page longer than this; unfinished lookups keep filling the cache. */
const METADATA_WAIT_MS = 8_000;

const genresOf = (tmdbId: number) => showGenres.get(`tv:${tmdbId}`, async () => {
  const details = await tmdb.getShow(tmdbId) as { genres?: { name?: unknown }[] };
  return (details.genres || []).map(g => g?.name).filter((name): name is string => typeof name === 'string' && !!name.trim());
});
const movieMetaOf = (tmdbId: number) => movieDetails.get(`movie:${tmdbId}`, async () => {
  const info = await tmdb.getMovieInfo(tmdbId);
  if (info.id !== tmdbId) throw new Error('TMDB returned a different movie');
  const { runtime, genres } = movieInfo(info);
  return { runtime, genres };
});

function withDeadline<T>(work: Promise<T>, deadline: Promise<void>): Promise<{ value: T | null; late: boolean }> {
  return Promise.race([
    work.then(value => ({ value, late: false }), () => ({ value: null, late: false })),
    deadline.then(() => ({ value: null, late: true })),
  ]);
}

export async function getCinemaStats(userId: string, timeZoneInput: unknown) {
  const timeZone = resolveTimeZone(timeZoneInput);
  const [shows, watches, unwatches, movies, movieWatches] = await Promise.all([
    prisma.show.findMany({ where: { userId }, select: { id: true, name: true, posterURL: true, status: true, completed: true, seasonsWatched: true, episodesWatched: true, completedMonitorFrom: true, tmdbId: true } }),
    prisma.episodeWatch.findMany({ where: { show: { userId } }, select: { showId: true, season: true, episode: true, watchedAt: true } }),
    prisma.episodeUnwatch.findMany({ where: { show: { userId } }, select: { showId: true, season: true, episode: true } }),
    prisma.movie.findMany({ where: { userId }, select: { id: true, name: true, posterURL: true, status: true, rating: true, tmdbId: true } }),
    prisma.movieWatch.findMany({ where: { movie: { userId } }, select: { movieId: true, watchedAt: true } }),
  ]);

  const group = <T extends Record<K, string>, K extends string>(rows: T[], key: K) => {
    const map = new Map<string, T[]>();
    for (const row of rows) map.set(row[key], [...(map.get(row[key]) || []), row]);
    return map;
  };
  const watchesByShow = group(watches, 'showId');
  const unwatchesByShow = group(unwatches, 'showId');
  const viewingsByMovie = group(movieWatches, 'movieId');

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, METADATA_WAIT_MS); });
  let pendingMetadata = 0;
  try {
    // Episode catalogs are the same cached catalogs Shows and Home read (warmed hourly in production).
    const catalogs = await mapLimit(shows, 12, async show => {
      if (!show.tmdbId) return null;
      const result = await withDeadline(catalogFor(show), deadline);
      if (result.late) pendingMetadata++;
      return result.value;
    });
    const showInputs: StatsShowInput[] = await mapLimit(shows.map((show, index) => ({ show, catalog: catalogs[index] })), 8, async ({ show, catalog }) => {
      const showWatches = (watchesByShow.get(show.id) || []).map(({ season, episode, watchedAt }) => ({ season, episode, watchedAt }));
      const hasActivity = show.seasonsWatched > 0 || show.episodesWatched > 0 || showWatches.length > 0;
      let genres: string[] | null = null;
      // Genres are looked up only for shows that can contribute watched episodes.
      if (catalog && hasActivity && show.tmdbId) {
        const result = await withDeadline(genresOf(show.tmdbId), deadline);
        if (result.late) pendingMetadata++;
        genres = result.value;
      }
      return { show, catalog, watches: showWatches, unwatches: (unwatchesByShow.get(show.id) || []).map(({ season, episode }) => ({ season, episode })), genres };
    });
    const movieInputs: StatsMovieInput[] = await mapLimit(movies, 8, async movie => {
      const viewings = (viewingsByMovie.get(movie.id) || []).map(v => v.watchedAt);
      let info: StatsMovieInput['info'] = null;
      // Runtime and genres matter only for watched movies and logged viewings.
      if (movie.tmdbId && (movie.status === 'watched' || viewings.length)) {
        const result = await withDeadline(movieMetaOf(movie.tmdbId), deadline);
        if (result.late) pendingMetadata++;
        info = result.value;
      }
      return { id: movie.id, name: movie.name, posterURL: movie.posterURL, status: movie.status, rating: movie.rating, info, viewings };
    });
    const stats = buildCinemaStats(showInputs, movieInputs, { today: new Date().toISOString().slice(0, 10), timeZone });
    return { ...stats, metadataPending: pendingMetadata };
  } finally {
    clearTimeout(timer);
  }
}
