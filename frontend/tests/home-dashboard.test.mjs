import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canContinueWatching, homeDashboard } from '../src/lib/tracking.ts';

const summary = (showId, over = {}) => ({
  showId, name: showId, posterURL: null, status: 'watching', source: 'TMDB', guideAvailable: true, countDataAvailable: true, legacyPosition: null,
  watchedCount: 5, explicitWatchedCount: 0, legacyInferredCount: 5, releasedCount: 10, remainingCount: 5, progressPercent: 50,
  viewingState: 'in_progress', nextEpisode: { season: 1, number: 6, name: 'Six', airDate: '2026-01-01', runtime: 50, watchedAt: null },
  lastEpisode: null, upcomingEpisode: null, newEpisodes: 0, recentHistory: [], error: null, ...over,
});
const watched = iso => [{ season: 1, episode: 5, watchedAt: iso }];

test('featured show comes from real activity and is never Dropped, Planned or Paused', () => {
  const dash = homeDashboard([
    summary('older', { recentHistory: watched('2026-10-01T20:00:00.000Z') }),
    summary('dropped', { status: 'dropped', recentHistory: watched('2026-11-08T20:00:00.000Z') }),
    summary('paused', { status: 'paused', recentHistory: watched('2026-11-08T20:00:00.000Z') }),
    summary('planned', { status: 'planned' }),
    summary('latest', { recentHistory: watched('2026-11-07T20:00:00.000Z') }),
    summary('legacy-only', { legacyPosition: { fullSeasons: 1, episodesInNextSeason: 5 } }),
  ]);
  assert.equal(dash.featured.showId, 'latest');
  assert.deepEqual(dash.continueWatching.map(s => s.showId), ['older', 'legacy-only']);
  assert.ok(![dash.featured, ...dash.continueWatching].some(s => ['dropped', 'paused', 'planned'].includes(s.status)));
  assert.deepEqual(homeDashboard([summary('d', { status: 'dropped' })]).featured, null, 'a library of Dropped shows has no featured show');
});

test('Continue watching is capped and excludes shows without a released next episode', () => {
  const many = Array.from({ length: 10 }, (_, i) => summary(`s${i}`));
  const dash = homeDashboard([...many, summary('caught-up', { viewingState: 'caught_up', nextEpisode: null, remainingCount: 0 })]);
  assert.equal(dash.continueWatching.length, 6);
  assert.equal(dash.moreToContinue, 3);
  assert.ok(!dash.continueWatching.some(s => s.showId === 'caught-up'));
  assert.equal(canContinueWatching(summary('x', { nextEpisode: null })), false);
});

test('New episodes: released unwatched episodes only, Dropped excluded, featured not repeated', () => {
  const dash = homeDashboard([
    summary('featured', { newEpisodes: 2, recentHistory: watched('2026-11-08T20:00:00.000Z') }),
    summary('fresh', { newEpisodes: 3 }),
    summary('season', { status: 'completed', newEpisodes: 0, newSeasonToWatch: { season: 2, count: 8, episodes: [] } }),
    summary('dropped', { status: 'dropped', newEpisodes: 4 }),
    summary('nothing-new', { newEpisodes: 0 }),
    summary('unverified', { newEpisodes: 2, countDataAvailable: false }),
    summary('only-future', { newEpisodes: 0, remainingCount: 0 }), // future episodes are not "available"
  ]);
  assert.deepEqual(dash.newEpisodes.map(s => s.showId), ['season', 'fresh']);
});

test('Recently watched uses recorded watch times only, newest first; saved positions add no activity', () => {
  const dash = homeDashboard([
    summary('a', { recentHistory: [{ season: 1, episode: 2, watchedAt: '2026-11-01T10:00:00.000Z' }, { season: 1, episode: 1, watchedAt: '2026-10-01T10:00:00.000Z' }] }),
    summary('b', { recentHistory: [{ season: 3, episode: 4, watchedAt: '2026-11-05T10:00:00.000Z' }, { season: 3, episode: 3, watchedAt: 'not a date' }] }),
    summary('legacy', { legacyPosition: { fullSeasons: 2, episodesInNextSeason: 0 }, recentHistory: [] }),
  ]);
  assert.deepEqual(dash.recent.map(r => `${r.item.showId}:${r.event.season}x${r.event.episode}`), ['b:3x4', 'a:1x2', 'a:1x1']);
  assert.deepEqual(homeDashboard([summary('legacy', { legacyPosition: { fullSeasons: 2, episodesInNextSeason: 0 } })]).recent, []);
});

test('statistics reuse the verified counts and never change statuses', () => {
  const input = [summary('w1'), summary('w2', { watchedCount: 7 }), summary('c', { status: 'completed' }), summary('unverified', { countDataAvailable: false, progressPercent: null, watchedCount: 99 }), { showId: 'broken', error: 'TMDB unavailable' }];
  const before = JSON.stringify(input);
  const dash = homeDashboard(input);
  assert.equal(dash.watching, 3);
  assert.equal(dash.episodesWatched, 17);
  assert.equal(dash.verifiedShows, 3);
  assert.equal(dash.unavailable, 1);
  assert.equal(JSON.stringify(input), before, 'selection is read-only');
  assert.equal(homeDashboard([]).episodesWatched, null);
  assert.deepEqual(homeDashboard([]).watchlist, []);
});
