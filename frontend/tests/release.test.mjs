import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instantOf, isEpisodeReleased, tmdbReleaseAt } from '../src/lib/release.ts';
import { optimisticSummary } from '../src/lib/tracking-sync.ts';

// Same instants as backend/tests/release-rule.test.ts: the page and the server must flip at the same moment.
const gildedE4 = { airDate: '2026-11-22', releaseAt: '2026-11-23T02:00:00.000Z' };
const ropE7 = { airDate: '2026-11-25', releaseAt: '2026-11-26T12:00:00.000Z' };
const nocturneE6 = { airDate: '2026-11-26', releaseAt: '2026-11-27T12:00:00.000Z' };

test('release instants from the server decide, to the millisecond', () => {
  assert.equal(isEpisodeReleased(gildedE4, '2026-11-22T00:00:00Z'), false, 'not at 00:00 UTC on the TMDB date');
  assert.equal(isEpisodeReleased(gildedE4, '2026-11-23T01:59:59.999Z'), false);
  assert.equal(isEpisodeReleased(gildedE4, '2026-11-23T02:00:00.000Z'), true);
  assert.equal(isEpisodeReleased(ropE7, '2026-11-25T12:00:00Z'), false);
  assert.equal(isEpisodeReleased(ropE7, new Date('2026-11-26T12:00:00Z')), true);
  assert.equal(isEpisodeReleased(nocturneE6, '2026-11-26T12:00:00Z'), false);
  assert.equal(isEpisodeReleased({ airDate: '2026-08-02', releaseAt: '2026-08-03T01:00:00.000Z' }, '2026-11-21T14:19:40Z'), true, 'House of the Dragon S03E07');
});

test('fallback without releaseAt matches the server; undated is never released', () => {
  assert.equal(tmdbReleaseAt('2026-11-22'), '2026-11-23T12:00:00.000Z');
  assert.equal(isEpisodeReleased({ airDate: '2026-11-22' }, '2026-11-23T11:59:59.999Z'), false);
  assert.equal(isEpisodeReleased({ airDate: '2026-11-22' }, '2026-11-23T12:00:00.000Z'), true);
  assert.equal(isEpisodeReleased({ airDate: null }, '2030-01-01T00:00:00Z'), false);
  assert.equal(isEpisodeReleased({ airDate: null, releaseAt: '2020-01-01T00:00:00.000Z' }, '2030-01-01T00:00:00Z'), false);
  assert.equal(isEpisodeReleased({ airDate: '2026-11-22', releaseAt: null }, '2030-01-01T00:00:00Z'), false);
  assert.equal(instantOf('2026-11-22'), '2026-11-22T00:00:00.000Z');
});

// TMDB date D, airs 21:00 America/New_York on D = D+1 02:00 UTC.
const ep = (number, over = {}) => ({ number, name: `Episode ${number}`, airDate: '2026-11-0' + number, releaseAt: `2026-11-0${number + 1}T02:00:00.000Z`, runtime: 60, watchedAt: null, watched: false, watchSource: null, ...over });
const summaryOf = (over = {}) => ({
  showId: 'show', name: 'Show', posterURL: null, status: 'watching', source: 'TMDB', guideAvailable: true, countDataAvailable: true, legacyPosition: null,
  watchedCount: 2, explicitWatchedCount: 2, legacyInferredCount: 0, releasedCount: 3, remainingCount: 1, progressPercent: 67, viewingState: 'in_progress',
  nextEpisode: { season: 1, number: 3, name: 'Episode 3', airDate: '2026-11-03', releaseAt: '2026-11-04T02:00:00.000Z', runtime: 60, watchedAt: null }, lastEpisode: null, upcomingEpisode: null, newEpisodes: 0, recentHistory: [], error: null, ...over,
});
// Episode 4 is dated today on TMDB but premieres tonight: the Watch Room must not offer it as next.
const guide = { seasons: [{ number: 1, episodeCount: 4 }], season: 1, watched: [], episodes: [ep(1, { watched: true }), ep(2, { watched: true }), ep(3), ep(4)] };

test('Watch Room optimistic update never promotes an episode before its release instant', () => {
  const now = '2026-11-04T12:00:00.000Z';
  const { summary, nextPending } = optimisticSummary(summaryOf(), guide, 1, 3, true, now);
  assert.deepEqual([summary.watchedCount, summary.remainingCount, summary.progressPercent, nextPending], [3, 0, 100, true], 'E4 is not released at noon UTC');
  assert.equal(summary.nextEpisode, null);
  const later = optimisticSummary(summaryOf({ releasedCount: 4, remainingCount: 2, progressPercent: 50 }), guide, 1, 3, true, '2026-11-05T02:00:00.000Z');
  assert.deepEqual([later.summary.nextEpisode?.number, later.summary.nextEpisode?.releaseAt, later.nextPending], [4, '2026-11-05T02:00:00.000Z', false]);
  // Unwatching a released episode moves "next" back and keeps its release instant.
  const back = optimisticSummary(summaryOf(), guide, 1, 1, false, now);
  assert.deepEqual([back.summary.nextEpisode?.number, back.summary.nextEpisode?.releaseAt, back.summary.watchedCount], [1, '2026-11-02T02:00:00.000Z', 1]);
});
