import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createWatchMutation } from '../src/lib/optimistic-watch.mjs';
test('immediate update, duplicate suppression, commit and rollback', async () => {
  const mutate = createWatchMutation();
  let resolve, checked = false, writes = 0, errors = 0, syncs = 0;
  const options = { optimistic: () => { checked = true; }, save: () => { writes++; return new Promise(r => { resolve = r; }); }, rollback: () => { checked = false; }, failed: () => { errors++; }, settled: () => { syncs++; } };
  const started = performance.now();
  const pending = mutate(options);
  assert.equal(checked, true);
  const visibleMs = performance.now() - started;
  assert.ok(visibleMs < 50);
  assert.equal(await mutate(options), false);
  assert.equal(writes, 1);
  resolve(); await pending;
  assert.equal(syncs, 1);
  await mutate({ ...options, save: async () => { throw new Error('offline'); } });
  assert.equal(checked, false); assert.equal(errors, 1); assert.equal(syncs, 1);
  console.log(`optimistic click visibility: ${visibleMs.toFixed(3)}ms (save unresolved)`);
});
test('unwatch failure restores the exact snapshot and a retry can succeed', async () => {
  const mutate = createWatchMutation();
  const original = { watched: true, watchedAt: '2020-01-01', watchSource: 'legacy' };
  let episode = original;
  let errorShown = false;
  const options = {
    optimistic: () => { episode = { ...original, watched: false }; },
    save: async () => { throw new Error('database unavailable'); },
    rollback: () => { episode = original; },
    failed: () => { errorShown = true; },
    settled: () => {},
  };
  assert.equal(await mutate(options), false);
  assert.equal(episode, original);
  assert.equal(errorShown, true);
  assert.equal(await mutate({ ...options, save: async () => {} }), true);
  assert.equal(episode.watched, false);
});

// ---- Watch Room: immediate next episode/progress, confirmed summaries and ordering ----
import { optimisticSummary, createConfirmedSummaries, publishConfirmedSummary, onConfirmedSummary, trackingTick } from '../src/lib/tracking-sync.ts';
const TODAY = '2026-11-19';
const ep = (number, over = {}) => ({ number, name: `Episode ${number}`, airDate: '2026-01-0' + Math.min(number, 9), runtime: 50, watchedAt: null, watched: false, watchSource: null, ...over });
const guideOf = (watchedUpTo, count = 6, season = 1) => ({ seasons: [{ number: 1, episodeCount: count }, { number: 2, episodeCount: 6 }], season, watched: [], episodes: Array.from({ length: count }, (_, i) => ep(i + 1, { watched: i + 1 <= watchedUpTo })) });
const summaryOf = (over = {}) => ({
  showId: 'show', name: 'Show', posterURL: null, status: 'watching', source: 'TMDB', guideAvailable: true, countDataAvailable: true, legacyPosition: null,
  watchedCount: 3, explicitWatchedCount: 3, legacyInferredCount: 0, releasedCount: 12, remainingCount: 9, progressPercent: 25, viewingState: 'in_progress',
  nextEpisode: { season: 1, number: 4, name: 'Episode 4', airDate: '2026-01-04', runtime: 50, watchedAt: null }, lastEpisode: null, upcomingEpisode: null, newEpisodes: 0, recentHistory: [], error: null, ...over,
});

test('mark next: the following episode and progress appear immediately, from the loaded season only', () => {
  const { summary, nextPending } = optimisticSummary(summaryOf(), guideOf(3), 1, 4, true, TODAY);
  assert.equal(nextPending, false);
  assert.deepEqual([summary.nextEpisode.season, summary.nextEpisode.number, summary.watchedCount, summary.remainingCount, summary.progressPercent], [1, 5, 4, 8, 33]);
  // Last released episode of the season: the next one is in another season, so it is not guessed.
  const last = optimisticSummary(summaryOf({ nextEpisode: { season: 1, number: 6, name: 'Episode 6', airDate: '2026-01-06', runtime: 50, watchedAt: null } }), guideOf(5), 1, 6, true, TODAY);
  assert.equal(last.nextPending, true);
  assert.equal(last.summary.nextEpisode, null);
  assert.equal(last.summary.watchedCount, 4);
  // An unreleased later episode is never offered as next.
  const unreleased = guideOf(3); unreleased.episodes[4].airDate = '2027-01-01'; unreleased.episodes[5].airDate = null;
  assert.equal(optimisticSummary(summaryOf(), unreleased, 1, 4, true, TODAY).nextPending, true);
});

test('unwatching an earlier episode moves next back; no-ops and unknown episodes change nothing', () => {
  const caught = summaryOf({ watchedCount: 12, remainingCount: 0, progressPercent: 100, viewingState: 'caught_up', nextEpisode: null });
  const { summary } = optimisticSummary(caught, guideOf(6), 1, 2, false, TODAY);
  assert.deepEqual([summary.nextEpisode.number, summary.watchedCount, summary.remainingCount, summary.progressPercent, summary.viewingState], [2, 11, 1, 92, 'in_progress']);
  const later = optimisticSummary(summaryOf(), guideOf(3), 1, 2, false, TODAY).summary;
  assert.equal(later.nextEpisode.number, 2);
  const base = summaryOf();
  assert.equal(optimisticSummary(base, guideOf(3), 1, 2, true, TODAY).summary, base, 'already watched');
  assert.equal(optimisticSummary(base, guideOf(3), 2, 3, true, TODAY).summary, base, 'episode not in the loaded guide');
  const unreliable = summaryOf({ progressPercent: null, countDataAvailable: false, nextEpisode: null });
  assert.equal(optimisticSummary(unreliable, guideOf(3), 1, 5, true, TODAY).summary.watchedCount, 3, 'unverified counts are not guessed');
});

test('Watch Room flow: instant update, single save, confirmed summary replaces it; failure restores the exact snapshot', async () => {
  const mutate = createWatchMutation();
  let view = { summary: summaryOf(), guide: guideOf(3), error: '' };
  const snapshot = view;
  let resolveSave, saves = 0;
  const confirmedSummary = summaryOf({ watchedCount: 4, remainingCount: 8, progressPercent: 33, nextEpisode: { season: 1, number: 5, name: 'Episode 5', airDate: '2026-01-05', runtime: 50, watchedAt: null }, lastEpisode: { season: 1, number: 4 } });
  const run = (save) => mutate({
    optimistic: () => { view = { ...view, summary: optimisticSummary(view.summary, view.guide, 1, 4, true, TODAY).summary }; },
    save,
    rollback: () => { view = snapshot; },
    failed: () => { view = { ...view, error: 'Could not save episode.' }; },
    settled: () => { view = { ...view, summary: confirmedSummary }; },
  });
  const t0 = performance.now();
  const pending = run(() => { saves++; return new Promise(r => { resolveSave = r; }); });
  const visibleMs = performance.now() - t0;
  assert.equal(view.summary.nextEpisode.number, 5, 'next episode visible before the save answers');
  assert.equal(view.summary.progressPercent, 33);
  assert.equal(await run(async () => { saves++; }), false, 'second tap while saving is ignored');
  assert.equal(saves, 1);
  resolveSave(); await pending;
  assert.equal(view.summary, confirmedSummary);
  view = snapshot;
  await run(async () => { throw new Error('offline'); });
  assert.equal(view.summary, snapshot.summary, 'rolled back to the exact previous summary');
  assert.equal(view.error, 'Could not save episode.');
  console.log(`Watch Room next episode + progress visible: ${visibleMs.toFixed(3)}ms (save unresolved)`);
});

test('confirmed summaries: newest save wins, earlier library reads cannot undo them, later reads take over', () => {
  const store = createConfirmedSummaries();
  const readA = trackingTick();
  const saveStarted = trackingTick();
  const newer = { summary: summaryOf({ watchedCount: 5 }), started: trackingTick(), confirmed: trackingTick() };
  const older = { summary: summaryOf({ watchedCount: 4 }), started: saveStarted, confirmed: trackingTick() };
  assert.equal(store.accept(newer), true);
  assert.equal(store.accept(older), false, 'a slower, earlier save cannot overwrite newer progress');
  const stale = [summaryOf({ watchedCount: 3 }), summaryOf({ showId: 'other' })];
  const merged = store.merge(stale, readA);
  assert.equal(merged[0].watchedCount, 5, 'read started before the confirmation is overlaid');
  assert.equal(merged[1], stale[1], 'other shows untouched');
  const readB = trackingTick();
  const fresh = [summaryOf({ watchedCount: 6 })];
  assert.equal(store.merge(fresh, readB)[0].watchedCount, 6, 'a read that started later is authoritative');
  assert.equal(store.merge([summaryOf({ watchedCount: 3 })])[0].watchedCount, 3, 'and the confirmation is then forgotten');
});

test('confirmed summaries reach other views through one event', () => {
  globalThis.window ??= new EventTarget();
  const seen = [];
  const stop = onConfirmedSummary(update => seen.push(update.summary.watchedCount));
  publishConfirmedSummary({ summary: summaryOf({ watchedCount: 9 }), started: 1, confirmed: 2 });
  stop();
  publishConfirmedSummary({ summary: summaryOf({ watchedCount: 10 }), started: 3, confirmed: 4 });
  assert.deepEqual(seen, [9]);
});
