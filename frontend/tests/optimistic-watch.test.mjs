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
