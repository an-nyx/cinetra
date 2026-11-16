import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchLibrary } from '../src/lib/library-search.ts';

const movies = [{ id: 'saved-movie', name: 'Amélie', status: 'watched', posterURL: '/poster.jpg' }, { id: 'same-id', name: 'Dark', status: null }];
const shows = [{ id: 'same-id', name: 'Dark', status: 'watching' }, { id: 'completed', name: 'Lost', completed: true }, { id: 'dropped', name: 'Lost Again', status: 'dropped', completed: true }];

test('search only saved titles, ignoring case, accents and surrounding spaces', () => {
  assert.equal(searchLibrary(movies, shows, ' TMDB exclusive ').length, 0);
  const [result] = searchLibrary(movies, shows, ' AMELIE ');
  assert.equal(result.id, 'saved-movie');
  assert.equal(result.posterURL, '/poster.jpg');
  assert.equal(result.statusLabel, 'Watched');
});
test('both media kinds retain saved IDs and statuses, including legacy completion', () => {
  assert.deepEqual(searchLibrary(movies, shows, 'dark').map(r => [r.id, r.kind, r.statusLabel]), [['same-id', 'movie', 'No status selected'], ['same-id', 'show', 'Watching']]);
  assert.deepEqual(searchLibrary(movies, shows, 'lost').map(r => r.statusLabel), ['Completed', 'Dropped']);
});
test('empty queries and empty libraries return no results', () => {
  assert.deepEqual(searchLibrary(movies, shows, '   '), []);
  assert.deepEqual(searchLibrary([], [], 'dark'), []);
});
