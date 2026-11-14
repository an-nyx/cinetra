import { test } from 'node:test';
import assert from 'node:assert/strict';
import { movieStatusCounts, movieStatusOf, ratingStars } from '../src/lib/movie-library.ts';

test('personal rating stars: each star is 2 points, odd ratings end on a half star', () => {
  assert.deepEqual(ratingStars(10), [100, 100, 100, 100, 100]);
  assert.deepEqual(ratingStars(6), [100, 100, 100, 0, 0]);
  assert.deepEqual(ratingStars(7), [100, 100, 100, 50, 0]);
  assert.deepEqual(ratingStars(1), [50, 0, 0, 0, 0]);
  assert.deepEqual(ratingStars(2), [100, 0, 0, 0, 0]);
  for (let r = 1; r <= 10; r++) assert.equal(ratingStars(r).reduce((a, b) => a + b, 0) / 50, r, `rating ${r} renders exactly ${r} half-stars`);
});

test('unrated movies show no rating row; a saved value is never invented', () => {
  assert.equal(ratingStars(null), null);
  assert.equal(ratingStars(undefined), null);
  assert.equal(ratingStars(Number.NaN), null);
  assert.deepEqual(ratingStars(0), [0, 0, 0, 0, 0], 'only an explicitly saved 0 would render empty stars');
});

test('movie status buckets and counts include Dropped', () => {
  const movies = [{ status: 'watchlist' }, { status: 'watched' }, { status: 'dropped' }, { status: 'dropped' }, { status: null }, {}, { status: 'unknown-legacy' }];
  assert.deepEqual(movies.map(movieStatusOf), ['watchlist', 'watched', 'dropped', 'dropped', 'none', 'none', 'none']);
  assert.deepEqual(movieStatusCounts(movies), { watchlist: 1, watched: 1, dropped: 2, none: 3 });
  assert.equal(Object.values(movieStatusCounts(movies)).reduce((a, b) => a + b, 0), movies.length, 'every movie in exactly one bucket');
});
