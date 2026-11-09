import assert from 'node:assert/strict';
import { buildTrackingSummary, type Catalog, type TrackedShow, type WatchRecord } from '../src/services/tracking-summary.model';

const today = '2026-11-09';
const episodes = [1, 2].map(number => ({ season: 1, number, name: `Episode ${number}`, airDate: '2001-01-01', airTimestamp: null, runtime: null }));
const catalog = (broadcastStatus: string | null): Catalog => ({ source: 'TMDB', seasons: [{ number: 1, episodeCount: 2 }], episodes, broadcastStatus, inProduction: false, nextEpisodeAnnounced: false });
const show = (season: number, status: string | null = null): TrackedShow => ({ id: 'test', name: 'Test', posterURL: null, status, completed: false, seasonsWatched: season, episodesWatched: 0 });
const oldWatches: WatchRecord[] = [{ season: 1, episode: 1, watchedAt: new Date('2001-01-01T00:00:00Z') }];
for (const season of [2, 3, 4]) for (const status of [null, 'watching', 'completed', 'dropped']) {
  for (const metadata of [catalog('Returning Series'), catalog('Ended'), catalog('Canceled'), null]) {
    const input = show(season, status);
    const result = buildTrackingSummary(input, metadata, metadata ? null : 'unavailable', oldWatches, today);
    assert.equal(result.status, status, `personal status changed for S${season}E0`);
    assert.notEqual(result.viewingState, 'dropped');
    assert.equal(input.seasonsWatched, season);
    assert.equal(input.episodesWatched, 0);
    assert.deepEqual(result.recentHistory, oldWatches);
  }
}
const original = show(2, 'watching');
const dropped = buildTrackingSummary({ ...original, status: 'dropped' }, catalog('Returning Series'), null, oldWatches, today);
const restored = buildTrackingSummary(original, catalog('Returning Series'), null, oldWatches, today);
assert.equal(dropped.status, 'dropped'); assert.equal(restored.status, 'watching');
assert.deepEqual(dropped.legacyPosition, restored.legacyPosition);
assert.deepEqual(dropped.recentHistory, restored.recentHistory);
assert.equal(dropped.viewingState, restored.viewingState);
assert.equal(dropped.broadcastStatus, restored.broadcastStatus);
console.log('Manual Dropped status tests passed');
