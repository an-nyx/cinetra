/* global process */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupReleaseEvents, releaseDay, releaseTimestamp } from '../src/lib/upcoming-calendar.ts';
import { isEpisodeReleased } from '../src/lib/release.ts';

// Upcoming shows the same release instant Home and the Watch Room use (the server's releaseAt).
let nextId = 1;
const release = (over = {}) => ({
  id: `300:${nextId++}`, tvmazeShowId: 300, episodeId: nextId, showId: 'rings', showName: 'The Rings of Power', posterURL: null, showStatus: 'watching',
  season: 3, number: 7, name: 'Episode 7', airDate: '2026-11-25', airTime: null, airTimestamp: null, runtime: 60, seasonPremiere: false,
  channel: 'Prime Video', streaming: true, scheduleSource: 'TVMaze', releaseAt: null, releaseSource: null, ...over,
});
const withTZ = (tz, fn) => { const previous = process.env.TZ; process.env.TZ = tz; try { return fn(); } finally { process.env.TZ = previous; } };

test('a documented manual time decides the day and time shown (fixture: Tue 18:00 Los Angeles = Wed 02:00Z)', () => withTZ('Europe/Paris', () => {
  const r = release({ releaseAt: '2026-11-25T02:00:00.000Z', releaseSource: 'manual_override' });
  assert.equal(releaseTimestamp(r), '2026-11-25T02:00:00.000Z');
  assert.equal(releaseDay(r), '2026-11-25', 'Paris: Wednesday 03:00');
  const [event] = groupReleaseEvents([r], new Date('2026-11-24T12:00:00Z'));
  assert.deepEqual([event.day, event.timestamp, event.manual, event.trackingFrom], ['2026-11-25', '2026-11-25T02:00:00.000Z', true, null]);
  withTZ('America/Los_Angeles', () => assert.equal(releaseDay(r), '2026-11-24', 'Los Angeles: Tuesday 18:00'));
}));

test('a verified TVMaze exact premiere: same instant as before', () => withTZ('Europe/Paris', () => {
  const r = release({ showId: 'gilded', season: 4, number: 4, airDate: '2026-11-22', airTime: '21:00', airTimestamp: '2026-11-23T02:00:00.000Z', releaseAt: '2026-11-23T02:00:00.000Z', releaseSource: 'tvmaze_exact' });
  const [event] = groupReleaseEvents([r], new Date('2026-11-22T12:00:00Z'));
  assert.deepEqual([event.day, event.timestamp, event.manual, event.trackingFrom], ['2026-11-23', '2026-11-23T02:00:00.000Z', false, null]);
}));

test('date-only schedule keeps its date, never gains a time, and says when Cinetra releases it', () => withTZ('Europe/Paris', () => {
  const r = release({ releaseAt: '2026-11-26T12:00:00.000Z', releaseSource: 'tvmaze_date_worldwide' });
  const [event] = groupReleaseEvents([r], new Date('2026-11-24T12:00:00Z'));
  assert.deepEqual([event.day, event.timestamp, event.trackingFrom], ['2026-11-25', null, '2026-11-26T12:00:00.000Z']);
}));

test('a past-dated release stays listed until Cinetra releases it, then disappears (Nocturne S01E06)', () => withTZ('Europe/Paris', () => {
  const r = release({ showId: 'nocturne', season: 1, number: 6, airDate: '2026-11-25', releaseAt: '2026-11-27T12:00:00.000Z', releaseSource: 'tmdb_date' });
  const kept = groupReleaseEvents([r], new Date('2026-11-27T11:59:00Z'));
  assert.equal(kept.length, 1, 'TVMaze day has passed, but Home has not released it yet');
  assert.equal(isEpisodeReleased(r, '2026-11-27T11:59:00Z'), false, 'Home agrees: not released');
  assert.equal(groupReleaseEvents([r], new Date('2026-11-27T12:00:00Z')).length, 0, 'released: no longer upcoming');
  assert.equal(isEpisodeReleased(r, '2026-11-27T12:00:00Z'), true);
  // Without a release instant (unverified numbering), past days drop exactly as before.
  assert.equal(groupReleaseEvents([release({ airDate: '2026-11-25' })], new Date('2026-11-27T11:59:00Z')).length, 0);
}));

test('upcoming and release agree for every instant around the release', () => {
  const r = release({ releaseAt: '2026-11-25T02:00:00.000Z', releaseSource: 'manual_override' });
  for (const now of ['2026-11-24T20:00:00Z', '2026-11-25T01:59:59Z', '2026-11-25T02:00:00Z', '2026-11-25T12:00:00Z']) withTZ('UTC', () => {
    const listedToday = groupReleaseEvents([r], new Date(now)).some(e => e.day >= now.slice(0, 10));
    const released = isEpisodeReleased(r, now);
    // Listed as upcoming (today or later) until released; on its release day it may still be shown as today's release.
    if (!released) assert.equal(listedToday, true, now);
  });
});
