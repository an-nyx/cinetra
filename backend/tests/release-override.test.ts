/**
 * Manual premiere-time overrides (release-override.model.ts) and their place in the shared release rule.
 * Every Rings of Power / Nocturne / Silo override below is a TEST FIXTURE, not a verified real-world time.
 */
import assert from 'node:assert/strict';
import { addDays, localInstants, parseOverrideConfig, type ReleaseOverride } from '../src/services/release-override.model';
import { assignReleaseTimes, isEpisodeReleased, tmdbReleaseAt } from '../src/services/release-rule.model';
import { buildTrackingSummary, catalogFromTMDB, mergeShowEpisodes, withReleaseTimes, type Catalog, type TrackedShow } from '../src/services/tracking-summary.model';
import { calculateLegacyCoverage, calculateTrackingProgress, episodeKey } from '../src/services/legacy-progress.model';
import { decideStatus, verifiedCoverage, verifiedUnwatchedPremiere, verifyCompletion, type TVMazeEvidence } from '../src/services/show-status.model';
import type { TVMazeEpisode, TVMazeShow } from '../src/services/tvmaze/tvmaze-schedule.model';

const run = (name: string, fn: () => void) => { fn(); console.log(`ok - ${name}`); };
const TODAY = '2026-11-21';
const source = (scope: 'episode' | 'season' = 'episode') => ({ url: 'https://example.com/announcement', publisher: 'Test fixture', scope });
const episodeEntry = (over: Record<string, unknown> = {}) => ({ id: 'rop-s3e7', tmdbId: 84773, show: 'The Rings of Power', season: 3, episode: 7, releaseLocal: '2026-11-24T18:00', timeZone: 'America/Los_Angeles', tmdbAirDate: '2026-11-25', source: source(), verifiedAt: '2026-11-21', ...over });
const seasonEntry = (over: Record<string, unknown> = {}) => ({ id: 'nocturne-s1', tmdbId: 292741, show: 'Nocturne', season: 1, episodes: { from: 1, to: 10 }, localTime: '21:00', timeZone: 'America/New_York', localDay: 'tmdb_date', tmdbAirDates: { from: '2026-10-29', to: '2026-12-24' }, source: source('season'), verifiedAt: '2026-11-21', ...over });
const parse = (...entries: unknown[]) => parseOverrideConfig({ version: 1, overrides: entries }, TODAY);
const valid = (...entries: unknown[]) => { const r = parse(...entries); assert.deepEqual(r.rejected, [], JSON.stringify(r.rejected)); return r.overrides; };
const reasons = (entry: unknown) => parse(entry).rejected.flatMap(r => r.reasons).join(' | ');

type Ep = [season: number, number: number, airDate: string | null];
function tmdbCatalog(episodes: Ep[]): Catalog {
  const numbers = [...new Set(episodes.map(([s]) => s))].sort((a, b) => a - b);
  const details = { name: 'Series', status: 'Returning Series', in_production: true, next_episode_to_air: null, seasons: numbers.map(n => ({ season_number: n, episode_count: episodes.filter(([s]) => s === n).length, air_date: episodes.find(([s]) => s === n)?.[2] ?? null })) };
  return catalogFromTMDB(details, numbers.map(n => ({ season: n, data: { episodes: episodes.filter(([s]) => s === n).map(([, number, air_date]) => ({ episode_number: number, name: `E${number}`, air_date })) } })), '2020-01-01');
}
const seasonOf = (season: number, dates: (string | null)[]): Ep[] => dates.map((d, i) => [season, i + 1, d]);
const weekly = (season: number, first: string, count: number): Ep[] => Array.from({ length: count }, (_, i) => [season, i + 1, addDays(first, i * 7)]);
const tv = (id: number, season: number, number: number, airdate: string, airtime = '', airstamp: string | null = null): TVMazeEpisode =>
  ({ id, season, number, type: 'regular', name: `E${number}`, airdate, airtime, airstamp: airstamp ?? `${airdate}T12:00:00+00:00`, runtime: 60 });
const network = (timezone: string): Pick<TVMazeShow, 'network' | 'webChannel'> => ({ network: { name: 'Net', country: { timezone } }, webChannel: null });
const web = (name: string): Pick<TVMazeShow, 'network' | 'webChannel'> => ({ network: null, webChannel: { name, country: null } });
const show = (s: number, e: number, status = 'watching'): TrackedShow => ({ id: 'show', name: 'Series', posterURL: null, status, completed: status === 'completed', seasonsWatched: s, episodesWatched: e });
const at = (catalog: Catalog, s: number, n: number) => catalog.episodes.find(e => e.season === s && e.number === n)!;
const code = (e: { season: number; number: number } | null) => e ? `S${String(e.season).padStart(2, '0')}E${String(e.number).padStart(2, '0')}` : null;

// ---------------------------------------------------------------------------------------------------------------
run('Validation: complete, well-formed entries are accepted', () => {
  const [episode, season] = valid(episodeEntry(), seasonEntry());
  assert.equal(episode.kind, 'episode'); assert.equal(season.kind, 'season');
  assert.deepEqual(parseOverrideConfig({ version: 1, overrides: [] }, TODAY), { overrides: [], rejected: [], error: null });
});

run('Validation: time zones must be real IANA names; abbreviations and offsets are refused', () => {
  for (const zone of ['EST', 'PST', 'ET', 'GMT+1', '+01:00', 'America/Nowhere', 'america/new_york', '', null]) assert.match(reasons(episodeEntry({ timeZone: zone })), /IANA/, String(zone));
  for (const zone of ['UTC', 'Europe/Paris', 'Asia/Tokyo', 'America/Argentina/Buenos_Aires']) assert.equal(reasons(episodeEntry({ timeZone: zone, releaseLocal: '2026-11-25T08:00' })), '', zone);
});

run('Validation: missing, unknown and malformed fields reject the entry (never partially applied)', () => {
  assert.match(reasons({ ...episodeEntry(), timezone: 'UTC' }), /Unknown field "timezone"/);
  const { source: _s, ...noSource } = episodeEntry();
  assert.match(reasons(noSource), /Missing field "source"/);
  assert.match(reasons(episodeEntry({ source: { url: 'http://example.com', publisher: 'x', scope: 'episode' } })), /https/);
  assert.match(reasons(episodeEntry({ source: { url: 'https://example.com', publisher: ' ', scope: 'episode' } })), /publisher/);
  assert.match(reasons(seasonEntry({ source: source('episode') })), /season-wide source/);
  assert.match(reasons(episodeEntry({ verifiedAt: '2026-12-01' })), /not in the future/);
  assert.match(reasons(episodeEntry({ releaseLocal: '2026-11-24 18:00' })), /YYYY-MM-DDTHH:MM/);
  assert.match(reasons(episodeEntry({ releaseLocal: '2026-11-24T18:00Z' })), /YYYY-MM-DDTHH:MM/);
  assert.match(reasons(episodeEntry({ releaseLocal: '2026-02-30T18:00' })), /YYYY-MM-DDTHH:MM/);
  assert.match(reasons(episodeEntry({ season: 0 })), /regular season/);
  assert.match(reasons(episodeEntry({ id: 'Bad ID' })), /lowercase/);
  assert.match(reasons({ ...episodeEntry(), episodes: { from: 1, to: 2 } }), /exactly one/);
  assert.match(reasons(seasonEntry({ episodes: { from: 5, to: 2 } })), /episodes must be/);
  assert.match(reasons(seasonEntry({ localTime: '9pm' })), /HH:MM/);
  assert.match(reasons(seasonEntry({ localDay: 'previous' })), /localDay/);
  assert.match(reasons(seasonEntry({ tmdbAirDates: { from: '2026-01-01', to: '2027-06-01' } })), /at most one year/);
  assert.equal(parseOverrideConfig({ version: 2, overrides: [] }, TODAY).error, 'Unsupported "version" (expected 1)');
  assert.match(String(parseOverrideConfig({ version: 1, overrides: [], extra: true }, TODAY).error), /Unknown top-level/);
  assert.match(String(parseOverrideConfig([], TODAY).error), /JSON object/);
});

run('Validation: duplicates and conflicting entries reject every entry involved', () => {
  let r = parse(episodeEntry(), episodeEntry({ releaseLocal: '2026-11-24T19:00' }));
  assert.equal(r.overrides.length, 0); assert.equal(r.rejected.length, 2);
  r = parse(episodeEntry(), episodeEntry({ id: 'rop-s3e7-again' }));
  assert.equal(r.overrides.length, 0, 'two entries for one episode conflict even with different ids');
  r = parse(seasonEntry(), seasonEntry({ id: 'nocturne-s1-b', episodes: { from: 5, to: 6 } }));
  assert.equal(r.overrides.length, 0, 'overlapping season entries conflict');
  r = parse(seasonEntry({ episodes: { from: 1, to: 5 } }), seasonEntry({ id: 'nocturne-s1-b', episodes: { from: 6, to: 10 } }));
  assert.equal(r.overrides.length, 2, 'disjoint episode ranges are fine');
  r = parse(seasonEntry(), episodeEntry({ id: 'nocturne-s1e6', tmdbId: 292741, season: 1, episode: 6, releaseLocal: '2026-11-25T12:00', timeZone: 'America/New_York', tmdbAirDate: '2026-11-26' }));
  assert.deepEqual(r.overrides.map(o => o.id), ['nocturne-s1'], 'a day-before entry still before TMDB\'s date in UTC is rejected on its own');
  r = parse(seasonEntry(), episodeEntry({ id: 'nocturne-s1e6', tmdbId: 292741, season: 1, episode: 6, releaseLocal: '2026-11-26T22:00', timeZone: 'America/New_York', tmdbAirDate: '2026-11-26' }));
  assert.equal(r.overrides.length, 2, 'an episode entry inside a season entry is allowed (it wins for that episode)');
});

// ---------------------------------------------------------------------------------------------------------------
run('Daylight saving: gaps and overlaps are rejected, offsets follow the date', () => {
  assert.deepEqual(localInstants('2027-03-14', '02:30', 'America/New_York'), [], 'spring forward: 02:30 never happens');
  assert.equal(localInstants('2026-11-01', '01:30', 'America/New_York').length, 2, 'fall back: 01:30 happens twice');
  assert.deepEqual(localInstants('2027-03-28', '01:30', 'Europe/London'), []);
  assert.deepEqual(localInstants('2026-11-25', '21:00', 'America/New_York').map(t => new Date(t).toISOString()), ['2026-11-26T02:00:00.000Z'], 'EST');
  assert.deepEqual(localInstants('2026-07-15', '21:00', 'America/New_York').map(t => new Date(t).toISOString()), ['2026-07-16T01:00:00.000Z'], 'EDT');
  assert.deepEqual(localInstants('2026-11-25', '00:00', 'Pacific/Kiritimati').map(t => new Date(t).toISOString()), ['2026-11-24T10:00:00.000Z'], 'UTC+14');
  assert.match(reasons(episodeEntry({ releaseLocal: '2027-03-14T02:30', timeZone: 'America/New_York', tmdbAirDate: '2027-03-14' })), /daylight-saving gap/);
  assert.match(reasons(episodeEntry({ releaseLocal: '2026-11-01T01:30', timeZone: 'America/New_York', tmdbAirDate: '2026-11-01' })), /daylight-saving overlap/);
  // A season pattern applies per date: only the episode landing in the gap is left to the fallback.
  const overrides = valid(seasonEntry({ id: 'dst-show', tmdbId: 1, show: 'DST Show', localTime: '02:30', tmdbAirDates: { from: '2027-03-07', to: '2027-03-21' } }));
  const { episodes, timing } = assignReleaseTimes(tmdbCatalog(seasonOf(1, ['2027-03-07', '2027-03-14', '2027-03-21'])).episodes, null, null, 'none', overrides);
  assert.deepEqual(episodes.map(e => [e.releaseSource, e.releaseAt]), [
    ['manual_override', '2027-03-07T07:30:00.000Z'], ['tmdb_date', '2027-03-15T12:00:00.000Z'], ['manual_override', '2027-03-21T06:30:00.000Z']]);
  assert.deepEqual(timing.overrides?.map(o => o.status), ['applied', 'nonexistent_local_time', 'applied']);
});

// ---------------------------------------------------------------------------------------------------------------
run('TMDB-date guard: a legitimate release on the preceding local day is accepted; premature ones are not', () => {
  // TMDB Wednesday 2026-11-25. "Tuesday 18:00 Los Angeles" = Wednesday 02:00 UTC: it is already TMDB's date in UTC.
  const D = '2026-11-25';
  const apply = (entry: Record<string, unknown>) => assignReleaseTimes([{ season: 3, number: 7, airDate: D }], null, null, 'none', valid(entry)).episodes[0];
  const evening = apply(seasonEntry({ id: 'rop-s3', tmdbId: 84773, season: 3, episodes: { from: 7, to: 8 }, localTime: '18:00', timeZone: 'America/Los_Angeles', localDay: 'day_before_tmdb_date', tmdbAirDates: { from: D, to: D } }));
  assert.deepEqual([evening.releaseSource, evening.releaseAt], ['manual_override', '2026-11-25T02:00:00.000Z']);
  // "Tuesday 09:00 Los Angeles" = Tuesday 17:00 UTC: before TMDB's date in UTC → rejected, fallback kept.
  const morning = assignReleaseTimes([{ season: 3, number: 7, airDate: D }], null, null, 'none', valid(seasonEntry({ id: 'rop-s3', tmdbId: 84773, season: 3, episodes: { from: 7, to: 8 }, localTime: '09:00', timeZone: 'America/Los_Angeles', localDay: 'day_before_tmdb_date', tmdbAirDates: { from: D, to: D } })));
  assert.deepEqual([morning.episodes[0].releaseSource, morning.episodes[0].releaseAt, morning.timing.overrides?.[0].status], ['tmdb_date', tmdbReleaseAt(D), 'outside_tmdb_date']);
  assert.match(reasons(episodeEntry({ releaseLocal: '2026-11-24T09:00' })), /still before TMDB's 2026-11-25 in UTC/);
  // The same 17:00Z instant written where it is already Wednesday (UTC+14) is on TMDB's date: accepted.
  assert.equal(reasons(episodeEntry({ releaseLocal: '2026-11-25T07:00', timeZone: 'Pacific/Kiritimati' })), '');
  // Two days before, or after TMDB's date: rejected outright.
  assert.match(reasons(episodeEntry({ releaseLocal: '2026-11-23T20:00' })), /neither TMDB's 2026-11-25 nor the day before/);
  assert.match(reasons(episodeEntry({ releaseLocal: '2026-11-26T00:30' })), /neither TMDB's 2026-11-25 nor the day before/);
});

run('TMDB-date guard: every accepted instant lies inside D\'s global window and never after the fallback', () => {
  const zones = ['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Pacific/Honolulu', 'America/Los_Angeles', 'America/New_York', 'America/Sao_Paulo', 'Europe/London', 'Europe/Paris', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland', 'Pacific/Chatham'];
  const dates = ['2026-03-08', '2026-03-29', '2026-06-21', '2026-10-25', '2026-11-01', '2026-11-25', '2027-01-01', '2027-04-04'];
  let accepted = 0; let rejected = 0;
  for (const D of dates) for (const zone of zones) for (const localDay of ['tmdb_date', 'day_before_tmdb_date']) for (let h = 0; h < 24; h += 1) for (const m of ['00', '30']) {
    const time = `${String(h).padStart(2, '0')}:${m}`;
    const overrides = parse(seasonEntry({ id: 'prop', tmdbId: 1, timeZone: zone, localTime: time, localDay, tmdbAirDates: { from: D, to: D } })).overrides as ReleaseOverride[];
    const [e] = assignReleaseTimes([{ season: 1, number: 1, airDate: D }], null, null, 'none', overrides).episodes;
    if (e.releaseSource !== 'manual_override') { rejected++; continue; }
    accepted++;
    const t = Date.parse(e.releaseAt!);
    assert.ok(t >= Date.parse(`${addDays(D, -1)}T10:00:00Z`), `${D} ${zone} ${localDay} ${time}: not before D begins anywhere`);
    assert.ok(t <= Date.parse(tmdbReleaseAt(D)!), `${D} ${zone} ${localDay} ${time}: never later than the fallback`);
    if (localDay === 'day_before_tmdb_date') assert.ok(t >= Date.parse(`${D}T00:00:00Z`), 'a day-before release is already D in UTC');
  }
  assert.ok(accepted > 2000 && rejected > 1000, `${accepted} accepted, ${rejected} rejected`);
});

// ---------------------------------------------------------------------------------------------------------------
// The four shows. TVMaze records as on 2026-11-21; overrides are fixtures.
const ropTmdb: Ep[] = [...weekly(1, '2022-09-01', 8), ...weekly(2, '2024-08-29', 8), ...seasonOf(3, ['2026-11-11', '2026-11-11', '2026-11-11', '2026-11-11', '2026-11-18', '2026-11-18', '2026-11-25', '2026-11-25'])];
const ropTv = seasonOf(3, ['2026-11-11', '2026-11-11', '2026-11-11', '2026-11-11', '2026-11-18', '2026-11-18', '2026-11-25', '2026-11-25']).map(([s, n, d], i) => tv(3682718 + i, s, n, d!));
const ropOverride = () => valid(seasonEntry({ id: 'rop-s3-finale', tmdbId: 84773, show: 'The Rings of Power', season: 3, episodes: { from: 7, to: 8 }, localTime: '18:00', timeZone: 'America/Los_Angeles', localDay: 'day_before_tmdb_date', tmdbAirDates: { from: '2026-11-25', to: '2026-11-25' } }));

run('The Rings of Power: without an entry the conservative fallback; with a documented entry, the stated time', () => {
  const plain = withReleaseTimes(tmdbCatalog(ropTmdb), { show: web('Prime Video'), episodes: ropTv }, 33352);
  assert.deepEqual([at(plain, 3, 7).releaseAt, at(plain, 3, 7).releaseSource], ['2026-11-26T12:00:00.000Z', 'tvmaze_date_worldwide']);
  const timed = withReleaseTimes(tmdbCatalog(ropTmdb), { show: web('Prime Video'), episodes: ropTv }, 33352, undefined, ropOverride());
  for (const n of [7, 8]) assert.deepEqual([at(timed, 3, n).releaseAt, at(timed, 3, n).releaseSource, at(timed, 3, n).releaseOverrideId], ['2026-11-25T02:00:00.000Z', 'manual_override', 'rop-s3-finale']);
  assert.deepEqual([at(timed, 3, 6).releaseSource], ['tvmaze_date_worldwide'], 'episodes outside the entry are untouched');
  const before = buildTrackingSummary(show(3, 6), timed, null, [], '2026-11-25T01:59:59Z');
  const after = buildTrackingSummary(show(3, 6), timed, null, [], '2026-11-25T02:00:00Z');
  assert.deepEqual([before.releasedCount, code(before.nextEpisode), code(before.upcomingEpisode)], [22, null, 'S03E07']);
  assert.deepEqual([after.releasedCount, code(after.nextEpisode), after.upcomingEpisode], [24, 'S03E07', null]);
});

run('The Gilded Age: a verified TVMaze exact premiere always wins over an entry', () => {
  const gildedTmdb: Ep[] = [...weekly(1, '2022-01-24', 9), ...weekly(4, '2026-11-01', 8)];
  const gildedTv = weekly(4, '2026-11-01', 8).map(([s, n, d], i) => tv(3808836 + i, s, n, d!, '21:00', `${addDays(d!, 1)}T02:00:00+00:00`));
  const conflicting = valid(episodeEntry({ id: 'gilded-s4e4', tmdbId: 81723, show: 'The Gilded Age', season: 4, episode: 4, releaseLocal: '2026-11-22T18:00', timeZone: 'America/New_York', tmdbAirDate: '2026-11-22' }));
  const c = withReleaseTimes(tmdbCatalog(gildedTmdb), { show: network('America/New_York'), episodes: gildedTv }, 34685, undefined, conflicting);
  assert.deepEqual([at(c, 4, 4).releaseAt, at(c, 4, 4).releaseSource], ['2026-11-23T02:00:00.000Z', 'tvmaze_exact']);
  assert.deepEqual(c.releaseTiming?.overrides?.map(o => o.status), ['conflict_tvmaze_exact']);
  const same = valid(episodeEntry({ id: 'gilded-s4e4', tmdbId: 81723, show: 'The Gilded Age', season: 4, episode: 4, releaseLocal: '2026-11-22T21:00', timeZone: 'America/New_York', tmdbAirDate: '2026-11-22' }));
  const r = withReleaseTimes(tmdbCatalog(gildedTmdb), { show: network('America/New_York'), episodes: gildedTv }, 34685, undefined, same);
  assert.deepEqual([at(r, 4, 4).releaseSource, r.releaseTiming?.overrides?.[0].status], ['tvmaze_exact', 'redundant']);
});

run('Nocturne: a season entry applies; a TVMaze date more than a day off blocks it', () => {
  const tmdb: Ep[] = seasonOf(1, ['2026-10-29', '2026-10-29', '2026-11-05', '2026-11-12', '2026-11-19', '2026-11-26', '2026-12-03', '2026-12-10', '2026-12-17', '2026-12-24']);
  const tvDates = ['2026-10-30', '2026-10-30', '2026-11-06', '2026-11-13', '2026-11-20', '2026-11-25', '2026-12-04', '2026-12-11', '2026-12-18', '2026-12-25'];
  const overrides = valid(seasonEntry());
  const c = withReleaseTimes(tmdbCatalog(tmdb), { show: web('Apple TV'), episodes: tvDates.map((d, i) => tv(3665755 + i, 1, i + 1, d)) }, 66811, undefined, overrides);
  assert.deepEqual([at(c, 1, 6).releaseAt, at(c, 1, 6).releaseSource], ['2026-11-27T02:00:00.000Z', 'manual_override'], 'TVMaze one day early (11-25) is within a day of TMDB: entry applies');
  assert.ok(c.releaseTiming?.overrides?.every(o => o.status === 'applied'));
  const moved = [...tvDates]; moved[6] = '2026-12-07';
  const m = withReleaseTimes(tmdbCatalog(tmdb), { show: web('Apple TV'), episodes: moved.map((d, i) => tv(3665755 + i, 1, i + 1, d)) }, 66811, undefined, overrides);
  assert.deepEqual([at(m, 1, 7).releaseSource, at(m, 1, 7).releaseAt], ['tmdb_date', '2026-12-04T12:00:00.000Z']);
  assert.equal(m.releaseTiming?.overrides?.find(o => o.episode === 7)?.status, 'conflict_tvmaze_date');
});

run('Silo: TMDB (Thu 2027-07-08) vs the announced Friday 2027-07-09 — an entry for the Friday is rejected until TMDB agrees', () => {
  const tmdb: Ep[] = [...weekly(1, '2023-05-05', 10), [4, 1, '2027-07-08']];
  const friday = parse(episodeEntry({ id: 'silo-s4e1', tmdbId: 125988, show: 'Silo', season: 4, episode: 1, releaseLocal: '2027-07-09T00:00', timeZone: 'Europe/London', tmdbAirDate: '2027-07-09' })).overrides;
  const c = withReleaseTimes(tmdbCatalog(tmdb), null, null, 'none', friday);
  assert.deepEqual([at(c, 4, 1).releaseSource, at(c, 4, 1).releaseAt, c.releaseTiming?.overrides?.[0].status], ['tmdb_date', '2027-07-09T12:00:00.000Z', 'stale_tmdb_date']);
  // Once TMDB lists the Friday, the same entry applies.
  const fixed = withReleaseTimes(tmdbCatalog([...weekly(1, '2023-05-05', 10), [4, 1, '2027-07-09']]), null, null, 'none', friday);
  assert.deepEqual([at(fixed, 4, 1).releaseSource, at(fixed, 4, 1).releaseAt], ['manual_override', '2027-07-08T23:00:00.000Z']);
});

// ---------------------------------------------------------------------------------------------------------------
run('TMDB schedule changes: episode entries go stale; season entries follow TMDB only inside their documented range', () => {
  const entry = valid(episodeEntry());
  const delayed = assignReleaseTimes([{ season: 3, number: 7, airDate: '2026-12-02' }], null, null, 'none', entry);
  assert.deepEqual([delayed.episodes[0].releaseSource, delayed.episodes[0].releaseAt, delayed.timing.overrides?.[0].status], ['tmdb_date', '2026-12-03T12:00:00.000Z', 'stale_tmdb_date']);
  const season = valid(seasonEntry());
  const inside = assignReleaseTimes([{ season: 1, number: 6, airDate: '2026-11-27' }], null, null, 'none', season).episodes[0];
  assert.deepEqual([inside.releaseSource, inside.releaseAt], ['manual_override', '2026-11-28T02:00:00.000Z'], 'moved by a day within the range: still covered');
  const outside = assignReleaseTimes([{ season: 1, number: 10, airDate: '2027-01-07' }], null, null, 'none', season);
  assert.deepEqual([outside.episodes[0].releaseSource, outside.timing.overrides], ['tmdb_date', []], 'moved past the documented range: not covered');
  const undated = assignReleaseTimes([{ season: 3, number: 7, airDate: null }], null, null, 'none', entry);
  assert.deepEqual([undated.episodes[0].releaseAt, undated.timing.overrides?.[0].status], [null, 'no_tmdb_date']);
  const missing = assignReleaseTimes([{ season: 3, number: 6, airDate: '2026-11-18' }], null, null, 'none', entry);
  assert.equal(missing.timing.overrides?.[0].status, 'no_matching_episode');
});

run('Ambiguous TVMaze numbering does not block an entry keyed to TMDB (TVMaze is ignored there)', () => {
  const tmdb = tmdbCatalog([[1, 1, '2026-11-20'], [1, 2, '2026-11-27']]);
  const tvEpisodes = [tv(1, 1, 1, '2026-11-20', '21:00', '2026-11-21T02:00:00+00:00'), tv(2, 1, 2, '2026-11-27'), tv(3, 1, 3, '2026-12-04')];
  const entry = valid(episodeEntry({ id: 'x-s1e2', tmdbId: 5, show: 'X', season: 1, episode: 2, releaseLocal: '2026-11-27T21:00', timeZone: 'America/New_York', tmdbAirDate: '2026-11-27' }));
  const c = withReleaseTimes(tmdb, { show: network('America/New_York'), episodes: tvEpisodes }, 9, undefined, entry);
  assert.equal(c.releaseTiming?.source, 'tmdb_only');
  assert.deepEqual([at(c, 1, 1).releaseSource, at(c, 1, 2).releaseSource, at(c, 1, 2).releaseAt], ['tmdb_date', 'manual_override', '2026-11-28T02:00:00.000Z']);
});

// ---------------------------------------------------------------------------------------------------------------
run('Legacy saved positions and unwatch exceptions follow the override instant', () => {
  const c = withReleaseTimes(tmdbCatalog(ropTmdb), { show: web('Prime Video'), episodes: ropTv }, 33352, undefined, ropOverride());
  const early = calculateLegacyCoverage(3, 7, c, '2026-11-25T01:00:00Z');
  assert.deepEqual([early.covered.has(episodeKey(3, 7)), early.needsReview], [false, true]);
  const later = calculateLegacyCoverage(3, 7, c, '2026-11-25T02:00:00Z');
  assert.deepEqual([later.covered.has(episodeKey(3, 7)), later.needsReview], [true, false]);
  const summary = buildTrackingSummary(show(3, 8), c, null, [], '2026-11-25T03:00:00Z', null, [{ season: 3, episode: 8 }]);
  assert.deepEqual([summary.releasedCount, summary.watchedCount, code(summary.nextEpisode), summary.legacyPosition?.fullSeasons, summary.legacyPosition?.episodesInNextSeason], [24, 23, 'S03E08', 3, 8]);
});

// ---------------------------------------------------------------------------------------------------------------
// Automatic statuses: an override can release an episode earlier on Home, but it never verifies a premiere for
// status changes; Cinetra's instant must also have passed. A status can lag availability, never lead it.
function decision(catalog: Catalog, user: TrackedShow, watches: { season: number; episode: number; watchedAt: Date }[], now: string, tvmaze: TVMazeEvidence) {
  const { legacy, episodes } = mergeShowEpisodes(user, catalog, watches, now);
  const progress = calculateTrackingProgress(episodes, catalog, legacy.needsReview, 'returning', true, false, now, true);
  const input = { episodes, tvmaze, today: now.slice(0, 10), now: new Date(now) };
  const completion = verifyCompletion({ ...input, catalog: { seasons: catalog.seasons, nextEpisode: null }, progressReliable: progress.progressReliable });
  return { transition: decideStatus({ status: user.status, completion, reopen: verifiedUnwatchedPremiere(input) }), coverage: verifiedCoverage(input).reason };
}
const allWatched = (through: [number, number][]) => through.flatMap(([s, n]) => Array.from({ length: n }, (_, i) => ({ season: s, episode: i + 1, watchedAt: new Date('2026-11-20T00:00:00Z') })));

run('Automatic statuses: an override never reopens or completes a show by itself', () => {
  const c = withReleaseTimes(tmdbCatalog(ropTmdb), { show: web('Prime Video'), episodes: ropTv }, 33352, undefined, ropOverride());
  const ropEvidence: TVMazeEvidence = { kind: 'verified', episodes: [...ropTmdb.filter(([s]) => s < 3).map(([s, n, d], i) => tv(900 + i, s, n, d!)), ...ropTv], timeZone: null };
  // Completed, S3E1–E6 watched; at 03:00Z on 11-25 the override released E7–E8 on Home, TVMaze has not verified them.
  const completed = decision(c, show(0, 0, 'completed'), allWatched([[1, 8], [2, 8], [3, 6]]), '2026-11-25T03:00:00Z', ropEvidence);
  assert.equal(completed.transition, null, 'no reopen from an override alone');
  // Watching and every Home-released episode watched (E7–E8 included): no completion until TVMaze verifies.
  const watching = decision(c, show(0, 0, 'watching'), allWatched([[1, 8], [2, 8], [3, 8]]), '2026-11-25T03:00:00Z', ropEvidence);
  assert.equal(watching.transition, null);
  // After TVMaze's own conservative instant (11-26 12:00Z), the usual verified transitions resume.
  const reopened = decision(c, show(0, 0, 'completed'), allWatched([[1, 8], [2, 8], [3, 6]]), '2026-11-26T12:00:00Z', ropEvidence);
  assert.deepEqual(reopened.transition, { from: 'completed', to: 'watching', reason: 'S3E7 is verified released and unwatched' });
});

run('Automatic statuses: a TVMaze-verified premiere that Cinetra has not released yet blocks the change', () => {
  // TVMaze: S1E2 premiered 2026-11-26 21:00 New York (exact). TMDB lists 2026-11-27, so Cinetra uses the fallback 11-28 12:00Z.
  const tmdb = tmdbCatalog([[1, 1, '2026-11-19'], [1, 2, '2026-11-27']]);
  const tvEpisodes = [tv(1, 1, 1, '2026-11-19', '21:00', '2026-11-20T02:00:00+00:00'), tv(2, 1, 2, '2026-11-26', '21:00', '2026-11-27T02:00:00+00:00')];
  const c = withReleaseTimes(tmdb, { show: network('America/New_York'), episodes: tvEpisodes }, 1);
  assert.equal(at(c, 1, 2).releaseAt, '2026-11-28T12:00:00.000Z');
  const evidence: TVMazeEvidence = { kind: 'verified', episodes: tvEpisodes, timeZone: 'America/New_York' };
  const window = decision(c, show(0, 0, 'completed'), allWatched([[1, 1]]), '2026-11-27T12:00:00Z', evidence);
  assert.equal(window.transition, null, 'status never ahead of Home');
  assert.match(String(window.coverage), /not yet released in Cinetra/);
  const released = decision(c, show(0, 0, 'completed'), allWatched([[1, 1]]), '2026-11-28T12:00:00Z', evidence);
  assert.deepEqual(released.transition, { from: 'completed', to: 'watching', reason: 'S1E2 is verified released and unwatched' });
  // Episodes without a release instant (older callers) keep the previous behaviour exactly.
  const legacyEpisodes = mergeShowEpisodes(show(0, 0, 'completed'), { ...c, episodes: c.episodes.map(({ releaseAt: _r, releaseSource: _s, ...e }) => e) }, allWatched([[1, 1]]), '2026-11-27T12:00:00Z').episodes;
  assert.equal(verifiedCoverage({ episodes: legacyEpisodes, tvmaze: evidence, today: '2026-11-27', now: new Date('2026-11-27T12:00:00Z') }).reason, null);
});

run('Release checks agree: Home summary, Watch Room guide and the server gate use one instant', () => {
  const c = withReleaseTimes(tmdbCatalog(ropTmdb), { show: web('Prime Video'), episodes: ropTv }, 33352, undefined, ropOverride());
  for (const now of ['2026-11-25T01:59:59.999Z', '2026-11-25T02:00:00.000Z']) {
    const summary = buildTrackingSummary(show(3, 6), c, null, [], now);
    const guide = mergeShowEpisodes(show(3, 6), c, [], now).episodes.filter(e => e.season === 3 && isEpisodeReleased(e, now)).length;
    const gate = isEpisodeReleased(at(c, 3, 7), now);
    assert.equal(summary.releasedCount - 16, guide, now);
    assert.equal(gate, guide === 8, now);
  }
});

console.log('release override tests passed');
