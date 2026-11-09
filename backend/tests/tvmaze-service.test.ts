import assert from 'node:assert/strict';
import axios, { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';

// Every TVMaze request is answered here; nothing leaves the machine.
const requests: string[] = [];
let tvmazeDown = false;
const showsById: Record<number, object> = {
  1505: { id: 1505, name: 'One Piece', premiered: '1999-10-20', status: 'Running', updated: 100, externals: { thetvdb: 81797, imdb: 'tt0388629' }, network: { name: 'Fuji TV' },
    _embedded: { episodes: [{ id: 1, season: 2026, number: 26, type: 'regular', name: 'Episode 1181', airdate: '', airtime: '23:15', airstamp: null }] } },
  46065: { id: 46065, name: 'One Piece', premiered: '2023-08-31', status: 'Running', updated: 100, externals: { thetvdb: 392276, imdb: 'tt11737520' }, webChannel: { name: 'Netflix' },
    _embedded: { episodes: [{ id: 2, season: 3, number: 1, type: 'regular', name: 'Premiere', airdate: '2030-03-10', airtime: '', airstamp: '2030-03-10T12:00:00+00:00' }] } },
  777: { id: 777, name: 'Harbor Lights', premiered: '2024-03-01', status: 'Running', updated: 100, externals: { thetvdb: null, imdb: null }, network: { name: 'BBC One' }, _embedded: { episodes: [] } },
};
const respond = (config: InternalAxiosRequestConfig, status: number, data: unknown, headers: Record<string, string> = {}) => {
  const response = { data, status, statusText: String(status), headers, config };
  if (config.validateStatus && !config.validateStatus(status)) return Promise.reject(new AxiosError(`HTTP ${status}`, String(status), config, null, response));
  return Promise.resolve(response);
};
const adapter: AxiosAdapter = async config => {
  const params = (config.params || {}) as Record<string, string | number>;
  const url = `${config.url}?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()}`;
  requests.push(url);
  if (tvmazeDown) return respond(config, 503, {});
  if (config.url === '/lookup/shows') {
    const id = params.thetvdb === 81797 ? 1505 : params.thetvdb === 392276 ? 46065 : params.imdb === 'tt0388629' ? 1505 : null;
    return id ? respond(config, 301, '', { location: `https://api.tvmaze.com/shows/${id}` }) : respond(config, 404, {});
  }
  if (config.url === '/search/shows') return respond(config, 200, [{ show: showsById[777] }, { show: { ...showsById[777], id: 778, premiered: '1998-01-01' } }]);
  if (config.url === '/updates/shows') return respond(config, 200, { 46065: 200 });
  const show = /^\/shows\/(\d+)$/.exec(config.url || '');
  if (show && showsById[Number(show[1])]) return respond(config, 200, showsById[Number(show[1])]);
  return respond(config, 404, {});
};
axios.defaults.adapter = adapter;

async function main() {
  const service = await import('../src/services/tvmaze/tvmaze.service');
  const noEvidence = async () => ({ names: [], firstAirDate: null, overview: null });

  // TheTVDB lookup selects the live-action series; the redirect is read without a second request.
  const live = await service.resolveIdentity({ tmdbId: 111110, externalIds: async () => ({ tvdbId: 392276, imdbId: 'tt11737520' }), evidence: noEvidence });
  assert.deepEqual(live, { status: 'verified', tvmazeId: 46065, method: 'external_id' });
  assert.deepEqual(requests, ['/lookup/shows?thetvdb=392276', '/shows/46065?embed=episodes']);
  // The anime by its IMDb ID when TheTVDB is unknown.
  const animeResult = await service.resolveIdentity({ tmdbId: 37854, externalIds: async () => ({ tvdbId: null, imdbId: 'tt0388629' }), evidence: noEvidence });
  assert.deepEqual(animeResult, { status: 'verified', tvmazeId: 1505, method: 'external_id' });
  // TMDB says one series, TVMaze's record for that TheTVDB ID carries the other series' IMDb ID: conflict.
  assert.deepEqual(await service.resolveIdentity({ tmdbId: 5, externalIds: async () => ({ tvdbId: 81797, imdbId: 'tt11737520' }), evidence: noEvidence }), { status: 'unresolved', reason: 'external_id_conflict' });

  // Identities are cached: asking again makes no request.
  const before = requests.length;
  await service.resolveIdentity({ tmdbId: 111110, externalIds: async () => { throw new Error('not called'); }, evidence: noEvidence });
  assert.equal(requests.length, before);

  // No external IDs: strict title fallback; the same-title 1998 record is ignored.
  const fallback = await service.resolveIdentity({ tmdbId: 9, externalIds: async () => ({ tvdbId: null, imdbId: null }), evidence: async () => ({ names: ['Harbor Lights'], firstAirDate: '2024-03-01', overview: null }) });
  assert.deepEqual(fallback, { status: 'verified', tvmazeId: 777, method: 'title_corroborated' });
  // Not on TVMaze at all.
  assert.deepEqual(await service.resolveIdentity({ tmdbId: 10, externalIds: async () => ({ tvdbId: 1, imdbId: null }), evidence: async () => ({ names: ['Nowhere'], firstAirDate: '2020-01-01', overview: null }) }), { status: 'unresolved', reason: 'not_on_tvmaze' });

  // Concurrent schedule reads share one request.
  const count = requests.filter(r => r.startsWith('/shows/1505')).length;
  await Promise.all([service.getSchedule(1505), service.getSchedule(1505), service.getSchedule(1505)]);
  assert.equal(requests.filter(r => r.startsWith('/shows/1505')).length, count, 'already cached by the identity lookup');

  // Temporary TVMaze failure: identity lookups fail loudly (reported as unavailable, never as "no match")…
  tvmazeDown = true;
  await assert.rejects(service.resolveIdentity({ tmdbId: 11, externalIds: async () => ({ tvdbId: 81797, imdbId: null }), evidence: noEvidence }));
  // …and a changed show that cannot be re-read keeps its previous copy, marked stale.
  tvmazeDown = false;
  const original = await service.getSchedule(46065);
  tvmazeDown = true;
  // The updates feed itself is down: nothing changes, nothing breaks.
  await service.checkForUpdates(0);
  assert.equal((await service.getSchedule(46065)).stale, false);
  tvmazeDown = false;
  showsById[46065] = { ...showsById[46065] as object, updated: 200 };
  // Feed reachable, show endpoint failing.
  const realShows = { ...showsById };
  delete showsById[46065];
  await service.checkForUpdates(0);
  const kept = await service.getSchedule(46065);
  assert.equal(kept.stale, true);
  assert.deepEqual(kept.episodes, original.episodes, 'the cached schedule is kept during a failure');
  // Recovery clears the stale flag.
  Object.assign(showsById, realShows);
  await service.checkForUpdates(0);
  assert.equal((await service.getSchedule(46065)).stale, false);
  assert.ok(requests.every(r => !r.includes('schedule')), 'broadcast schedule feeds (which carry reruns) are never requested');

  console.log('tvmaze service tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
