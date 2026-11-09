import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readUpcomingCache, writeUpcomingCache, clearUpcomingCache } from '../src/lib/upcoming-cache.ts';
const values = new Map();
globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), key: index => [...values.keys()][index] ?? null, get length() { return values.size; } };
test('snapshots survive reload, remain separated by credential and clear on logout', async () => {
  localStorage.setItem('Authorization', 'token-a');
  const data = { status: 'ready', source: 'TVMaze', generatedAt: '2026-11-01T00:00:00Z', releases: [], returningTba: [], needsReview: [], coverage: {} };
  await writeUpcomingCache('tv', data);
  assert.deepEqual(await readUpcomingCache('tv'), data);
  assert.ok(![...values.keys()].some(k => k.includes('token-a')));
  localStorage.setItem('Authorization', 'token-b');
  assert.equal(await readUpcomingCache('tv'), null);
  clearUpcomingCache();
  localStorage.setItem('Authorization', 'token-a');
  assert.equal(await readUpcomingCache('tv'), null);
});
