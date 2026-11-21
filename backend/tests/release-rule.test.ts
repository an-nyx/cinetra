/**
 * Episode release eligibility (release-rule.model.ts) and its effect on every tracking path: Home/Shows summaries,
 * the Watch Room guide, effective watched counts, legacy checkpoint coverage and unwatch exceptions, plus the
 * automatic status rules, which must stay exactly as safe as before.
 *
 * TVMaze records are copied from the live TVMaze API (2026-11-21 audit); TMDB counts match production's catalog.
 */
import assert from 'node:assert/strict';
import { assignReleaseTimes, instantOf, isEpisodeReleased, tmdbReleaseAt } from '../src/services/release-rule.model';
import { buildTrackingSummary, catalogFromTMDB, mergeShowEpisodes, withReleaseTimes, type Catalog, type TrackedShow, type WatchRecord, type UnwatchRecord } from '../src/services/tracking-summary.model';
import { calculateLegacyCoverage, calculateTrackingProgress, episodeKey } from '../src/services/legacy-progress.model';
import { decideStatus, verifiedCoverage, verifiedUnwatchedPremiere, verifyCompletion, type TVMazeEvidence } from '../src/services/show-status.model';
import type { TVMazeEpisode, TVMazeShow } from '../src/services/tvmaze/tvmaze-schedule.model';

type Ep = [season: number, number: number, airDate: string | null];
const run = (name: string, fn: () => void) => { fn(); console.log(`ok - ${name}`); };

function tmdbCatalog(episodes: Ep[], status = 'Returning Series'): Catalog {
  const numbers = [...new Set(episodes.map(([s]) => s))].sort((a, b) => a - b);
  const details = {
    name: 'Series', status, in_production: status !== 'Ended', next_episode_to_air: null,
    seasons: numbers.map(n => ({ season_number: n, episode_count: episodes.filter(([s]) => s === n).length, air_date: episodes.find(([s]) => s === n)?.[2] ?? null })),
  };
  const pages = numbers.map(n => ({ season: n, data: { episodes: episodes.filter(([s]) => s === n).map(([, number, air_date]) => ({ episode_number: number, name: `E${number}`, air_date })) } }));
  return catalogFromTMDB(details, pages, '2020-01-01');
}
const seasonOf = (season: number, dates: (string | null)[]): Ep[] => dates.map((d, i) => [season, i + 1, d]);
const weekly = (season: number, first: string, count: number, everyDays = 7): Ep[] =>
  Array.from({ length: count }, (_, i) => [season, i + 1, new Date(Date.parse(`${first}T00:00:00Z`) + i * everyDays * 86_400_000).toISOString().slice(0, 10)]);
const tv = (id: number, season: number, number: number, airdate: string | null, airtime = '', airstamp: string | null = null, type = 'regular'): TVMazeEpisode =>
  ({ id, season, number, type, name: `E${number}`, airdate, airtime, airstamp: airstamp ?? (airdate ? `${airdate}T12:00:00+00:00` : null), runtime: 60 });
const network = (name: string, timezone: string | null): Pick<TVMazeShow, 'network' | 'webChannel'> => ({ network: { name, country: timezone ? { timezone } : null }, webChannel: null });
const webChannel = (name: string): Pick<TVMazeShow, 'network' | 'webChannel'> => ({ network: null, webChannel: { name, country: null } });
const show = (seasonsWatched: number, episodesWatched: number, status = 'watching'): TrackedShow => ({ id: 'show', name: 'Series', posterURL: null, status, completed: status === 'completed', seasonsWatched, episodesWatched });
const watched = (season: number, numbers: number[]): WatchRecord[] => numbers.map(n => ({ season, episode: n, watchedAt: new Date('2026-11-20T20:00:00Z') }));
const code = (e: { season: number; number: number } | null) => e ? `S${String(e.season).padStart(2, '0')}E${String(e.number).padStart(2, '0')}` : null;
const releaseOf = (catalog: Catalog, season: number, number: number) => catalog.episodes.find(e => e.season === season && e.number === number)!;
/** The previous rule, for before/after comparisons: released from 00:00 UTC on the TMDB date. */
const oldRule = (catalog: Catalog): Catalog => ({ ...catalog, episodes: catalog.episodes.map(e => ({ ...e, releaseAt: e.airDate ? `${e.airDate}T00:00:00.000Z` : null })) });

// ---------------------------------------------------------------------------------------------------------------
// The Gilded Age (HBO, Sundays 21:00 America/New_York). S04E04: TMDB 2026-11-22; airs 2026-11-23T02:00Z.
const gildedTmdb: Ep[] = [...weekly(1, '2022-01-24', 9), ...weekly(2, '2023-10-29', 8), ...weekly(3, '2025-06-22', 8), ...weekly(4, '2026-11-01', 8)];
const gildedTv = [
  tv(3713680, 4, 1, '2026-11-01', '21:00', '2026-11-02T02:00:00+00:00'), tv(3801169, 4, 2, '2026-11-08', '21:00', '2026-11-09T02:00:00+00:00'),
  tv(3803489, 4, 3, '2026-11-15', '21:00', '2026-11-16T02:00:00+00:00'), tv(3808839, 4, 4, '2026-11-22', '21:00', '2026-11-23T02:00:00+00:00'),
  tv(3808840, 4, 5, '2026-11-29', '21:00', '2026-11-30T02:00:00+00:00'), tv(3808841, 4, 6, '2026-12-06', '21:00', '2026-12-07T02:00:00+00:00'),
  tv(3808842, 4, 7, '2026-12-13', '21:00', '2026-12-14T02:00:00+00:00'), tv(3808843, 4, 8, '2026-12-20', '21:00', '2026-12-21T02:00:00+00:00'),
];
const gilded = withReleaseTimes(tmdbCatalog(gildedTmdb), { show: network('HBO', 'America/New_York'), episodes: gildedTv }, 34685);

run('The Gilded Age S04E04 is released at its real premiere, not at 00:00 UTC on its TMDB date', () => {
  const e4 = releaseOf(gilded, 4, 4);
  assert.equal(gilded.releaseTiming?.source, 'tvmaze');
  assert.deepEqual([e4.airDate, e4.releaseAt, e4.releaseSource], ['2026-11-22', '2026-11-23T02:00:00.000Z', 'tvmaze_exact']);
  assert.equal(isEpisodeReleased(releaseOf(oldRule(gilded), 4, 4), '2026-11-22T00:00:00Z'), true, 'the old rule released it 26 h early');
  assert.equal(isEpisodeReleased(e4, '2026-11-22T00:00:00Z'), false);
  assert.equal(isEpisodeReleased(e4, '2026-11-23T01:59:59.999Z'), false);
  assert.equal(isEpisodeReleased(e4, '2026-11-23T02:00:00.000Z'), true);
  // Without a verified TVMaze schedule the TMDB fallback is later still, never earlier.
  const fallback = releaseOf(withReleaseTimes(tmdbCatalog(gildedTmdb), null, null, 'TVMaze schedule is stale'), 4, 4);
  assert.deepEqual([fallback.releaseAt, fallback.releaseSource], ['2026-11-23T12:00:00.000Z', 'tmdb_date']);
});

run('The Gilded Age: Home, Shows and Watch Room agree before and after S04E04 premieres (caught up at S04E03)', () => {
  const user = show(4, 3);
  const before = buildTrackingSummary(user, gilded, null, [], '2026-11-22T12:00:00.000Z');
  assert.deepEqual([before.releasedCount, before.watchedCount, before.remainingCount, before.progressPercent, before.viewingState, code(before.nextEpisode), code(before.upcomingEpisode), before.newEpisodes],
    [28, 28, 0, 100, 'caught_up', null, 'S04E04', 0]);
  const guideBefore = mergeShowEpisodes(user, gilded, [], '2026-11-22T12:00:00.000Z').episodes.filter(e => e.season === 4);
  assert.deepEqual(guideBefore.filter(e => isEpisodeReleased(e, '2026-11-22T12:00:00.000Z')).map(e => e.number), [1, 2, 3], 'Watch Room: E4 not markable yet');
  const after = buildTrackingSummary(user, gilded, null, [], '2026-11-23T02:00:00.000Z');
  assert.deepEqual([after.releasedCount, after.watchedCount, after.remainingCount, after.progressPercent, after.viewingState, code(after.nextEpisode), code(after.upcomingEpisode), after.newEpisodes],
    [29, 28, 1, 97, 'in_progress', 'S04E04', 'S04E05', 1]);
  // The old rule would already have shown S04E04 as the next episode on Home 26 hours before it aired.
  const oldBefore = buildTrackingSummary(user, oldRule(gilded), null, [], '2026-11-22T12:00:00.000Z');
  assert.equal(code(oldBefore.nextEpisode), 'S04E04');
});

// ---------------------------------------------------------------------------------------------------------------
// The Rings of Power (Prime Video, date-only streaming drops, no channel time zone on TVMaze).
const ropTmdb: Ep[] = [...weekly(1, '2022-09-01', 8), ...weekly(2, '2024-08-29', 8), ...seasonOf(3, ['2026-11-11', '2026-11-11', '2026-11-11', '2026-11-11', '2026-11-18', '2026-11-18', '2026-11-25', '2026-11-25'])];
const ropTv = [
  tv(3615601, 3, 1, '2026-11-11'), tv(3682718, 3, 2, '2026-11-11'), tv(3682719, 3, 3, '2026-11-11'), tv(3682720, 3, 4, '2026-11-11'),
  tv(3682721, 3, 5, '2026-11-18'), tv(3682722, 3, 6, '2026-11-18'), tv(3682723, 3, 7, '2026-11-25'), tv(3682724, 3, 8, '2026-11-25'),
];
const rop = withReleaseTimes(tmdbCatalog(ropTmdb), { show: webChannel('Prime Video'), episodes: ropTv }, 33352);

run('The Rings of Power S03E07–E08: unreleased now, released once 2026-11-25 has ended everywhere', () => {
  for (const n of [7, 8]) {
    const e = releaseOf(rop, 3, n);
    // TVMaze lists a date only (its 12:00 UTC airstamp is a placeholder without an air time) and no time zone.
    assert.deepEqual([e.airDate, e.releaseAt, e.releaseSource], ['2026-11-25', '2026-11-26T12:00:00.000Z', 'tvmaze_date_worldwide']);
    assert.equal(isEpisodeReleased(e, '2026-11-21T14:19:40Z'), false);
    assert.equal(isEpisodeReleased(e, '2026-11-25T12:00:00Z'), false, 'conservative: the exact drop time is not published');
    assert.equal(isEpisodeReleased(e, '2026-11-26T12:00:00Z'), true);
  }
  // Production's numbers at audit time (saved position S02E08): 22 released, 16 watched, next S03E01, upcoming S03E07.
  const summary = buildTrackingSummary(show(2, 8), rop, null, [], '2026-11-21T14:19:40Z');
  assert.deepEqual([summary.releasedCount, summary.watchedCount, summary.remainingCount, code(summary.nextEpisode), code(summary.upcomingEpisode), summary.upcomingEpisode?.airDate],
    [22, 16, 6, 'S03E01', 'S03E07', '2026-11-25']);
  const later = buildTrackingSummary(show(2, 8), rop, null, [], '2026-11-26T12:00:00Z');
  assert.deepEqual([later.releasedCount, later.remainingCount, later.upcomingEpisode], [24, 8, null]);
});

// ---------------------------------------------------------------------------------------------------------------
// House of the Dragon (HBO). S03E07 2026-08-02 and S03E08 2026-08-09 aired long ago.
const hotdTmdb: Ep[] = [...weekly(1, '2022-08-21', 10), ...weekly(2, '2024-06-16', 8), ...weekly(3, '2026-06-21', 8)];
const hotdTv = weekly(3, '2026-06-21', 8).map(([s, n, d], i) => tv(3605061 + i, s, n, d!, '21:00', new Date(Date.parse(`${d}T21:00:00-04:00`)).toISOString()));
// The production schedule cache keeps only number and date for episodes older than three days.
const hotdTrimmed = hotdTv.map(({ id, season, number, type, airdate }) => ({ id, season, number, type, airdate }));

run('House of the Dragon S03E07–E08 are released (full and trimmed TVMaze records)', () => {
  const full = withReleaseTimes(tmdbCatalog(hotdTmdb), { show: network('HBO', 'America/New_York'), episodes: hotdTv }, 44778);
  assert.deepEqual([releaseOf(full, 3, 7).releaseAt, releaseOf(full, 3, 8).releaseAt], ['2026-08-03T01:00:00.000Z', '2026-08-10T01:00:00.000Z']);
  const trimmed = withReleaseTimes(tmdbCatalog(hotdTmdb), { show: network('HBO', 'America/New_York'), episodes: hotdTrimmed }, 44778);
  // Date only: the day has ended in New York (EDT, UTC-4).
  assert.deepEqual([releaseOf(trimmed, 3, 7).releaseAt, releaseOf(trimmed, 3, 7).releaseSource], ['2026-08-03T04:00:00.000Z', 'tvmaze_date_local']);
  for (const catalog of [full, trimmed]) {
    // Production: saved position S03E00 plus explicit S03E01–E06 → 26 released, 24 watched, next S03E07.
    const summary = buildTrackingSummary(show(3, 0), catalog, null, watched(3, [1, 2, 3, 4, 5, 6]), '2026-11-21T14:19:40Z');
    assert.deepEqual([summary.releasedCount, summary.watchedCount, summary.remainingCount, code(summary.nextEpisode), summary.upcomingEpisode], [26, 24, 2, 'S03E07', null]);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Nocturne (Apple TV): TMDB lists the US Thursday-evening date, TVMaze the Friday; for S01E06 TVMaze says Wednesday
// 2026-11-25 while TMDB says Thursday 2026-11-26 (Apple announced Fridays). Conflicting dates never use TVMaze.
const nocturneTmdb: Ep[] = seasonOf(1, ['2026-10-29', '2026-10-29', '2026-11-05', '2026-11-12', '2026-11-19', '2026-11-26', '2026-12-03', '2026-12-10', '2026-12-17', '2026-12-24']);
const nocturneTv = ['2026-10-30', '2026-10-30', '2026-11-06', '2026-11-13', '2026-11-20', '2026-11-25', '2026-12-04', '2026-12-11', '2026-12-18', '2026-12-25'].map((d, i) => tv(3665755 + i, 1, i + 1, d));
const nocturne = withReleaseTimes(tmdbCatalog(nocturneTmdb), { show: webChannel('Apple TV'), episodes: nocturneTv }, 66811);

run('Nocturne: conflicting premiere dates fall back to the TMDB date, never the earlier TVMaze date', () => {
  for (const e of nocturne.episodes) assert.equal(e.releaseSource, 'tmdb_date', `S01E${e.number}`);
  const e6 = releaseOf(nocturne, 1, 6);
  assert.equal(e6.releaseAt, '2026-11-27T12:00:00.000Z');
  // TVMaze's own date-only rule would release it on 2026-11-26T12:00Z; that is not trusted.
  assert.equal(isEpisodeReleased(e6, '2026-11-26T12:00:00Z'), false);
  assert.equal(isEpisodeReleased(e6, '2026-11-27T12:00:00Z'), true);
  assert.equal(releaseOf(nocturne, 1, 5).releaseAt, '2026-11-20T12:00:00.000Z');
  const summary = buildTrackingSummary(show(0, 0), nocturne, null, [], '2026-11-21T14:19:40Z');
  assert.deepEqual([summary.releasedCount, code(summary.nextEpisode), code(summary.upcomingEpisode)], [5, 'S01E01', 'S01E06']);
  assert.equal(summary.viewingState, 'not_started');
});

// ---------------------------------------------------------------------------------------------------------------
run('Legacy checkpoints: an unreleased episode inside a saved position is not covered and needs review', () => {
  const position = show(4, 4); // saved position S04E04, set before E4 premiered
  const early = calculateLegacyCoverage(4, 4, gilded, '2026-11-22T12:00:00.000Z');
  assert.equal(early.covered.has(episodeKey(4, 4)), false);
  assert.equal(early.needsReview, true);
  const old = calculateLegacyCoverage(4, 4, oldRule(gilded), '2026-11-22T12:00:00.000Z');
  assert.deepEqual([old.covered.has(episodeKey(4, 4)), old.needsReview], [true, false], 'the old rule covered it early');
  const summaryEarly = buildTrackingSummary(position, gilded, null, [], '2026-11-22T12:00:00.000Z');
  assert.deepEqual([summaryEarly.progressPercent, summaryEarly.progressUnavailable?.code, summaryEarly.legacyPosition?.needsReview, summaryEarly.legacyPosition?.fullSeasons, summaryEarly.legacyPosition?.episodesInNextSeason],
    [null, 'saved_position_conflict', true, 4, 4], 'the stored position is reported unchanged');
  const onAir = calculateLegacyCoverage(4, 4, gilded, '2026-11-23T02:00:00.000Z');
  assert.deepEqual([onAir.covered.has(episodeKey(4, 4)), onAir.needsReview], [true, false]);
  const summaryAfter = buildTrackingSummary(position, gilded, null, [], '2026-11-23T02:00:00.000Z');
  assert.deepEqual([summaryAfter.releasedCount, summaryAfter.watchedCount, summaryAfter.progressPercent, summaryAfter.viewingState], [29, 29, 100, 'caught_up']);
});

run('Unwatch exceptions keep working on both sides of a premiere', () => {
  const user = show(4, 3);
  const unwatches: UnwatchRecord[] = [{ season: 4, episode: 2 }];
  for (const [at, released, remaining, next] of [['2026-11-22T12:00:00.000Z', 28, 1, 'S04E02'], ['2026-11-23T02:00:00.000Z', 29, 2, 'S04E02']] as const) {
    const summary = buildTrackingSummary(user, gilded, null, [], at, null, unwatches);
    assert.deepEqual([summary.releasedCount, summary.watchedCount, summary.remainingCount, code(summary.nextEpisode)], [released, 27, remaining, next], at);
    const guide = mergeShowEpisodes(user, gilded, [], at, unwatches).episodes.filter(e => e.season === 4);
    assert.deepEqual(guide.filter(e => e.watched).map(e => e.number), [1, 3], `${at}: E2 stays explicitly unwatched`);
  }
  // An explicit record of the not-yet-released episode (only possible through old data) is never counted as released progress.
  const summary = buildTrackingSummary(user, gilded, null, watched(4, [4]), '2026-11-22T12:00:00.000Z');
  assert.deepEqual([summary.releasedCount, summary.watchedCount, summary.remainingCount], [28, 28, 0]);
});

// ---------------------------------------------------------------------------------------------------------------
run('Ambiguous TVMaze numbering: Attack on Titan (split finale) uses TMDB dates only', () => {
  const tmdb = tmdbCatalog([...weekly(1, '2013-04-07', 25), ...weekly(2, '2017-04-01', 12), ...weekly(3, '2018-07-23', 22), ...weekly(4, '2020-12-07', 28)]);
  const tvEpisodes = [...weekly(4, '2020-12-07', 28).map(([s, n, d], i) => tv(2000000 + i, s, n, d!, '00:10', `${d}T15:10:00+00:00`)),
    tv(2474146, 4, 29, '2023-03-04', '00:10', '2023-03-04T15:10:00+00:00'), tv(2643610, 4, 30, '2023-11-05', '00:10', '2023-11-05T15:10:00+00:00')];
  const { episodes, timing } = assignReleaseTimes(tmdb.episodes, { show: network('NHK', 'Asia/Tokyo'), episodes: tvEpisodes }, 919);
  assert.equal(timing.source, 'tmdb_only');
  assert.match(timing.reason, /S4E29 is not on TMDB/);
  assert.ok(episodes.every(e => e.releaseSource === 'tmdb_date'));
  assert.equal(episodes.length, 87);
});

run('Ambiguous TVMaze numbering: Money Heist (parts vs seasons) uses TMDB dates only', () => {
  const tmdb = tmdbCatalog([...weekly(1, '2017-05-02', 15), ...seasonOf(2, Array(16).fill('2018-04-06')), ...seasonOf(3, [...Array(5).fill('2021-09-03'), ...Array(5).fill('2021-12-03')])]);
  const tvEpisodes = [...weekly(1, '2017-05-02', 15).map(([s, n, d], i) => tv(1150962 + i, s, n, d!, '22:45', `${d}T20:45:00+00:00`)),
    ...seasonOf(3, Array(8).fill('2019-07-19')).map(([s, n, d], i) => tv(1633048 + i, s, n, d!)),
    ...seasonOf(4, Array(8).fill('2020-04-03')).map(([s, n, d], i) => tv(1771237 + i, s, n, d!)),
    ...seasonOf(5, [...Array(5).fill('2021-09-03'), ...Array(5).fill('2021-12-03')]).map(([s, n, d], i) => tv(2098578 + i, s, n, d!))];
  const all = assignReleaseTimes(tmdb.episodes, { show: webChannel('Netflix'), episodes: tvEpisodes }, 27436);
  assert.equal(all.timing.source, 'tmdb_only');
  assert.ok(all.episodes.every(e => e.releaseSource === 'tmdb_date'));
  // Even when TVMaze's numbers all exist on TMDB, a season that means something else is caught by its dates.
  const subset = assignReleaseTimes(tmdb.episodes, { show: webChannel('Netflix'), episodes: tvEpisodes.filter(e => e.season !== 4 && e.season !== 5) }, 27436);
  assert.ok(subset.episodes.filter(e => e.season === 3).every(e => e.releaseSource === 'tmdb_date'), 'TMDB S3 (2021) is not TVMaze S3 (2019)');
});

run('Duplicate numbers, duplicate records, specials and reruns', () => {
  const tmdb = tmdbCatalog(seasonOf(1, ['2026-11-01', '2026-11-08', '2026-11-15']));
  const records = [tv(1, 1, 1, '2026-11-01', '21:00', '2026-11-02T02:00:00+00:00'), tv(1, 1, 1, '2026-11-01', '21:00', '2026-11-02T02:00:00+00:00'),
    tv(2, 1, 2, '2026-11-08', '21:00', '2026-11-09T02:00:00+00:00'), tv(9, 1, 2, '2026-11-08', '23:00', '2026-11-09T04:00:00+00:00'),
    tv(3, 1, 3, '2026-11-15', '21:00', '2026-11-16T02:00:00+00:00'), { ...tv(4, 1, 0, '2026-11-10'), number: null, type: 'significant_special' }];
  const { episodes, timing } = assignReleaseTimes(tmdb.episodes, { show: network('HBO', 'America/New_York'), episodes: records }, 1);
  assert.equal(timing.source, 'tvmaze');
  assert.deepEqual(episodes.map(e => e.releaseSource), ['tvmaze_exact', 'tmdb_date', 'tvmaze_exact'], 'same ID once; two records for one number (rerun) are not trusted; specials ignored');
});

// ---------------------------------------------------------------------------------------------------------------
run('Date-only premieres, time zones, DST and the fallback boundary', () => {
  const one = (airDate: string | null, record: TVMazeEpisode | null, channel = network('ABC', 'America/New_York')) =>
    assignReleaseTimes([{ season: 1, number: 1, airDate }], record ? { show: channel, episodes: [record] } : null).episodes[0];
  assert.equal(one('2026-11-25', tv(1, 1, 1, '2026-11-25')).releaseAt, '2026-11-26T05:00:00.000Z', 'EST: day ends 05:00 UTC');
  assert.equal(one('2026-07-15', tv(1, 1, 1, '2026-07-15')).releaseAt, '2026-07-16T04:00:00.000Z', 'EDT: day ends 04:00 UTC');
  assert.equal(one('2026-11-25', tv(1, 1, 1, '2026-11-25'), network('BBC One', 'Europe/London')).releaseAt, '2026-11-26T00:00:00.000Z');
  // Late-night Japanese premiere: local date 2026-11-22, 00:10 JST, which is still 2026-11-21 in UTC. That is the real premiere.
  assert.equal(one('2026-11-22', tv(1, 1, 1, '2026-11-22', '00:10', '2026-11-21T15:10:00+00:00'), network('NHK', 'Asia/Tokyo')).releaseAt, '2026-11-21T15:10:00.000Z');
  // An airstamp that contradicts its own date is not trusted.
  assert.equal(one('2026-11-22', tv(1, 1, 1, '2026-11-22', '21:00', '2026-11-25T02:00:00+00:00')).releaseSource, 'tmdb_date');
  // Missing TMDB date: never released, whatever TVMaze says.
  const undated = one(null, tv(1, 1, 1, '2020-01-01', '21:00', '2020-01-02T02:00:00+00:00'));
  assert.deepEqual([undated.releaseAt, undated.releaseSource], [null, null]);
  assert.equal(isEpisodeReleased({ airDate: null, releaseAt: '2020-01-01T00:00:00.000Z' }, '2026-11-21T00:00:00Z'), false);
  assert.equal(tmdbReleaseAt('2026-13-45'), null);
  assert.equal(tmdbReleaseAt('not a date'), null);
  // The TMDB fallback boundary: day D has ended everywhere on Earth at D+1 12:00 UTC.
  assert.equal(tmdbReleaseAt('2026-11-22'), '2026-11-23T12:00:00.000Z');
  assert.equal(isEpisodeReleased({ airDate: '2026-11-22' }, '2026-11-23T11:59:59.999Z'), false);
  assert.equal(isEpisodeReleased({ airDate: '2026-11-22' }, '2026-11-23T12:00:00.000Z'), true);
  assert.equal(isEpisodeReleased({ airDate: '2026-11-22' }, new Date('2026-11-24T00:00:00Z')), true);
  // A bare date is the start of that UTC day.
  assert.equal(instantOf('2026-11-22'), '2026-11-22T00:00:00.000Z');
  assert.equal(isEpisodeReleased({ airDate: '2026-11-20' }, '2026-11-22'), true);
  assert.equal(isEpisodeReleased({ airDate: '2026-11-21' }, '2026-11-22'), false);
  // Catalogs cached before this change carry no releaseAt: the fallback applies.
  assert.equal(isEpisodeReleased({ airDate: '2026-11-22' } as { airDate: string; releaseAt?: string }, '2026-11-23T02:00:00Z'), false);
});

run('Streaming placeholders: TVMaze airstamps without an air time are never used as release times', () => {
  // Global streamers on TVMaze (Netflix, Prime Video, Apple TV, Disney+, Paramount+) list no air time and no channel
  // time zone; their airstamps (12:00, 16:00, 17:00, 03:00 UTC …) are placeholders, not announced release moments.
  for (const placeholder of ['12:00', '16:00', '17:00', '03:00', '11:00']) {
    const [episode] = assignReleaseTimes([{ season: 1, number: 1, airDate: '2026-11-25' }],
      { show: webChannel('Prime Video'), episodes: [tv(1, 1, 1, '2026-11-25', '', `2026-11-25T${placeholder}:00+00:00`)] }).episodes;
    assert.deepEqual([episode.releaseAt, episode.releaseSource], ['2026-11-26T12:00:00.000Z', 'tvmaze_date_worldwide'], placeholder);
  }
  // A streaming episode TVMaze does time (an original broadcast airing it hosts) keeps its exact airstamp.
  const [timed] = assignReleaseTimes([{ season: 2, number: 22, airDate: '2018-05-16' }],
    { show: webChannel('Netflix'), episodes: [tv(9, 2, 22, '2018-05-16', '22:00', '2018-05-17T02:00:00+00:00')] }).episodes;
  assert.deepEqual([timed.releaseAt, timed.releaseSource], ['2018-05-17T02:00:00.000Z', 'tvmaze_exact']);
});

// ---------------------------------------------------------------------------------------------------------------
// Automatic statuses keep their own TVMaze verification (show-status.model.ts is unchanged). Their input (merged
// episodes, progress) now follows the new rule; transitions must stay identical or more conservative.
const gildedTvEarlier = gildedTmdb.filter(([s]) => s < 4).map(([s, n, d], i) => tv(100 + i, s, n, d!, '21:00', new Date(Date.parse(`${d}T21:00:00-05:00`)).toISOString()));
const evidence: TVMazeEvidence = { kind: 'verified', tvmazeId: 34685, episodes: [...gildedTvEarlier, ...gildedTv], timeZone: 'America/New_York' };
function statusDecision(catalog: Catalog, user: TrackedShow, records: WatchRecord[], at: string) {
  const { legacy, episodes } = mergeShowEpisodes(user, catalog, records, at);
  const progress = calculateTrackingProgress(episodes, catalog, legacy.needsReview, 'returning', true, false, at, true);
  const today = at.slice(0, 10); const now = new Date(at);
  const completion = verifyCompletion({ episodes, catalog: { seasons: catalog.seasons, nextEpisode: null }, progressReliable: progress.progressReliable, tvmaze: evidence, today, now });
  const reopen = verifiedUnwatchedPremiere({ episodes, tvmaze: evidence, today, now });
  const coverage = verifiedCoverage({ episodes, tvmaze: evidence, today, now });
  return { transition: decideStatus({ status: user.status, completion, reopen }), progressReliable: progress.progressReliable, coverageReason: coverage.reason };
}

run('Automatic statuses: no transition before the premiere, the same verified transitions after it', () => {
  const allBeforeE4 = [...watched(1, [1, 2, 3, 4, 5, 6, 7, 8, 9]), ...watched(2, [1, 2, 3, 4, 5, 6, 7, 8]), ...watched(3, [1, 2, 3, 4, 5, 6, 7, 8]), ...watched(4, [1, 2, 3])];
  for (const status of ['watching', 'completed']) {
    const user = show(0, 0, status);
    for (const catalog of [gilded, oldRule(gilded)]) {
      // Inside the old early window (after 00:00 UTC on the TMDB date, before the airing): never a write.
      const window = statusDecision(catalog, user, allBeforeE4, '2026-11-22T12:00:00.000Z');
      assert.equal(window.transition, null, `${status}: no transition inside the window`);
    }
    // After the real premiere, a Completed show with an unwatched new episode reopens; a Watching show stays.
    const after = statusDecision(gilded, user, allBeforeE4, '2026-11-23T03:00:00.000Z');
    const afterOld = statusDecision(oldRule(gilded), user, allBeforeE4, '2026-11-23T03:00:00.000Z');
    assert.deepEqual(after.transition, afterOld.transition, `${status}: identical decision once released under both rules`);
    assert.deepEqual(after.transition, status === 'completed' ? { from: 'completed', to: 'watching', reason: 'S4E4 is verified released and unwatched' } : null);
  }
});

run('Automatic statuses: a saved position covering an unaired episode blocks writes (needs review)', () => {
  const decision = statusDecision(gilded, show(4, 4, 'completed'), [], '2026-11-22T12:00:00.000Z');
  assert.equal(decision.progressReliable, false, 'the service turns this into an evidence issue: nothing is written');
  assert.equal(decision.transition, null);
});

run('Automatic statuses: Money Heist-style numbering stays blocked', () => {
  const tmdb = tmdbCatalog(weekly(1, '2026-10-01', 3), 'Ended');
  const conflicting: TVMazeEvidence = { kind: 'verified', episodes: [tv(1, 1, 1, '2026-10-01'), tv(2, 1, 2, '2026-10-08'), tv(3, 1, 3, '2026-10-15'), tv(4, 2, 1, '2026-10-22')], timeZone: null };
  const { episodes } = mergeShowEpisodes(show(2, 0, 'watching'), tmdb, [], '2026-11-21T00:00:00Z');
  assert.match(String(verifiedCoverage({ episodes, tvmaze: conflicting, today: '2026-11-21', now: new Date('2026-11-21T00:00:00Z') }).reason), /Cannot reconcile released TVMaze S2E1/);
});

console.log('release rule tests passed');
