/** My Cinema Stats: pure aggregation rules (no database, no providers). */
import assert from 'node:assert/strict';
import { buildCinemaStats, resolveTimeZone, watchedEpisodesOf, type StatsMovieInput, type StatsShowInput } from '../src/services/cinema-stats.model';
import { buildTrackingSummary, type Catalog, type TrackedShow } from '../src/services/tracking-summary.model';

const today = '2026-11-19';
const now = new Date('2026-11-19T12:00:00Z');
type Ep = [season: number, number: number, airDate: string | null, runtime?: number | null];
function catalog(episodes: Ep[], status = 'Returning Series'): Catalog {
  const seasons = new Map<number, number>();
  for (const [s, n] of episodes) if (s > 0 && n > 0) seasons.set(s, (seasons.get(s) || 0) + 1);
  return {
    source: 'TMDB', broadcastStatus: status, inProduction: status !== 'Ended', nextEpisodeAnnounced: false,
    seasons: [...seasons.entries()].map(([number, episodeCount]) => ({ number, episodeCount })),
    episodes: episodes.map(([season, number, airDate, runtime = 30]) => ({ season, number, airDate, name: '', airTimestamp: null, runtime })),
  };
}
const tracked = (id: string, extra: Partial<TrackedShow> = {}): TrackedShow => ({ id, name: id, posterURL: null, status: 'watching', completed: false, seasonsWatched: 0, episodesWatched: 0, ...extra });
const at = (iso: string) => new Date(iso);
const show = (id: string, c: Catalog | null, extra: Partial<Omit<StatsShowInput, 'show'>> & { show?: Partial<TrackedShow> } = {}): StatsShowInput =>
  ({ show: tracked(id, extra.show), catalog: c, watches: extra.watches || [], unwatches: extra.unwatches || [], genres: extra.genres === undefined ? ['Drama'] : extra.genres });
const movie = (id: string, extra: Partial<StatsMovieInput> = {}): StatsMovieInput => ({ id, name: id, posterURL: null, status: 'watched', rating: null, info: { runtime: 100, genres: ['Drama'] }, viewings: [], ...extra });
const stats = (shows: StatsShowInput[], movies: StatsMovieInput[] = [], timeZone = 'UTC') => buildCinemaStats(shows, movies, { today, timeZone, now });

// Season 1: four aired episodes, season 2: two aired + one future + one undated.
const base = catalog([[1, 1, '2025-01-01'], [1, 2, '2025-01-08'], [1, 3, '2025-01-15'], [1, 4, '2025-01-22'], [2, 1, '2026-10-01'], [2, 2, '2026-10-08'], [2, 3, '2026-12-01'], [2, 4, null]]);
const summaryCount = (input: StatsShowInput) => buildTrackingSummary(input.show, input.catalog, null, input.watches, today, null, input.unwatches).watchedCount;

// ---- Accurate watched-episode counts -------------------------------------------------------------------------------
{
  const input = show('explicit', base, { watches: [{ season: 1, episode: 1, watchedAt: at('2026-03-01T20:00:00Z') }, { season: 1, episode: 2, watchedAt: at('2026-03-02T20:00:00Z') }] });
  const s = stats([input]);
  assert.equal(s.tv.watchedEpisodes, 2);
  assert.equal(s.tv.watchedEpisodes, summaryCount(input), 'matches the tracking summary every page shows');
  assert.equal(s.tv.episodesFromRecords, 2);
}

// ---- Legacy checkpoints and unwatch exceptions ---------------------------------------------------------------------
{
  // Saved position S1E3 covers S1E1-3. S1E2 has an unwatch exception; S1E3 also has an explicit record (counted once).
  const input = show('legacy', base, { show: { seasonsWatched: 1, episodesWatched: 3 }, unwatches: [{ season: 1, episode: 2 }], watches: [{ season: 1, episode: 3, watchedAt: at('2026-05-01T20:00:00Z') }, { season: 2, episode: 1, watchedAt: at('2026-10-02T20:00:00Z') }] });
  const watched = watchedEpisodesOf(input, today).map(e => `S${e.season}E${e.number}`);
  assert.deepEqual(watched, ['S1E1', 'S1E3', 'S2E1'], 'unwatch exception removes S1E2; S1E3 counted once');
  const s = stats([input]);
  assert.equal(s.tv.watchedEpisodes, 3);
  assert.equal(s.tv.watchedEpisodes, summaryCount(input));
  assert.equal(s.tv.episodesFromSavedPositions, 1, 'S1E1 comes only from the saved position');
  assert.equal(s.tv.episodesFromRecords, 2);
  assert.equal(s.years.undated.savedPositionEpisodes, 1);
  assert.equal(s.years.items.reduce((n, y) => n + y.episodes, 0), 2, 'a saved position never produces a viewing date');
}

// ---- Never count unreleased episodes; no double counting -----------------------------------------------------------
{
  // Legacy position S2E4 would cover the future S2E3 and undated S2E4; explicit records on those must not count either.
  const input = show('future', base, { show: { seasonsWatched: 2, episodesWatched: 4 }, watches: [{ season: 2, episode: 3, watchedAt: at('2026-11-01T00:00:00Z') }, { season: 1, episode: 1, watchedAt: at('2026-01-01T00:00:00Z') }] });
  const watched = watchedEpisodesOf(input, today);
  assert.ok(watched.every(e => !['2:3', '2:4'].includes(`${e.season}:${e.number}`)), 'future and undated episodes are never watched');
  assert.equal(new Set(watched.map(e => `${e.season}:${e.number}`)).size, watched.length, 'each episode once');
  // Duplicate catalog rows for one episode still count once.
  const dup = catalog([[1, 1, '2025-01-01'], [1, 2, '2025-01-08']]);
  dup.episodes.push({ ...dup.episodes[0] });
  assert.equal(watchedEpisodesOf(show('dup', dup, { watches: [{ season: 1, episode: 1, watchedAt: at('2026-01-01T00:00:00Z') }] }), today).length, 1);
  // Specials (season 0) never count.
  const specials = catalog([[0, 1, '2025-01-01'], [1, 1, '2025-01-01']]);
  assert.equal(watchedEpisodesOf(show('sp', specials, { watches: [{ season: 0, episode: 1, watchedAt: at('2026-01-01T00:00:00Z') }] }), today).length, 0);
}

// ---- Movie and show completion totals ------------------------------------------------------------------------------
{
  const ended = catalog([[1, 1, '2024-01-01'], [1, 2, '2024-01-08']], 'Ended');
  const s = stats([
    show('done', ended, { show: { status: 'completed', completed: true, seasonsWatched: 1, episodesWatched: 2 } }),
    show('legacy-completed', null, { show: { status: null, completed: true } }),
    show('dropped', base, { show: { status: 'dropped' } }),
    show('none', base, { show: { status: null } }),
    show('w', base),
  ], [movie('a'), movie('b', { status: 'watchlist' }), movie('c', { status: 'dropped' }), movie('d', { status: null }), movie('e', { status: 'legacy-unknown' })]);
  assert.deepEqual(s.tv.statusCounts, { watching: 1, completed: 2, dropped: 1, none: 1 }, 'legacy completed flag counts as Completed');
  assert.equal(s.tv.completed, 2);
  assert.equal(s.tv.fullyWatched, 1, 'verified by episode data');
  assert.deepEqual([s.movies.watched, s.movies.watchlist, s.movies.dropped, s.movies.none], [1, 1, 1, 2]);
}

// ---- Runtime estimates and missing metadata ------------------------------------------------------------------------
{
  const mixed = catalog([[1, 1, '2025-01-01', 40], [1, 2, '2025-01-08', null], [1, 3, '2025-01-15', 50], [1, 4, '2025-01-22', 60]]);
  const noRuntimes = catalog([[1, 1, '2025-01-01', null], [1, 2, '2025-01-08', null]]);
  const s = stats([
    show('mixed', mixed, { show: { seasonsWatched: 1, episodesWatched: 2 } }),
    show('none', noRuntimes, { show: { seasonsWatched: 1, episodesWatched: 1 } }),
    show('no-catalog', null, { show: { seasonsWatched: 3, episodesWatched: 2 } }),
  ], [movie('runtime', { info: { runtime: 120, genres: [] } }), movie('no-runtime', { info: { runtime: null, genres: [] } }), movie('no-tmdb', { info: null })]);
  assert.equal(s.watchTime.tv.listedMinutes, 40);
  assert.equal(s.watchTime.tv.estimatedMinutes, 50, 'S1E2 borrows the median listed runtime (40, 50, 60 → 50)');
  assert.equal(s.watchTime.tv.episodesEstimated, 1);
  assert.equal(s.watchTime.tv.episodesWithoutRuntime, 1, 'no runtime basis: counted as an episode, not as time');
  assert.equal(s.tv.watchedEpisodes, 3);
  assert.equal(s.tv.showsNotCounted, 1, 'a show without episode data is reported, not guessed');
  assert.equal(s.watchTime.movies.minutes, 120);
  assert.equal(s.watchTime.movies.moviesWithoutRuntime, 2);
  assert.equal(s.watchTime.totalMinutes, 40 + 50 + 120);
  // Unverified counts (saved-position conflict) are left out like Home's "Episodes watched".
  const conflict = stats([show('conflict', base, { show: { seasonsWatched: 1, episodesWatched: 9 } })]);
  assert.equal(conflict.tv.watchedEpisodes, 0);
  assert.equal(conflict.tv.showsNotCounted, 1);
}

// ---- Genres and personal ratings -----------------------------------------------------------------------------------
{
  const c = catalog([[1, 1, '2025-01-01', 60], [1, 2, '2025-01-08', 60]]);
  const s = stats([
    show('crime', c, { show: { seasonsWatched: 1, episodesWatched: 2 }, genres: ['Crime', 'Drama', 'Crime'] }),
    show('unwatched', c, { genres: ['Comedy'] }),
    show('no-genres', c, { show: { seasonsWatched: 1, episodesWatched: 1 }, genres: null }),
  ], [
    movie('m1', { rating: 10, info: { runtime: 90, genres: ['Drama'] } }), movie('m2', { rating: 7, info: { runtime: 100, genres: ['Comedy'] } }),
    movie('m3', { rating: 10, status: 'watchlist' }), movie('m4', { rating: 0 }), movie('m5', { rating: 4, name: 'Alpha' }), movie('m6'),
  ]);
  const genre = (name: string) => s.genres.items.find(g => g.name === name);
  // Watched Drama: the show (120 min), m1 (90) and m4/m5/m6 (fixture default, 100 each). m3 is on the watchlist.
  assert.deepEqual(genre('Drama'), { name: 'Drama', titles: 5, shows: 1, movies: 4, minutes: 120 + 90 + 300 }, 'watched titles only; a duplicate genre counts once');
  assert.deepEqual(genre('Crime'), { name: 'Crime', titles: 1, shows: 1, movies: 0, minutes: 120 });
  assert.equal(genre('Comedy')?.titles, 1, 'an unwatched show contributes no genre; the watched comedy movie does');
  assert.equal(s.genres.items[0].name, 'Drama');
  assert.equal(s.genres.titlesWithoutGenres, 1);
  assert.equal(s.ratings.movies.count, 4, 'rating 0 is not a rating; unwatched ratings still count');
  assert.equal(s.ratings.movies.average, Math.round((10 + 7 + 10 + 4) / 4 * 10) / 10);
  assert.deepEqual(s.ratings.movies.distribution, [0, 0, 0, 1, 0, 0, 1, 0, 0, 2]);
  assert.deepEqual(s.ratings.movies.top.map(m => [m.name, m.rating]), [['m1', 10], ['m3', 10], ['m2', 7], ['Alpha', 4]]);
  assert.equal(s.ratings.shows.available, false, 'TV shows have no personal rating in Cinetra');
  assert.ok(!JSON.stringify(s.ratings).includes('vote'), 'TMDB community ratings never appear');
}

// ---- Yearly statistics: only real timestamps -----------------------------------------------------------------------
{
  const c = catalog([[1, 1, '2024-01-01', 30], [1, 2, '2024-01-08', 30], [1, 3, '2024-01-15', 30], [1, 4, '2024-01-22', 30]]);
  const bulk = at('2026-02-10T09:00:00Z');
  const s = stats([show('dated', c, { watches: [
    { season: 1, episode: 1, watchedAt: at('2025-12-31T23:30:00Z') },   // 2026-01-01 in Paris
    { season: 1, episode: 2, watchedAt: bulk }, { season: 1, episode: 3, watchedAt: bulk },
    { season: 1, episode: 4, watchedAt: at('2027-01-01T00:00:00Z') },   // in the future: never trusted
  ] })], [
    movie('logged', { viewings: [at('2026-03-05T20:00:00Z'), at('2026-07-05T20:00:00Z')], info: { runtime: 100, genres: ['Drama'] } }),
    movie('status-only', { viewings: [] }),
    movie('watchlist-viewing', { status: 'watchlist', viewings: [at('2025-06-01T20:00:00Z')], info: null }),
  ], 'Europe/Paris');
  assert.equal(s.timeZone, 'Europe/Paris');
  const y2026 = s.years.items.find(y => y.year === 2026)!;
  const y2025 = s.years.items.find(y => y.year === 2025)!;
  assert.deepEqual(s.years.items.map(y => y.year), [2026, 2025], 'newest first; no year from release dates or future timestamps');
  assert.equal(y2026.episodes, 3, 'the New Year’s Eve UTC record falls in 2026 in Paris');
  assert.equal(y2026.months[0].episodes, 1);
  assert.equal(y2026.months[1].episodes, 2);
  assert.equal(y2026.bulkLoggedEpisodes, 2, 'records logged in the same instant are flagged');
  assert.deepEqual([y2026.movieViewings, y2026.distinctMovies], [2, 1]);
  assert.equal(y2026.minutes, 3 * 30 + 2 * 100);
  assert.deepEqual(y2026.topShows.map(t => [t.name, t.episodes]), [['dated', 3]]);
  assert.equal(y2025.movieViewings, 1);
  assert.equal(y2025.itemsWithoutRuntime, 1, 'a viewing without runtime is flagged, not given a duration');
  assert.equal(s.years.undated.watchedMoviesWithoutViewingDate, 1, 'Watched status alone has no date');
  const utc = stats([show('dated', c, { watches: [{ season: 1, episode: 1, watchedAt: at('2025-12-31T23:30:00Z') }] })]);
  assert.deepEqual(utc.years.items.map(y => y.year), [2025]);
  assert.equal(resolveTimeZone('Not/AZone'), 'UTC');
  assert.equal(resolveTimeZone(undefined), 'UTC');
  assert.equal(resolveTimeZone(['Europe/Paris']), 'UTC');
}

// ---- Empty library and partial data --------------------------------------------------------------------------------
{
  const s = stats([], []);
  assert.equal(s.watchTime.totalMinutes, 0);
  assert.equal(s.tv.watchedEpisodes, 0);
  assert.deepEqual(s.genres.items, []);
  assert.equal(s.ratings.movies.average, null);
  assert.deepEqual(s.ratings.movies.top, []);
  assert.deepEqual(s.years.items, []);
  const partial = stats([show('no-tmdb', null, { show: { seasonsWatched: 0, episodesWatched: 0 } })], [movie('m', { info: null, status: 'watched' })]);
  assert.equal(partial.tv.showsNotCounted, 0, 'a show with no progress is not "missing" anything');
  assert.equal(partial.movies.watched, 1);
  assert.equal(partial.watchTime.totalMinutes, 0);
  assert.equal(partial.genres.titlesWithoutGenres, 1);
}

// ---- Inputs are never mutated (read-only) ---------------------------------------------------------------------------
{
  const input = show('ro', base, { show: { seasonsWatched: 1, episodesWatched: 3 }, unwatches: [{ season: 1, episode: 2 }], watches: [{ season: 2, episode: 1, watchedAt: at('2026-10-02T20:00:00Z') }] });
  const m = movie('ro', { rating: 8, viewings: [at('2026-01-01T00:00:00Z')] });
  const before = JSON.stringify([input, m]);
  stats([input], [m]);
  assert.equal(JSON.stringify([input, m]), before);
}

console.log('Cinema stats tests passed');
