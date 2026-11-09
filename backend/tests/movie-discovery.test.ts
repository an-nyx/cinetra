import assert from 'node:assert/strict';
import { classifyMovie } from '../src/services/movie-discovery.model';
import { discoverMovies } from '../src/services/movie-discovery.service';
import type { MovieDetails, MovieCollection } from '../src/services/tmdb/tmdb-api.service';

const group = { id: 11, name: 'Verified collection' };
const base: MovieDetails = { id: 3, title: 'Part three', status: 'Post Production', belongs_to_collection: group, release_date: '2030-05-03', release_dates: { results: [
  { iso_3166_1: 'US', release_dates: [{ type: 3, release_date: '2030-05-03T00:00:00Z' }] },
  { iso_3166_1: 'FR', release_dates: [{ type: 4, release_date: '2030-06-05T00:00:00Z' }] },
] } };
const today = '2029-01-01';
assert.equal(classifyMovie(base, group, new Set(), today, 'FR')?.market, 'FR');
assert.equal(classifyMovie(base, group, new Set(), today, 'FR')?.releaseType, 'Digital');
assert.equal(classifyMovie(base, group, new Set(), today, 'US')?.date, '2030-05-03');
assert.equal(classifyMovie({ ...base, belongs_to_collection: { id: 12, name: 'Similar title' } }, group, new Set(), today), null);
assert.equal(classifyMovie({ ...base, status: 'Released' }, group, new Set(), today), null);
assert.equal(classifyMovie({ ...base, release_date: '2020-01-01' }, group, new Set(), today), null);
assert.equal(classifyMovie({ ...base, status: 'Rumored' }, group, new Set(), today)?.date, null);
assert.equal(classifyMovie({ ...base, release_dates: undefined }, group, new Set(), today)?.date, null);
assert.equal(classifyMovie(base, group, new Set([3]), today)?.inLibrary, true);

async function run() {
  const films: Record<number, MovieDetails> = {
    1: { id: 1, title: 'First', belongs_to_collection: group, release_date: '2020-01-01' },
    2: { id: 2, title: 'Second', belongs_to_collection: group, release_date: '2021-01-01' },
    3: base,
    4: { ...base, id: 4, title: 'Similar title', belongs_to_collection: { id: 12, name: 'Other' } },
  };
  let requests = 0;
  const provider = { details: async (id: number) => { if (!films[id]) throw new Error('missing'); return films[id]; }, collection: async (): Promise<MovieCollection> => { requests++; return { ...group, parts: [{ id: 1, release_date: '2020-01-01' }, { id: 2, release_date: '2021-01-01' }, { id: 3, release_date: '2030-05-03' }, { id: 4 }] }; } };
  const result = await discoverMovies([1, 2, null], today, 'FR', provider);
  assert.equal(requests, 1); assert.equal(result.verifiedMovies, 2); assert.equal(result.unresolved, 1);
  assert.deepEqual(result.releases.map(x => x.tmdbId), [3]);
  const incomplete = await discoverMovies([1], today, undefined, { ...provider, collection: async () => ({ ...group, parts: [] }) });
  assert.equal(incomplete.releases.length, 0); assert.equal(incomplete.unresolved, 1);
  console.log('Movie discovery tests passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
