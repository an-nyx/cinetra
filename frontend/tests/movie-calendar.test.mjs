import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterMovieReleases } from '../src/lib/movie-calendar.ts';

const now = new Date(2026, 10, 11, 10);
const films = ['2026-11-10', '2026-11-11', '2026-11-15', '2026-11-25', '2026-12-03', null].map((date, i) => ({ tmdbId: i, date }));
test('movie date filters exclude past, undated and season premieres', () => {
  assert.deepEqual(filterMovieReleases(films, 'all', now).map(x => x.date), ['2026-11-11', '2026-11-15', '2026-11-25', '2026-12-03']);
  assert.deepEqual(filterMovieReleases(films, 'today', now).map(x => x.date), ['2026-11-11']);
  assert.deepEqual(filterMovieReleases(films, 'week', now).map(x => x.date), ['2026-11-11', '2026-11-15']);
  assert.equal(filterMovieReleases(films, 'month', now).length, 3);
  assert.equal(filterMovieReleases(films, 'premieres', now).length, 0);
});
test('Home preview takes the first three dated releases', () => {
  assert.deepEqual(filterMovieReleases(films, 'all', now).slice(0, 3).map(x => x.tmdbId), [1, 2, 3]);
});
