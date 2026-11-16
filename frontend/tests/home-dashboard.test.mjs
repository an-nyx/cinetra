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

test('keep the featured show across ranking changes, switch only when no longer playable', () => {
  const a = summary('a');
  const b = summary('b', { recentHistory: watched('2026-11-17T10:00:00Z') });
  const stable = homeDashboard([a, b], 6, 'a');
  assert.equal(stable.featured.showId, 'a');
  assert.deepEqual(stable.continueWatching.map(s => s.showId), ['b']);
  for (const change of [{ nextEpisode: null }, { viewingState: 'fully_watched' }, { status: 'dropped' }, { status: 'paused' }]) {
    assert.equal(homeDashboard([summary('a', change), b], 6, 'a').featured.showId, 'b');
  }
});

import { createHomeTracking } from '../src/lib/home-tracking.ts';
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('mark next keeps the featured card until confirmed progress arrives; stale reads and double taps cannot flicker', async () => {
  const initial = [summary('a'), summary('b')];
  let current = initial;
  let busy = null;
  let saves = 0;
  const old = deferred(), saved = deferred(), fresh = deferred();
  let reads = 0;
  const flow = createHomeTracking({
    read: () => (++reads === 1 ? old.promise : fresh.promise),
    save: () => { saves++; return saved.promise; },
    publish: (_, rows) => { current = rows; },
    pending: value => { busy = value; },
  });
  const staleLoad = flow.load();
  const mutation = flow.mark(initial[0]);
  await flow.mark(initial[0]);
  assert.equal(saves, 1);
  assert.equal(busy, 'a');
  assert.equal(homeDashboard(current).featured.showId, 'a');
  assert.equal(current[0].nextEpisode.number, 6, 'do not null eligibility or guess the next episode');
  old.resolve([[], [summary('b')]]);
  await staleLoad;
  assert.equal(current, initial, 'pre-save read discarded');
  saved.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(homeDashboard(current).featured.showId, 'a', 'still stable while refreshing');
  fresh.resolve([[], [summary('a', { watchedCount: 6, remainingCount: 4, progressPercent: 60, nextEpisode: { season: 1, number: 7 } }), summary('b')]]);
  await mutation;
  assert.equal(homeDashboard(current).featured.showId, 'a');
  assert.equal(current[0].nextEpisode.number, 7);
  assert.equal(current[0].progressPercent, 60);
  assert.equal(busy, null);
});

test('failed refresh preserves committed card and blocks stale repeat; retry recovers', async () => {
  let busy;
  let saves = 0;
  let fail = true;
  const flow = createHomeTracking({
    read: async () => { if (fail) throw Error('offline'); return [[], []]; },
    save: async () => { saves++; }, publish: () => {}, pending: value => { busy = value; },
  });
  await assert.rejects(flow.mark(summary('a')), /Episode saved/);
  await flow.mark(summary('a'));
  assert.equal(saves, 1);
  assert.equal(busy, 'a');
  fail = false;
  await flow.load();
  assert.equal(busy, null);
});

test('latest load wins and unmounted mutations cannot publish', async () => {
  const first = deferred(), second = deferred();
  let reads = 0, published = [];
  const flow = createHomeTracking({ read: () => (++reads === 1 ? first.promise : second.promise), save: async () => {}, publish: (_, rows) => published.push(rows), pending: () => {} });
  const a = flow.load(), b = flow.load();
  second.resolve([[], [summary('new')]]);
  await b;
  first.resolve([[], [summary('old')]]);
  await a;
  assert.deepEqual(published.map(rows => rows[0].showId), ['new']);
  const save = deferred();
  const unmounted = createHomeTracking({ read: async () => { throw Error('must not read'); }, save: () => save.promise, publish: () => assert.fail('unmounted publish'), pending: () => {} });
  const mutation = unmounted.mark(summary('a'));
  unmounted.invalidate();
  save.resolve();
  await mutation;
});

test('a failed write leaves confirmed progress intact and allows retry', async () => {
  const initial = [summary('a'), summary('b')];
  let current = initial, busy, fail = true;
  const flow = createHomeTracking({
    read: async () => [[], initial],
    save: async () => { if (fail) throw Error('save failed'); },
    publish: (_, rows) => { current = rows; }, pending: value => { busy = value; },
  });
  await assert.rejects(flow.mark(initial[0]), /save failed/);
  assert.equal(current, initial);
  assert.equal(busy, null);
  fail = false;
  await flow.mark(initial[0]);
  assert.equal(busy, null);
});
