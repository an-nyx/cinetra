import assert from 'node:assert/strict';
import { mapLimit, SWRCache } from '../src/services/swr-cache';

async function main() {
  let clock = 0;
  const cache = new SWRCache<number>({ freshMs: 100, staleMs: 1000, retryMs: 50, now: () => clock });
  let loads = 0;
  const load = (value: number, fail = false) => async () => { loads++; await new Promise(r => setTimeout(r, 5)); if (fail) throw new Error('down'); return value; };

  // Concurrent first requests share one load.
  const [a, b] = await Promise.all([cache.get('k', load(1)), cache.get('k', load(99))]);
  assert.deepEqual([a, b, loads], [1, 1, 1]);

  // Fresh: served without loading.
  clock = 50; assert.equal(await cache.get('k', load(2)), 1); assert.equal(loads, 1);

  // Stale: old value returned at once, one background refresh, new value afterwards.
  clock = 150; assert.equal(await cache.get('k', load(2)), 1);
  assert.equal(await cache.get('k', load(3)), 1); // refresh already in flight: not started twice
  await new Promise(r => setTimeout(r, 20));
  assert.equal(loads, 2);
  assert.equal(await cache.get('k', load(4)), 2);

  // Failed background refresh keeps the stale value and waits retryMs before trying again.
  clock = 300; assert.equal(await cache.get('k', load(0, true)), 2);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(await cache.get('k', load(5)), 2); // within retry window: no new load
  assert.equal(loads, 3);

  // Expired beyond staleMs: the caller waits for a fresh load.
  clock = 5000; assert.equal(await cache.get('k', load(6)), 6);

  // A failed first load is not cached; the next call tries again.
  await assert.rejects(cache.get('x', load(0, true)));
  assert.equal(await cache.get('x', load(7)), 7);

  // mapLimit keeps order and never exceeds the limit.
  let active = 0, peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async n => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; return n * 2; });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.ok(peak <= 3);

  console.log('performance cache tests passed');
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
