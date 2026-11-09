import assert from 'node:assert/strict';
import {
  chooseTitleCorroboratedMatch, decideExternalIdentity, externalsConflict, isReturningWithoutDate, selectScheduledEpisodes,
  type TVMazeEpisode, type TVMazeShow,
} from '../src/services/tvmaze/tvmaze-schedule.model';
import { assembleUpcoming, type ShowOutcome } from '../src/services/upcoming-schedule.model';

const cutoff = '2026-11-08';
const ep = (id: number, season: number | null, number: number | null, airdate: string, extra: Partial<TVMazeEpisode> = {}): TVMazeEpisode =>
  ({ id, season, number, type: 'regular', name: `Episode ${number}`, airdate, airtime: '', airstamp: airdate ? `${airdate}T12:00:00+00:00` : null, runtime: 50, ...extra });

// ---- Identity: external IDs are decisive; One Piece anime and live-action never mix. ----
const anime: TVMazeShow = { id: 1505, name: 'One Piece', premiered: '1999-10-20', status: 'Running', externals: { thetvdb: 81797, imdb: 'tt0388629' }, network: { name: 'Fuji TV' } };
const liveAction: TVMazeShow = { id: 46065, name: 'One Piece', premiered: '2023-08-31', status: 'Running', externals: { thetvdb: 392276, imdb: 'tt11737520' }, webChannel: { name: 'Netflix' } };
{
  const liveExt = { tvdbId: 392276, imdbId: 'tt11737520' };
  const animeExt = { tvdbId: 81797, imdbId: 'tt0388629' };
  assert.deepEqual(decideExternalIdentity(liveExt, [liveAction]), { status: 'verified', tvmazeId: 46065, method: 'external_id' });
  assert.deepEqual(decideExternalIdentity(animeExt, [anime]), { status: 'verified', tvmazeId: 1505, method: 'external_id' });
  // A lookup that lands on the other One Piece (its IMDb ID contradicts TMDB's) is a conflict, not a match.
  assert.deepEqual(decideExternalIdentity({ tvdbId: null, imdbId: 'tt11737520' }, [anime]), { status: 'unresolved', reason: 'external_id_conflict' });
  // TheTVDB and IMDb pointing at two different TVMaze shows: never choose.
  assert.deepEqual(decideExternalIdentity(liveExt, [liveAction, anime]), { status: 'unresolved', reason: 'external_id_conflict' });
  assert.equal(decideExternalIdentity(liveExt, []), null, 'nothing found: caller may try the strict fallback');
  assert.equal(externalsConflict({ externals: { imdb: 'TT11737520' } }, liveExt), false, 'IMDb IDs compare case-insensitively');
  assert.equal(externalsConflict({ externals: null }, liveExt), false, 'missing IDs are not a contradiction');

  // Title fallback needs the same premiere year and date/synopsis evidence: the 2023 series never matches the 1999 anime.
  const evidence2023 = { names: ['One Piece'], firstAirDate: '2023-08-31', overview: null };
  assert.deepEqual(chooseTitleCorroboratedMatch(evidence2023, [anime, liveAction], { tvdbId: null, imdbId: null }), { status: 'verified', tvmazeId: 46065, method: 'title_corroborated' });
  assert.deepEqual(chooseTitleCorroboratedMatch({ names: ['One Piece'], firstAirDate: '1999-10-20', overview: null }, [anime, liveAction], { tvdbId: null, imdbId: null }), { status: 'verified', tvmazeId: 1505, method: 'title_corroborated' });
  // Title alone is never enough.
  assert.deepEqual(chooseTitleCorroboratedMatch({ names: ['One Piece'], firstAirDate: null, overview: null }, [liveAction], { tvdbId: null, imdbId: null }), { status: 'unresolved', reason: 'weak_evidence' });
  assert.deepEqual(chooseTitleCorroboratedMatch({ names: ['One Piece'], firstAirDate: '2023-03-01', overview: 'Unrelated cooking show about bakers.' }, [{ ...liveAction, summary: 'Pirates search for treasure.' }], { tvdbId: null, imdbId: null }), { status: 'unresolved', reason: 'weak_evidence' });
  assert.deepEqual(chooseTitleCorroboratedMatch(evidence2023, [{ ...liveAction, name: 'One Piece: Fan Letter' }], { tvdbId: null, imdbId: null }), { status: 'unresolved', reason: 'not_on_tvmaze' });
  // A candidate whose TheTVDB ID contradicts TMDB's is excluded even with a matching title and date.
  assert.deepEqual(chooseTitleCorroboratedMatch(evidence2023, [liveAction], { tvdbId: 999, imdbId: null }), { status: 'unresolved', reason: 'weak_evidence' });
  // Two equally good candidates (regional productions with the same title and premiere): ambiguous, none chosen.
  assert.deepEqual(chooseTitleCorroboratedMatch(evidence2023, [liveAction, { ...liveAction, id: 77777, externals: null }], { tvdbId: null, imdbId: null }), { status: 'unresolved', reason: 'ambiguous' });
}

// ---- Episode selection: new, dated, regular premieres only. ----
{
  const { episodes, excluded } = selectScheduledEpisodes([
    ep(1, 3, 1, '2026-11-11'), ep(2, 3, 2, '2026-11-11'), ep(3, 3, 3, '2026-11-11'), ep(4, 3, 4, '2026-11-11'), // same-day drop
    ep(5, 3, 5, '2026-11-18'), // a week later
    ep(1, 3, 1, '2026-11-11'), // the same TVMaze episode returned twice
    ep(10, 2, 8, '2026-10-01'), ep(11, 2, 8, '2026-11-20'), // a rebroadcast of an episode that already premiered
    ep(12, 3, 6, '2026-11-01'), // past premiere
    ep(13, 0, 1, '2026-11-12'), ep(14, 3, null, '2026-11-12', { type: 'significant_special' }), // specials
    ep(15, 3, 7, ''), // announced, no date
  ], cutoff);
  assert.deepEqual(episodes.map(e => `${e.season}x${e.number}@${e.airDate}`), ['3x1@2026-11-11', '3x2@2026-11-11', '3x3@2026-11-11', '3x4@2026-11-11', '3x5@2026-11-18']);
  assert.deepEqual(excluded, { specials: 2, past: 2, undated: 1, duplicates: 1, repeats: 1 });
  assert.equal(episodes[0].seasonPremiere, true);
  assert.equal(episodes[1].seasonPremiere, false);
  // Date-only (streaming placeholder stamp, no air time): no time is invented.
  assert.equal(episodes[0].airTime, null);
  assert.equal(episodes[0].airTimestamp, null);
}
{
  // A confirmed broadcast time keeps TVMaze's network date and the exact UTC instant (pages convert to local time).
  const { episodes } = selectScheduledEpisodes([ep(20, 1, 2, '2026-11-11', { airtime: '21:00', airstamp: '2026-11-12T02:00:00+00:00' })], cutoff);
  assert.equal(episodes[0].airDate, '2026-11-11');
  assert.equal(episodes[0].airTime, '21:00');
  assert.equal(episodes[0].airTimestamp, '2026-11-12T02:00:00.000Z');
  // An air time without a usable timestamp is not "confirmed".
  assert.equal(selectScheduledEpisodes([ep(21, 1, 3, '2026-11-12', { airtime: '21:00', airstamp: null })], cutoff).episodes[0].airTimestamp, null);
  assert.equal(selectScheduledEpisodes([ep(22, 1, 4, '2026-11-12', { airtime: 'soon' })], cutoff).episodes[0].airTime, null);
}

// ---- Returning, date TBA ----
assert.equal(isReturningWithoutDate('Running', 0), true);
assert.equal(isReturningWithoutDate('To Be Determined', 0), true);
assert.equal(isReturningWithoutDate('Ended', 0), false, 'ended shows are not returning');
assert.equal(isReturningWithoutDate('Running', 2), false, 'dated releases never also appear as TBA');

// ---- Assembly ----
const libraryShow = (id: string, name: string, status: string | null = 'watching') => ({ id, name, posterURL: null, status });
const scheduled = (show: ReturnType<typeof libraryShow>, tvmaze: TVMazeShow, episodes: TVMazeEpisode[], extra: Partial<Extract<ShowOutcome, { kind: 'scheduled' }>> = {}): ShowOutcome => {
  const selected = selectScheduledEpisodes(episodes, cutoff);
  return { kind: 'scheduled', show, tvmaze, method: 'external_id', tmdbBasis: 'linked', episodes: selected.episodes, excluded: selected.excluded, stale: false, ...extra };
};
{
  const rings: TVMazeShow = { id: 300, name: 'Rings', status: 'Running', network: null, webChannel: { name: 'Prime Video' } };
  const drama: TVMazeShow = { id: 301, name: 'Drama', status: 'Running', network: { name: 'HBO' }, webChannel: null };
  const ended: TVMazeShow = { id: 302, name: 'Over', status: 'Ended', network: { name: 'ABC' } };
  const waiting: TVMazeShow = { id: 303, name: 'Waiting', status: 'Running', network: { name: 'BBC One' } };
  const result = assembleUpcoming([
    scheduled(libraryShow('a', 'Rings'), rings, [ep(1, 3, 1, '2026-11-11'), ep(2, 3, 2, '2026-11-11')]),
    scheduled(libraryShow('b', 'Drama'), drama, [ep(9, 2, 1, '2026-11-10', { airtime: '21:00', airstamp: '2026-11-11T02:00:00+00:00' })]),
    scheduled(libraryShow('c', 'Over'), ended, []),
    scheduled(libraryShow('d', 'Waiting', 'dropped'), waiting, [ep(40, 4, 1, '')]),
    { kind: 'review', show: libraryShow('e', 'Unknown'), reason: 'not_on_tvmaze' },
    { kind: 'unavailable', show: libraryShow('f', 'Offline'), provider: 'TVMaze' },
  ], '2026-11-09T10:00:00.000Z');
  assert.equal(result.source, 'TVMaze');
  assert.ok(result.releases.every(r => r.scheduleSource === 'TVMaze'), 'every dated entry comes from TVMaze');
  assert.deepEqual(result.releases.map(r => r.id), ['301:9', '300:1', '300:2']);
  assert.equal(result.releases[1].streaming, true);
  assert.equal(result.releases[1].channel, 'Prime Video');
  assert.equal(result.releases[0].streaming, false);
  assert.deepEqual(result.returningTba.map(t => [t.showId, t.announcedEpisodes, t.showStatus]), [['d', 1, 'dropped']]);
  assert.deepEqual(result.needsReview.map(r => [r.showId, r.reason]), [['e', 'not_on_tvmaze']]);
  assert.ok(result.needsReview[0].detail.length > 10);
  assert.equal(result.stale, true, 'an unreachable TVMaze show marks the schedule as incomplete');
  assert.deepEqual({ ...result.coverage, excludedEpisodes: undefined }, { evaluatedShows: 6, verifiedShows: 4, verifiedByExternalId: 4, verifiedByTitle: 0, viaScheduleOnlyTMDBMatch: 0, scheduledShows: 2, unresolvedShows: 1, unavailableShows: 1, staleShows: 0, excludedEpisodes: undefined });
}
{
  // Two library entries resolving to the same TVMaze series: both go to review, neither contributes dates.
  const shared: TVMazeShow = { id: 500, name: 'Twin', status: 'Running' };
  const result = assembleUpcoming([scheduled(libraryShow('x', 'Twin'), shared, [ep(1, 1, 1, '2026-12-01')]), scheduled(libraryShow('y', 'Twin (2024)'), shared, [ep(1, 1, 1, '2026-12-01')])], 'now');
  assert.equal(result.releases.length, 0);
  assert.deepEqual(result.needsReview.map(r => r.reason), ['shared_tvmaze_identity', 'shared_tvmaze_identity']);
}
{
  // Stale copy served after a failed refresh is flagged; an empty library is a valid empty schedule.
  const result = assembleUpcoming([scheduled(libraryShow('s', 'Old'), { id: 600, name: 'Old', status: 'Running' }, [ep(1, 1, 1, '2026-12-01')], { stale: true })], 'now');
  assert.equal(result.stale, true);
  assert.equal(result.coverage.staleShows, 1);
  const empty = assembleUpcoming([], 'now');
  assert.deepEqual([empty.releases.length, empty.returningTba.length, empty.needsReview.length, empty.stale], [0, 0, 0, false]);
}

console.log('upcoming schedule tests passed');
