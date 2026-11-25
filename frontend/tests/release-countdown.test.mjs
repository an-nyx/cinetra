import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countdownParts, nextCountdown, nextTickDelay, verifiedReleaseInstant } from '../src/lib/release-countdown.ts';
import { groupReleaseEvents } from '../src/lib/upcoming-calendar.ts';

// The countdown is display only: it reads the instants the schedule already carries and never decides availability.
const NOW = new Date('2026-11-24T20:00:00.000Z');
let id = 1;
const release = (over = {}) => ({
  id: `1:${id++}`, tvmazeShowId: 1, episodeId: id, showId: `show-${id}`, showName: 'Fixture', posterURL: null, showStatus: 'watching',
  season: 1, number: id, name: 'Chapter', airDate: '2026-11-24', airTime: null, airTimestamp: null, runtime: 50, seasonPremiere: false,
  channel: null, streaming: false, scheduleSource: 'TVMaze', releaseAt: null, releaseSource: null, ...over,
});
const inHours = h => new Date(NOW.getTime() + h * 3_600_000).toISOString();
const events = releases => groupReleaseEvents(releases, NOW);

test('a verified TVMaze premiere or documented manual time within 24 h gets the countdown', () => {
  const exact = release({ releaseAt: inHours(3), releaseSource: 'tvmaze_exact', airTimestamp: inHours(3) });
  const manual = release({ releaseAt: inHours(2), releaseSource: 'manual_override' });
  const result = nextCountdown(events([exact, manual]), NOW);
  assert.equal(result?.at, Date.parse(inHours(2)), 'the earliest verified instant wins');
});

test('date-only, estimated and unverified air times never get a countdown', () => {
  const unverifiedAirTime = release({ airTimestamp: inHours(1) });
  const dateOnly = release({ airTimestamp: null });
  const fallbacks = ['tvmaze_date_local', 'tvmaze_date_worldwide', 'tmdb_date'].map(source => release({ releaseAt: inHours(2), releaseSource: source }));
  assert.equal(nextCountdown(events([unverifiedAirTime, dateOnly, ...fallbacks]), NOW), null);
});

test('only the future within 24 hours: past, now and later releases are ignored', () => {
  const past = release({ releaseAt: inHours(-1), releaseSource: 'tvmaze_exact' });
  const exactlyNow = release({ releaseAt: NOW.toISOString(), releaseSource: 'tvmaze_exact' });
  const later = release({ releaseAt: inHours(24.5), releaseSource: 'tvmaze_exact' });
  assert.equal(nextCountdown(events([past, exactlyNow, later]), NOW), null);
  const edge = release({ releaseAt: inHours(24), releaseSource: 'tvmaze_exact' });
  assert.ok(nextCountdown(events([edge]), NOW), 'exactly 24 h away still qualifies');
});

test('a grouped event counts down to its earliest verified episode, ignoring unverified siblings', () => {
  const event = { key: 'k', episodes: [release({ airTimestamp: inHours(1) }), release({ releaseAt: inHours(4), releaseSource: 'tvmaze_exact' }), release({ releaseAt: 'not a date', releaseSource: 'manual_override' })] };
  assert.equal(verifiedReleaseInstant(event), inHours(4));
});

test('the input schedule is never modified', () => {
  const releases = [release({ releaseAt: inHours(3), releaseSource: 'tvmaze_exact' })];
  const grouped = events(releases);
  const snapshot = JSON.stringify(grouped);
  nextCountdown(grouped, NOW);
  assert.equal(JSON.stringify(grouped), snapshot);
});

test('display units: hours and minutes (rounded up) above one hour, minutes and seconds below', () => {
  assert.deepEqual(countdownParts(3 * 3_600_000 + 12 * 60_000 + 1), { precise: false, hours: 3, minutes: 13, seconds: 0 });
  assert.deepEqual(countdownParts(3_600_000), { precise: false, hours: 1, minutes: 0, seconds: 0 });
  assert.deepEqual(countdownParts(3_599_000), { precise: true, hours: 0, minutes: 59, seconds: 59 });
  assert.deepEqual(countdownParts(400), { precise: true, hours: 0, minutes: 0, seconds: 1 });
  assert.deepEqual(countdownParts(-5), { precise: true, hours: 0, minutes: 0, seconds: 0 });
});

test('ticks only when the visible value changes, and stops at zero', () => {
  assert.equal(nextTickDelay(2 * 3_600_000 + 61_500), 1_500, 'minute mode waits for the next minute boundary');
  assert.equal(nextTickDelay(2 * 3_600_000), 60_000);
  assert.equal(nextTickDelay(10_250), 250, 'second mode waits for the next second boundary');
  assert.equal(nextTickDelay(0), null);
  assert.equal(nextTickDelay(-1), null);
});
