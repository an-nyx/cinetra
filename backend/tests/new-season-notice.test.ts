import assert from 'node:assert/strict';
import { buildTrackingSummary, type Catalog, type TrackedShow, type WatchRecord } from '../src/services/tracking-summary.model';
const today = '2026-11-09';
const episode = (season: number, number: number, airDate: string) => ({ season, number, airDate, name: `Episode ${number}`, airTimestamp: null, runtime: null });
const base: Catalog = { source: 'TMDB', broadcastStatus: 'Returning Series', inProduction: true, nextEpisodeAnnounced: true, seasons: [{ number: 1, episodeCount: 2 }, { number: 2, episodeCount: 2 }], episodes: [episode(1,1,'2020-01-01'),episode(1,2,'2020-01-08'),episode(2,1,'2025-01-01'),episode(2,2,'2025-01-08')] };
const show = (season: number, episodeCount = 0, status: string | null = 'completed'): TrackedShow => ({ id: 'a', name: 'Sample', posterURL: null, status, completed: false, seasonsWatched: season, episodesWatched: episodeCount, completedMonitorFrom: new Date('2023-06-01T00:00:00Z') });
const summary = (s: TrackedShow, c: Catalog = base, watches: WatchRecord[] = []) => buildTrackingSummary(s, c, null, watches, today);
assert.deepEqual(summary(show(2)).newSeasonToWatch?.episodes.map(e => e.number), [1,2]);
assert.equal(summary(show(2)).newSeasonToWatch?.count, 2);
assert.equal(summary({ ...show(2), status: null, completed: true }).newSeasonToWatch?.season, 2);
assert.equal(summary({ ...show(2), status: 'watching', completed: true }).newSeasonToWatch, null);
const explicitAndLegacy: WatchRecord[] = [{ season: 1, episode: 1, watchedAt: new Date('2021-01-01') }, { season: 2, episode: 1, watchedAt: new Date('2025-01-02') }];
assert.equal(summary(show(2),base,explicitAndLegacy).newSeasonToWatch?.count, 1);
const missingPrior = { ...base, seasons: [{ number: 1, episodeCount: 3 }, { number: 2, episodeCount: 2 }] };
assert.equal(summary(show(2),missingPrior).newSeasonToWatch, null);
assert.equal(summary(show(2,0,'dropped')).newSeasonToWatch, null);
assert.equal(summary(show(1,1)).newSeasonToWatch, null); // old incomplete season
assert.equal(summary({ ...show(2), completedMonitorFrom: null }).newSeasonToWatch, null);
assert.equal(summary({ ...show(2), completedMonitorFrom: new Date('2025-02-01T00:00:00Z') }).newSeasonToWatch, null); // ambiguous old season
const future: Catalog = { ...base, episodes: base.episodes.map(e => e.season === 2 ? { ...e, airDate: '2027-01-01' } : e) };
assert.equal(summary(show(2), future).newSeasonToWatch, null);
const cutoff: Catalog = { ...base, episodes: base.episodes.map(e => e.season === 2 ? { ...e, airDate: '2024-01-01' } : e) };
assert.equal(summary(show(2), cutoff).newSeasonToWatch?.season, 2);
const older: Catalog = { ...base, episodes: base.episodes.map(e => e.season === 2 ? { ...e, airDate: '2023-01-01' } : e) };
assert.equal(summary(show(2), older).newSeasonToWatch, null);
const watched: WatchRecord[] = [{ season: 2, episode: 1, watchedAt: new Date('2025-01-02') }];
assert.equal(summary(show(2),base,watched).newSeasonToWatch?.count, 1);
assert.equal(summary(show(2),base,[...watched,{ season: 2, episode: 2, watchedAt: new Date('2025-01-09') }]).newSeasonToWatch, null);
for (const n of [3,4]) {
 const seasons = Array.from({length:n},(_,i)=>({number:i+1,episodeCount:1}));
 const episodes = seasons.map(s=>episode(s.number,1,s.number===n?'2025-01-01':'2020-01-01'));
 const catalog = { ...base,seasons,episodes };
 assert.equal(summary(show(n),catalog).newSeasonToWatch?.season,n);
}
console.log('New-season notice tests passed');
