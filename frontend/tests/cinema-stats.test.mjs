import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barPercent, hasAnyStats, pickYear, rankGenres, sharePercent, splitDuration } from '../src/lib/cinema-stats.ts';

test('durations split into hours, minutes and whole days; invalid input is zero', () => {
  assert.deepEqual(splitDuration(0), { hours: 0, minutes: 0, days: 0 });
  assert.deepEqual(splitDuration(45), { hours: 0, minutes: 45, days: 0 });
  assert.deepEqual(splitDuration(125), { hours: 2, minutes: 5, days: 0 });
  assert.deepEqual(splitDuration(1500), { hours: 25, minutes: 0, days: 1 });
  assert.deepEqual(splitDuration(Number.NaN), { hours: 0, minutes: 0, days: 0 });
  assert.deepEqual(splitDuration(-30), { hours: 0, minutes: 0, days: 0 });
});

test('bars scale to the largest value; zero stays empty, tiny non-zero stays visible', () => {
  assert.equal(barPercent(50, 100), 50);
  assert.equal(barPercent(100, 100), 100);
  assert.equal(barPercent(0, 100), 0);
  assert.equal(barPercent(1, 1000), 3);
  assert.equal(barPercent(5, 0), 0);
  assert.equal(barPercent(200, 100), 100);
});

test('shares never exceed 100 and are 0 without a whole', () => {
  assert.equal(sharePercent(1, 3), 33);
  assert.equal(sharePercent(0, 0), 0);
  assert.equal(sharePercent(10, 0), 0);
  assert.equal(sharePercent(5, 5), 100);
});

test('year selection keeps a remembered year only while it has records', () => {
  assert.equal(pickYear([2026, 2025], 2025), 2025);
  assert.equal(pickYear([2026, 2025], 2019), 2026, 'falls back to the latest year with records');
  assert.equal(pickYear([2025, 2026], null), 2026);
  assert.equal(pickYear([], 2026), null, 'no dated records: no year is invented');
});

test('genres rank by time or titles with stable tie-breaks', () => {
  const items = [{ name: 'Drama', titles: 5, minutes: 300 }, { name: 'Comedy', titles: 9, minutes: 200 }, { name: 'Crime', titles: 5, minutes: 300 }];
  assert.deepEqual(rankGenres(items, 'time').map(g => g.name), ['Crime', 'Drama', 'Comedy']);
  assert.deepEqual(rankGenres(items, 'titles').map(g => g.name), ['Comedy', 'Crime', 'Drama']);
  assert.equal(rankGenres(items, 'time', 1).length, 1);
  assert.deepEqual(items.map(g => g.name), ['Drama', 'Comedy', 'Crime'], 'input is not reordered');
});

test('empty library detection', () => {
  assert.equal(hasAnyStats({ tv: { shows: 0 }, movies: { total: 0 } }), false);
  assert.equal(hasAnyStats({ tv: { shows: 1 }, movies: { total: 0 } }), true);
  assert.equal(hasAnyStats({ tv: { shows: 0 }, movies: { total: 2 } }), true);
});
