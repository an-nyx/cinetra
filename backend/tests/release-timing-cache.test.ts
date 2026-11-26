/**
 * Catalog loads never wait long on TVMaze release timing: a slow TVMaze (cold caches after a restart, rate limit)
 * yields the conservative TMDB date fallback within the deadline, and the catalog is re-timed in the background
 * once TVMaze answers. No network: TMDB is stubbed and TVMaze is served through axios' adapter.
 */
import assert from 'node:assert/strict';
import axios, { type InternalAxiosRequestConfig } from 'axios';

// Deterministic clock: the fixture premieres on AIR, two days after this test's "now". Without pinning, the premiere
// eventually falls outside TVMaze's 3-day past-episode window (which keeps only number and date) and the exact time is
// legitimately dropped. Time still advances in real time from this instant, so waits and cache freshness behave
// normally. Installed before any service module is imported.
const RealDate = Date;
const CLOCK_OFFSET = RealDate.parse('2026-11-20T12:00:00.000Z') - RealDate.now();
class PinnedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + CLOCK_OFFSET);
    else super(...(args as [string | number]));
  }
  static now() { return RealDate.now() + CLOCK_OFFSET; }
}
globalThis.Date = PinnedDate as DateConstructor;

const AIR = '2026-11-22';
let tvmazeDelay = 2500;
let tvmazeCalls = 0;
axios.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
  const url = new URL(config.url!, config.baseURL);
  if (url.hostname !== 'api.tvmaze.com') throw new Error(`Unexpected network request to ${url.hostname}`);
  tvmazeCalls++;
  await new Promise(r => setTimeout(r, tvmazeDelay));
  const response = (status: number, data: unknown, headers: Record<string, string> = {}) => ({ data, status, statusText: String(status), headers, config });
  if (url.pathname === '/lookup/shows') return response(302, '', { location: 'https://api.tvmaze.com/shows/77' });
  if (url.pathname === '/shows/77') return response(200, {
    id: 77, name: 'Slow Series', status: 'Running', updated: 1, externals: { thetvdb: 7007, imdb: null },
    network: { name: 'HBO', country: { timezone: 'America/New_York' } }, webChannel: null,
    _embedded: { episodes: [{ id: 1, season: 1, number: 1, type: 'regular', name: 'Pilot', airdate: AIR, airtime: '21:00', airstamp: '2026-11-23T02:00:00+00:00', runtime: 60 }] },
  });
  return response(404, null);
};

async function main() {
  const { TMDBApiService } = await import('../src/services/tmdb/tmdb-api.service');
  const stub = TMDBApiService.prototype as unknown as Record<string, unknown>;
  stub.getShow = async () => ({ name: 'Slow Series', original_name: 'Slow Series', overview: '', first_air_date: AIR, status: 'Returning Series', in_production: true, next_episode_to_air: null, seasons: [{ season_number: 1, episode_count: 1, air_date: AIR }] });
  stub.getSeason = async () => ({ episodes: [{ episode_number: 1, name: 'Pilot', air_date: AIR, runtime: 60 }] });
  stub.getExternalIds = async () => ({ tvdbId: 7007, imdbId: null });
  const { catalogFor } = await import('../src/services/episode-guide.service');
  const show = { name: 'Slow Series', tmdbId: 9_999_001, overview: null };

  const started = Date.now();
  const cold = await catalogFor(show);
  const waited = Date.now() - started;
  assert.ok(waited < 2200, `cold catalog answered in ${waited} ms (deadline 1500 ms)`);
  assert.deepEqual([cold.releaseTiming?.source, cold.releaseTiming?.reason], ['tmdb_only', 'TVMaze timing pending']);
  assert.deepEqual([cold.episodes[0].releaseAt, cold.episodes[0].releaseSource], ['2026-11-23T12:00:00.000Z', 'tmdb_date'], 'fallback is later than the real premiere, never earlier');

  // TVMaze answers later (lookup, then the schedule): the cached catalog is marked stale; the next read refreshes it.
  await new Promise(r => setTimeout(r, 2 * tvmazeDelay + 500));
  tvmazeDelay = 0;
  const stale = await catalogFor(show);
  assert.equal(stale.releaseTiming?.reason, 'TVMaze timing pending', 'the stale copy is served at once');
  await new Promise(r => setTimeout(r, 300));
  const warm = await catalogFor(show);
  assert.deepEqual([warm.releaseTiming?.source, warm.episodes[0].releaseAt, warm.episodes[0].releaseSource], ['tvmaze', '2026-11-23T02:00:00.000Z', 'tvmaze_exact']);
  assert.equal(tvmazeCalls, 2, 'one TheTVDB lookup and one schedule request in total');

  // Fresh loads (background status reconciliation only) wait for TVMaze instead of falling back: status decisions use
  // the exact premiere. A different series with a cold TVMaze cache and the same slow TVMaze.
  tvmazeDelay = 2000;
  stub.getExternalIds = async () => ({ tvdbId: 7007, imdbId: null });
  const { resetTvmazeCachesForTests } = await import('../src/services/tvmaze/tvmaze.service');
  resetTvmazeCachesForTests();
  const freshStarted = Date.now();
  const fresh = await catalogFor({ name: 'Slow Series', tmdbId: 9_999_002, overview: null }, true);
  assert.ok(Date.now() - freshStarted >= 3500, 'fresh load waited for TVMaze');
  assert.deepEqual([fresh.releaseTiming?.source, fresh.episodes[0].releaseSource], ['tvmaze', 'tvmaze_exact']);
  console.log('release timing cache tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
