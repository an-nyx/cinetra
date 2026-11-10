import assert from 'node:assert/strict';
import { movieInfo } from '../src/services/movie-info.model';

const base = { id: 123, release_date: '2024-05-02', runtime: 121, genres: [{ name: 'Drama' }] };
assert.deepEqual(movieInfo({ ...base, videos: { results: [
  { site: 'YouTube', type: 'Trailer', official: false, key: 'abcdefghijk' },
  { site: 'YouTube', type: 'Teaser', official: true, key: 'abcdefghijk' },
  { site: 'YouTube', type: 'Trailer', official: true, key: 'abc123_-XYZ' },
] } }), { year: '2024', runtime: 121, genres: ['Drama'], trailerUrl: 'https://www.youtube.com/watch?v=abc123_-XYZ' });
assert.deepEqual(movieInfo({ id: 1, release_date: 'invalid', runtime: 0, videos: { results: [{ site: 'YouTube', type: 'Trailer', official: true, key: '../../evil' }] } }), { year: null, runtime: null, genres: [], trailerUrl: null });
console.log('movie info tests passed');
