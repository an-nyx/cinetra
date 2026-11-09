import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarStats, dayHeading, dayKey, eventEpisodeLine, filterEvents, groupByDay, groupReleaseEvents, releaseDay, shortDay, timeLabel, weekBounds } from '../src/lib/upcoming-calendar.ts';

let nextId = 1;
const release = (over = {}) => {
  const season = over.season ?? 3, number = over.number ?? 1;
  return { id: `300:${nextId++}`, tvmazeShowId: 300, episodeId: nextId, showId: 'rings', showName: 'The Rings of Power', posterURL: null, showStatus: 'watching',
    season, number, name: `Episode ${number}`, airDate: '2026-11-11', airTime: null, airTimestamp: null, runtime: 60, seasonPremiere: number === 1,
    channel: 'Prime Video', streaming: true, scheduleSource: 'TVMaze', ...over };
};
const withTZ = (tz, fn) => { const previous = process.env.TZ; process.env.TZ = tz; try { return fn(); } finally { process.env.TZ = previous; } };
// Wednesday 11 November 2026, 10:00 local.
const wednesday = () => new Date(2026, 10, 11, 10, 0);

test('several same-day episodes of one show become one grouped card', () => withTZ('Europe/Paris', () => {
  const events = groupReleaseEvents([1, 2, 3, 4].map(number => release({ number })), wednesday());
  assert.equal(events.length, 1);
  assert.equal(events[0].episodes.length, 4);
  assert.equal(events[0].premiere, true);
  assert.equal(eventEpisodeLine(events[0]), 'Season 3 premiere · Episodes 1–4');
}));

test('episodes on different days stay on their own days; different shows never merge, even with the same title', () => withTZ('Europe/Paris', () => {
  const events = groupReleaseEvents([
    release({ number: 1 }), release({ number: 2, airDate: '2026-11-18' }),
    release({ showId: 'remake', tvmazeShowId: 301, number: 1, id: '301:1' }), // same title, different verified show
  ], wednesday());
  assert.deepEqual(events.map(e => [e.day, e.showId, e.episodes.length]), [['2026-11-11', 'rings', 1], ['2026-11-11', 'remake', 1], ['2026-11-18', 'rings', 1]]);
  assert.deepEqual(groupByDay(events).map(d => [d.day, d.events.length]), [['2026-11-11', 2], ['2026-11-18', 1]]);
}));

test('the same TVMaze episode delivered twice is shown once', () => withTZ('UTC', () => {
  const one = release({ number: 5 });
  const events = groupReleaseEvents([one, { ...one }, { ...one }], wednesday());
  assert.equal(events.length, 1);
  assert.equal(events[0].episodes.length, 1);
}));

test('confirmed air times convert to the viewer’s local day and time', () => {
  // 21:00 Eastern on 11 Nov is 02:00 UTC on 12 Nov.
  const timed = release({ season: 2, number: 4, airDate: '2026-11-11', airTime: '21:00', airTimestamp: '2026-11-12T02:00:00.000Z', seasonPremiere: false });
  withTZ('America/New_York', () => {
    assert.equal(releaseDay(timed), '2026-11-11');
    assert.equal(timeLabel(timed.airTimestamp, 'en-US'), '9:00 PM');
  });
  withTZ('Europe/Paris', () => {
    assert.equal(releaseDay(timed), '2026-11-12');
    assert.equal(timeLabel(timed.airTimestamp, 'en-US'), '3:00 AM');
  });
  withTZ('Asia/Tokyo', () => assert.equal(releaseDay(timed), '2026-11-12'));
});

test('date-only releases keep their date in every time zone and never get a time', () => {
  const dateOnly = release({ airDate: '2026-11-11' });
  for (const tz of ['Pacific/Auckland', 'America/Los_Angeles', 'UTC', 'Asia/Kolkata']) withTZ(tz, () => {
    assert.equal(releaseDay(dateOnly), '2026-11-11', tz);
    const [event] = groupReleaseEvents([dateOnly], new Date(2026, 10, 11, 0, 5));
    assert.equal(event.timestamp, null);
    assert.equal(timeLabel(event.timestamp), null);
  });
});

test('days before the local today are dropped; an evening release earlier today stays for the rest of the day', () => withTZ('Europe/Paris', () => {
  const now = new Date(2026, 10, 11, 23, 30);
  const events = groupReleaseEvents([
    release({ airDate: '2026-11-10' }),
    release({ number: 2, airDate: '2026-11-11', airTimestamp: '2026-11-11T18:00:00.000Z', airTime: '19:00' }),
  ], now);
  assert.deepEqual(events.map(e => e.day), ['2026-11-11']);
}));

test('Today, This Week, This Month and Season Premieres use local calendar boundaries', () => withTZ('Europe/Paris', () => {
  const now = wednesday();
  assert.deepEqual(weekBounds(now), ['2026-11-09', '2026-11-16']);
  const events = groupReleaseEvents([
    release({ number: 1, airDate: '2026-11-11' }), // today, premiere
    release({ showId: 'b', id: 'b1', season: 1, number: 6, airDate: '2026-11-15', seasonPremiere: false }), // Sunday, same week
    release({ showId: 'c', id: 'c1', season: 2, number: 3, airDate: '2026-11-16', seasonPremiere: false }), // next Monday
    release({ showId: 'd', id: 'd1', season: 5, number: 1, airDate: '2026-12-01' }), // next month, premiere
    // Late on Sunday 15 Nov in New York is Monday 16 Nov in Paris: next week here.
    release({ showId: 'e', id: 'e1', season: 1, number: 2, airDate: '2026-11-15', airTime: '23:00', airTimestamp: '2026-11-16T04:00:00.000Z', seasonPremiere: false }),
  ], now);
  const days = filter => filterEvents(events, filter, now).map(e => `${e.showId}@${e.day}`);
  assert.deepEqual(days('today'), ['rings@2026-11-11']);
  assert.deepEqual(days('week'), ['rings@2026-11-11', 'b@2026-11-15']);
  assert.deepEqual(days('month'), ['rings@2026-11-11', 'b@2026-11-15', 'c@2026-11-16', 'e@2026-11-16']);
  assert.deepEqual(days('premieres'), ['rings@2026-11-11', 'd@2026-12-01']);
  assert.equal(days('all').length, 5);
  assert.deepEqual(calendarStats(events), { episodes: 5, shows: 5, premieres: 2 });
}));

test('Sunday belongs to the week that started on Monday', () => withTZ('UTC', () => {
  assert.deepEqual(weekBounds(new Date(2026, 10, 15, 12)), ['2026-11-09', '2026-11-16']);
  assert.deepEqual(weekBounds(new Date(2026, 10, 16, 0, 1)), ['2026-11-16', '2026-11-23']);
}));

test('labels: date headings, short dates and episode lines', () => withTZ('UTC', () => {
  assert.equal(dayHeading('2026-11-11', 'en-US'), 'WEDNESDAY · NOV 11');
  assert.equal(dayHeading('2026-11-13', 'en-US'), 'FRIDAY · NOV 13');
  const now = wednesday();
  assert.equal(shortDay('2026-11-11', now), 'Today');
  assert.equal(shortDay('2026-11-12', now), 'Tomorrow');
  assert.equal(shortDay('2026-11-13', now, 'en-US'), 'Fri, Nov 13');
  const one = groupReleaseEvents([release({ season: 2, number: 5, seasonPremiere: false })], now)[0];
  assert.equal(eventEpisodeLine(one), 'S02E05');
  assert.equal(eventEpisodeLine(groupReleaseEvents([release({ season: 1, number: 1 })], now)[0]), 'S01E01 · Series premiere');
  const gaps = groupReleaseEvents([release({ season: 2, number: 2, seasonPremiere: false }), release({ season: 2, number: 5, seasonPremiere: false })], now)[0];
  assert.equal(eventEpisodeLine(gaps), 'Season 2 · Episodes 2, 5');
  const twoSeasons = groupReleaseEvents([release({ season: 1, number: 8, seasonPremiere: false }), release({ season: 2, number: 1 })], now)[0];
  assert.equal(eventEpisodeLine(twoSeasons), 'Seasons 1, 2 · 2 episodes');
}));

test('empty schedule: no events, no days', () => {
  assert.deepEqual(groupReleaseEvents([], new Date()), []);
  assert.deepEqual(groupByDay([]), []);
  assert.deepEqual(filterEvents([], 'today', new Date()), []);
  assert.equal(dayKey(new Date(2026, 0, 5)), '2026-01-05');
});

test('Home "Coming soon" is the first three events of the Upcoming calendar', () => withTZ('Europe/Paris', () => {
  const now = wednesday();
  const releases = [
    ...[1, 2, 3, 4].map(number => release({ number })),
    release({ showId: 'b', id: 'b1', season: 1, number: 2, airDate: '2026-11-12', seasonPremiere: false }),
    release({ showId: 'c', id: 'c1', season: 4, number: 1, airDate: '2026-11-13' }),
    release({ showId: 'd', id: 'd1', season: 2, number: 9, airDate: '2026-11-20', seasonPremiere: false }),
  ];
  const upcomingPage = filterEvents(groupReleaseEvents(releases, now), 'all', now);
  const home = groupReleaseEvents(releases, now).slice(0, 3);
  assert.deepEqual(home.map(e => e.key), upcomingPage.slice(0, 3).map(e => e.key));
  assert.deepEqual(home.map(e => [e.showId, e.episodes.length]), [['rings', 4], ['b', 1], ['c', 1]]);
}));
