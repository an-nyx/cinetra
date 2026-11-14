/** Automatic Watching <-> Completed rules (pure). */
import assert from 'node:assert/strict';
import { decideStatus, effectiveStatus, newPremiereSinceCompleted, verifyCompletion, type StatusEpisode, type TVMazeEvidence } from '../src/services/show-status.model';
import type { TVMazeEpisode } from '../src/services/tvmaze/tvmaze-schedule.model';

const now = new Date('2026-12-01T12:00:00Z');
const today = '2026-12-01';
const ep = (season: number, number: number, airDate: string | null, watched = true): StatusEpisode => ({ season, number, airDate, watched });
const season = (s: number, count: number, firstDay: string, watched = true) => Array.from({ length: count }, (_, i) => ep(s, i + 1, new Date(Date.parse(`${firstDay}T00:00:00Z`) + i * 7 * 86_400_000).toISOString().slice(0, 10), watched));
const tv = (season: number, number: number, airdate: string | null, airstamp: string | null = null, type = 'regular', id = season * 1000 + number): TVMazeEpisode => ({ id, season, number, type, airdate, airtime: airstamp ? '21:00' : '', airstamp });
const tvSeason = (s: number, count: number, firstDay: string) => Array.from({ length: count }, (_, i) => { const d = new Date(Date.parse(`${firstDay}T00:00:00Z`) + i * 7 * 86_400_000).toISOString().slice(0, 10); return tv(s, i + 1, d, `${d}T02:00:00Z`); });
const verified = (episodes: TVMazeEpisode[], timeZone: string | null = 'America/New_York'): TVMazeEvidence => ({ kind: 'verified', episodes, timeZone });
const catalog = (seasons: [number, number][], nextEpisode: { season: number; number: number; airDate: string | null } | null = null) => ({ seasons: seasons.map(([number, episodeCount]) => ({ number, episodeCount })), nextEpisode });
const check = (episodes: StatusEpisode[], cat = catalog([[1, 8]]), tvmaze: TVMazeEvidence = verified(tvSeason(1, 8, '2026-09-01')), progressReliable = true) => verifyCompletion({ episodes, catalog: cat, progressReliable, tvmaze, today, now });

// --- Completion -------------------------------------------------------------------------------------------------
const s1 = season(1, 8, '2026-09-01');
assert.deepEqual(check(s1), { complete: true }, 'finished season, all watched');
assert.equal(check([...s1.slice(0, 7), { ...s1[7], watched: false }]).complete, false, '7 of 8 watched');
assert.equal(check([{ ...s1[0], watched: false }, ...s1.slice(1)]).complete, false, 'an earlier released episode unwatched');
// Season still airing: E8 is in the future.
const airing = [...season(1, 7, '2026-10-01'), ep(1, 8, '2026-12-10', false)];
assert.match((check(airing, catalog([[1, 8]], { season: 1, number: 8, airDate: '2026-12-10' })) as { reason: string }).reason, /still airing/);
// TMDB announces more of the same season although the listed episodes are all out.
assert.match((check(s1, catalog([[1, 8]], { season: 1, number: 9, airDate: null })) as { reason: string }).reason, /announces more/);
// Episode list incomplete: TMDB declares 10, lists 8; or one episode undated.
assert.match((check(s1, catalog([[1, 10]])) as { reason: string }).reason, /incomplete/);
assert.equal(check([...s1.slice(0, 7), ep(1, 8, null, false)]).complete, false, 'missing date is never proof the season ended');
assert.equal(check(s1, catalog([[1, 8]]), verified(tvSeason(1, 8, '2026-09-01')), false).complete, false, 'unreliable progress (e.g. saved position conflict)');
// Future season announced but not started: still complete.
const withFuture = [...s1, ...season(2, 6, '2027-03-01', false)];
assert.deepEqual(check(withFuture, catalog([[1, 8], [2, 6]], { season: 2, number: 1, airDate: '2027-03-01' })), { complete: true }, 'announced season 2 does not block');
assert.deepEqual(check([...s1, ep(2, 1, null, false)], catalog([[1, 8], [2, 10]])), { complete: true }, 'season 2 with undated episodes only');
// Specials (season 0) never count.
assert.deepEqual(check([...s1, ep(0, 1, '2026-11-01', false), ep(0, 2, null, false)]), { complete: true });
// TVMaze evidence.
assert.match((check(s1, catalog([[1, 8]]), verified([...tvSeason(1, 8, '2026-09-01'), tv(1, 9, '2026-12-20', '2026-12-21T02:00:00Z')])) as { reason: string }).reason, /unaired/, 'TVMaze lists a future episode');
assert.match((check(s1, catalog([[1, 8]]), verified([...tvSeason(1, 7, '2026-09-01'), tv(1, 8, null)])) as { reason: string }).reason, /unaired/, 'TVMaze lists an undated episode');
assert.match((check(s1, catalog([[1, 8]]), verified(tvSeason(2026, 8, '2026-09-01'))) as { reason: string }).reason, /TVMaze has no season 1/, 'different season numbering: no guessing');
assert.deepEqual(check(s1, catalog([[1, 8]]), verified([...tvSeason(1, 8, '2026-09-01'), tv(1, 3, '2026-12-25', '2026-12-26T02:00:00Z', 'regular', 99)])), { complete: true }, 'a later rerun record of S1E3 is not a new episode');
assert.deepEqual(check(s1, catalog([[1, 8]]), verified([...tvSeason(1, 8, '2026-09-01'), tv(1, 9, '2026-12-20', null, 'significant_special')])), { complete: true }, 'TVMaze specials ignored');
assert.deepEqual(check(s1, catalog([[1, 8]]), { kind: 'not_listed' }), { complete: true }, 'not on TVMaze: TMDB decides');
assert.match((check(s1, catalog([[1, 8]]), { kind: 'unavailable' }) as { reason: string }).reason, /unavailable/, 'TVMaze down or contradictory: no change');
assert.equal(check([]).complete, false); assert.equal(check(s1, null as never).complete, false);
// Multiple seasons: latest released season is what must have finished.
assert.deepEqual(check([...season(1, 4, '2025-01-01'), ...season(2, 4, '2026-09-01')], catalog([[1, 4], [2, 4]]), verified([...tvSeason(1, 4, '2025-01-01'), ...tvSeason(2, 4, '2026-09-01')])), { complete: true });

// --- Reopening --------------------------------------------------------------------------------------------------
const featureSince = new Date('2026-11-14T00:00:00Z');
const completedAt = new Date('2026-11-20T00:00:00Z');
const reopen = (episodes: StatusEpisode[], tvmaze: TVMazeEvidence, completedSince: Date | null = completedAt) => newPremiereSinceCompleted({ episodes, completedSince, tvmaze, today, now, featureSince });
const s2premiere = [...s1, ep(2, 1, '2026-12-01', false), ep(2, 2, '2026-12-08', false)];
const tvS2 = verified([...tvSeason(1, 8, '2026-09-01'), tv(2, 1, '2026-11-30', '2026-12-01T02:00:00Z'), tv(2, 2, '2026-12-07', '2026-12-08T02:00:00Z')]);
assert.deepEqual(reopen(s2premiere, tvS2), { reopen: true, season: 2, number: 1 }, 'verified premiere of S2E1');
assert.equal(reopen([...s1, ep(2, 1, '2026-12-01', true)], tvS2).reopen, false, 'already watched');
assert.equal(reopen([...s1, ep(2, 1, '2027-01-01', false)], tvS2).reopen, false, 'announced only');
assert.equal(reopen(s2premiere, verified([...tvSeason(1, 8, '2026-09-01'), tv(2, 1, '2026-12-01', '2026-12-02T02:00:00Z')])).reopen, false, 'TMDB says today, TVMaze premiere still ahead: wait');
assert.equal(reopen(s2premiere, verified(tvSeason(1, 8, '2026-09-01'))).reopen, false, 'TVMaze does not list it: no guessing');
assert.equal(reopen(s2premiere, verified([...tvSeason(1, 8, '2026-09-01'), tv(2, 1, '2026-11-30', '2026-12-01T02:00:00Z'), tv(2, 1, '2026-11-30', '2026-12-01T02:00:00Z', 'regular', 5)])).reopen, false, 'listed twice: ambiguous');
assert.equal(reopen(s2premiere, { kind: 'unavailable' }).reopen, false);
assert.equal(reopen([...s1, ep(2, 1, '2026-11-25', false)], { kind: 'not_listed' }).reopen, true, 'TMDB only, day long over');
assert.equal(reopen(s2premiere, { kind: 'not_listed' }).reopen, false, 'TMDB only, listed day not over everywhere yet');
// History: episodes out before the show was completed, or before automatic statuses existed, never reopen.
assert.equal(reopen([...s1, ep(2, 1, '2026-11-18', false)], verified([...tvSeason(1, 8, '2026-09-01'), tv(2, 1, '2026-11-17', '2026-11-18T02:00:00Z')])).reopen, false, 'premiered before completion');
assert.equal(reopen([...s1, ep(2, 1, '2026-11-10', false)], verified([...tvSeason(1, 8, '2026-09-01'), tv(2, 1, '2026-11-09', '2026-11-10T02:00:00Z')]), null).reopen, false, 'before the feature existed');
assert.equal(reopen([...s1, ep(0, 3, '2026-12-01', false)], tvS2).reopen, false, 'specials never reopen');

// --- Decisions: only Watching <-> Completed ---------------------------------------------------------------------
const done = { complete: true } as const; const notDone = { complete: false, reason: 'x' } as const;
const yes = { reopen: true, season: 2, number: 1 } as const; const no = { reopen: false, reason: 'x' } as const;
assert.equal(decideStatus({ status: 'watching', completion: done, reopen: no })?.to, 'completed');
assert.equal(decideStatus({ status: 'watching', completion: notDone, reopen: yes }), null);
assert.equal(decideStatus({ status: 'completed', completion: done, reopen: yes })?.to, 'watching');
assert.equal(decideStatus({ status: 'completed', completion: notDone, reopen: no }), null, 'manual Completed with gaps is left alone');
assert.equal(decideStatus({ status: 'completed', completion: notDone, reopen: no, brokeCompletion: true })?.to, 'watching', 'the user just unmarked an episode');
assert.equal(decideStatus({ status: 'completed', completion: done, reopen: no, brokeCompletion: true }), null);
for (const status of ['dropped', 'paused', 'planned', null]) {
  assert.equal(decideStatus({ status, completion: done, reopen: yes, brokeCompletion: true }), null, `${status} never changes`);
}
assert.equal(effectiveStatus({ status: null, completed: true }), 'completed', 'legacy completed flag');
assert.equal(effectiveStatus({ status: 'dropped', completed: true }), 'dropped');
console.log('Show status rule tests passed');
