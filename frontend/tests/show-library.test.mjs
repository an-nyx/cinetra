import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterAndSortShows, personalStatus, personalStatusColors } from '../src/lib/show-library.ts';
const make = (name, status, completed, favorite, date) => ({ id: name, name, status, completed, favorite, createdAt: date, updatedAt: date });
const shows = [make('Waiting', 'watching', true, true, '2021-01-01'), make('Done', null, true, true, '2022-01-01'), make('Stopped', 'dropped', false, false, '2023-01-01'), make('Planned', 'planned', false, false, '2024-01-01'), make('Paused', 'paused', false, false, '2025-01-01'), make('Legacy', null, false, true, '2020-01-01')];
test('S2E0 waiting with 100% progress stays Watching and blue', () => {
  Object.assign(shows[0], { seasonsWatched: 2, episodesWatched: 0, progressPercent: 100, viewingState: 'caught_up' });
  assert.equal(personalStatus(shows[0]), 'watching');
  assert.equal(personalStatusColors[personalStatus(shows[0])], '#557da8');
  assert.equal(personalStatusColors[personalStatus(shows[1])], '#5c9775');
  assert.equal(personalStatusColors[personalStatus(shows[2])], '#a75d60');
  assert.equal(personalStatus(shows[5]), 'none');
});
test('status, completion, favorite, search and sorting combine', () => {
  for (const s of ['watching', 'completed', 'dropped', 'planned', 'paused', 'none']) assert.equal(filterAndSortShows(shows, '', { statusFilter: s }).length, 1);
  assert.deepEqual(filterAndSortShows(shows, 'a', { favoriteFilter: 'favorite', completeFilter: 'notCompleted', sortBy: 'dateOldest' }).map(s => s.name), ['Legacy', 'Waiting']);
  assert.deepEqual(filterAndSortShows(shows, '', { favoriteFilter: 'favorite', completeFilter: 'completed', statusFilter: 'completed' }).map(s => s.name), ['Done']);
  assert.deepEqual(filterAndSortShows(shows, '', { statusFilter: 'watching', completeFilter: 'completed' }), []);
  assert.deepEqual(filterAndSortShows(shows, '', { sortBy: 'nameDesc' }).map(s => s.name), ['Waiting', 'Stopped', 'Planned', 'Paused', 'Legacy', 'Done']);
});
