import assert from 'node:assert/strict';
import { episodePayload, isEpisodeWatched, isShowEligible, premiereInstant, scheduleTimeZone, selectPremieredEpisodes, testPayload, zonedMidnight } from '../src/services/notifications/episode-alerts.model';
import { classifySend, parseSubscription, vapidConfig } from '../src/services/notifications/push-sender';
import type { TVMazeEpisode } from '../src/services/tvmaze/tvmaze-schedule.model';
import webpush from 'web-push';

const ep = (id: number, season: number | null, number: number | null, airdate: string | null, extra: Partial<TVMazeEpisode> = {}): TVMazeEpisode => ({ id, season, number, type: 'regular', airdate, airtime: null, airstamp: null, ...extra });
const timed = (id: number, season: number, number: number, airstamp: string) => ep(id, season, number, airstamp.slice(0, 10), { airtime: '21:00', airstamp });

// --- Premiere timing -------------------------------------------------------------------------------------------
// Exact: TVMaze air time + airstamp.
assert.deepEqual(premiereInstant(timed(1, 3, 2, '2026-11-08T02:00:00+00:00'), 'America/New_York'), { at: new Date('2026-11-08T02:00:00Z'), timing: 'exact' });
// Date-only with a known zone: premiered once the listed local day has ended (next local midnight), not before.
assert.deepEqual(premiereInstant(ep(2, 1, 1, '2026-11-07'), 'America/New_York'), { at: new Date('2026-11-08T05:00:00Z'), timing: 'date_only_local' });
assert.deepEqual(premiereInstant(ep(2, 1, 1, '2026-07-07'), 'America/New_York'), { at: new Date('2026-07-08T04:00:00Z'), timing: 'date_only_local' }, 'summer time');
assert.deepEqual(premiereInstant(ep(2, 1, 1, '2026-11-07'), 'Asia/Tokyo'), { at: new Date('2026-11-07T15:00:00Z'), timing: 'date_only_local' });
// DST switch day (Europe/London leaves summer time on 2026-10-25): local midnight of the 26th is 00:00 UTC.
assert.equal(zonedMidnight('2026-10-26', 'Europe/London')!.toISOString(), '2026-10-26T00:00:00.000Z');
assert.equal(zonedMidnight('2026-10-25', 'Europe/London')!.toISOString(), '2026-10-24T23:00:00.000Z');
// Date-only without a zone (typical global streaming drop): the day must have ended everywhere (UTC-12).
assert.deepEqual(premiereInstant(ep(3, 1, 1, '2026-11-07'), null), { at: new Date('2026-11-08T12:00:00Z'), timing: 'date_only_worldwide' });
assert.deepEqual(premiereInstant(ep(3, 1, 1, '2026-11-07'), 'Not/AZone'), { at: new Date('2026-11-08T12:00:00Z'), timing: 'date_only_worldwide' }, 'unknown zone falls back');
// A time without an airstamp is not trusted as exact.
assert.equal(premiereInstant(ep(4, 1, 1, '2026-11-07', { airtime: '20:00', airstamp: null }), null)!.timing, 'date_only_worldwide');
// Undated / rumoured episodes have no premiere.
assert.equal(premiereInstant(ep(5, 1, 1, null), null), null);
assert.equal(premiereInstant(ep(5, 1, 1, ''), null), null);
assert.equal(premiereInstant(ep(5, 1, 1, '2026'), null), null);
assert.equal(scheduleTimeZone({ network: { name: 'AMC', country: { timezone: 'America/New_York' } }, webChannel: null }), 'America/New_York');
assert.equal(scheduleTimeZone({ network: null, webChannel: { name: 'Apple TV+', country: null } }), null);

// --- Selecting newly premiered episodes -------------------------------------------------------------------------
const now = new Date('2026-11-10T12:00:00Z');
const window = { since: new Date(now.getTime() - 48 * 3600_000), now };
const list: TVMazeEpisode[] = [
  timed(100, 3, 1, '2026-11-03T02:00:00+00:00'), // premiered a week ago: too old
  timed(101, 3, 2, '2026-11-10T02:00:00+00:00'), // premiered 10 hours ago: new
  timed(101, 3, 2, '2026-11-10T02:00:00+00:00'), // the same TVMaze record twice: duplicate
  timed(150, 3, 1, '2026-11-10T03:00:00+00:00'), // another record for S3E1, which premiered earlier: rerun
  timed(102, 3, 3, '2026-11-17T02:00:00+00:00'), // next week: not yet
  timed(103, 0, 1, '2026-11-10T01:00:00+00:00'), // season 0
  ep(104, 3, null, '2026-11-10'), // unnumbered
  timed(105, 3, 90, '2026-11-10T01:00:00+00:00'), // special type
  ep(106, 3, 4, null), // undated
  ep(107, 3, 5, '2026-11-10'), // date-only today: has not ended everywhere yet
  ep(108, 3, 6, '2026-11-08'), // date-only, day ended worldwide at 2026-11-09T12:00Z: new
];
list[7] = { ...list[7], type: 'significant_special' };
const picked = selectPremieredEpisodes(list, window, null);
assert.deepEqual(picked.episodes.map(e => e.tvmazeEpisodeId), [108, 101]);
assert.deepEqual(picked.excluded, { specials: 3, undated: 1, duplicates: 1, repeats: 1, notYet: 2, tooOld: 1 });
assert.equal(picked.episodes.find(e => e.tvmazeEpisodeId === 108)!.timing, 'date_only_worldwide');
// With the network's zone, a date-only episode from yesterday (New York) counts as soon as that day ended there.
assert.deepEqual(selectPremieredEpisodes([ep(200, 1, 1, '2026-11-09')], window, 'America/New_York').episodes.map(e => e.premieredAt.toISOString()), ['2026-11-10T05:00:00.000Z']);
// Without a zone the same episode waits until 9 Nov has ended everywhere: 10 Nov 12:00 UTC.
assert.equal(selectPremieredEpisodes([ep(200, 1, 1, '2026-11-09')], { ...window, now: new Date('2026-11-10T11:59:00Z') }, null).episodes.length, 0);
assert.equal(selectPremieredEpisodes([ep(200, 1, 1, '2026-11-09')], window, null).episodes.length, 1);

// --- Viewing history (read-only checks) -------------------------------------------------------------------------
const none: { season: number; episode: number }[] = [];
// S2E0: season 1 completed; season 2 not yet watched.
assert.equal(isEpisodeWatched({ seasonsWatched: 2, episodesWatched: 0 }, none, 1, 10), true);
assert.equal(isEpisodeWatched({ seasonsWatched: 2, episodesWatched: 0 }, none, 2, 1), false);
// S3E0: seasons 1 and 2 completed.
assert.equal(isEpisodeWatched({ seasonsWatched: 3, episodesWatched: 0 }, none, 2, 12), true);
assert.equal(isEpisodeWatched({ seasonsWatched: 3, episodesWatched: 0 }, none, 3, 1), false);
// S2E3: first three regular episodes of season 2 watched.
assert.equal(isEpisodeWatched({ seasonsWatched: 2, episodesWatched: 3 }, none, 2, 3), true);
assert.equal(isEpisodeWatched({ seasonsWatched: 2, episodesWatched: 3 }, none, 2, 4), false);
assert.equal(isEpisodeWatched({ seasonsWatched: 2, episodesWatched: 3 }, none, 3, 1), false);
// Nothing saved, or an invalid position, covers nothing; explicit records always count.
assert.equal(isEpisodeWatched({ seasonsWatched: 0, episodesWatched: 0 }, none, 1, 1), false);
assert.equal(isEpisodeWatched({ seasonsWatched: 0, episodesWatched: 5 }, none, 1, 1), false);
assert.equal(isEpisodeWatched({ seasonsWatched: -1, episodesWatched: 0 }, none, 1, 1), false);
assert.equal(isEpisodeWatched({ seasonsWatched: 0, episodesWatched: 0 }, [{ season: 4, episode: 2 }], 4, 2), true);
assert.equal(isEpisodeWatched({ seasonsWatched: 2, episodesWatched: 3 }, [{ season: 2, episode: 7 }], 2, 7), true);

// --- Eligibility: all except Dropped ----------------------------------------------------------------------------
for (const status of ['watching', 'completed', 'planned', 'paused', null]) assert.equal(isShowEligible({ status }), true, String(status));
assert.equal(isShowEligible({ status: 'dropped' }), false);

// --- Payload ----------------------------------------------------------------------------------------------------
const payload = episodePayload({ showName: 'Silo', showId: 'c0ffee00-0000-4000-8000-000000000001', tvmazeShowId: 44778, tvmazeEpisodeId: 3001, season: 3, number: 2 });
assert.deepEqual(payload, { title: 'New episode of Silo', body: 'Season 3, Episode 2 has premiered.', url: '/shows?show=c0ffee00-0000-4000-8000-000000000001', tag: 'episode-44778-3001', icon: '/icon-192.png?v=2', badge: '/icon-192.png?v=2' });
assert.ok(!/token|bearer|auth|@|streaming|netflix/i.test(JSON.stringify(payload)), 'no credentials, emails or availability claims');
assert.ok(!/token|bearer|@/i.test(JSON.stringify(testPayload())));

// --- Push results -----------------------------------------------------------------------------------------------
assert.equal(classifySend({ statusCode: 201 }), 'delivered');
assert.equal(classifySend({ statusCode: 410 }), 'gone');
assert.equal(classifySend({ statusCode: 404 }), 'gone');
assert.equal(classifySend({ statusCode: 429 }), 'retry');
assert.equal(classifySend({ statusCode: 503 }), 'retry');
assert.equal(classifySend({ statusCode: 400 }), 'failed');
assert.equal(classifySend({ statusCode: 403 }), 'failed');
assert.equal(classifySend({ statusCode: 500 }), 'uncertain');
assert.equal(classifySend({ statusCode: null }), 'uncertain');

// --- Subscription validation ------------------------------------------------------------------------------------
const keys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
const prod = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
assert.ok(parseSubscription({ endpoint: 'https://web.push.apple.com/QGuQyavXutnMH', keys }, prod), 'Apple (iOS Home Screen apps)');
assert.ok(parseSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc:APA91b', keys }, prod), 'FCM');
assert.ok(parseSubscription({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/gAAA', keys }, prod), 'Mozilla');
assert.equal(parseSubscription({ endpoint: 'http://web.push.apple.com/x', keys }, prod), null, 'https only');
assert.equal(parseSubscription({ endpoint: 'https://evil.example.com/x', keys }, prod), null, 'unknown host (SSRF)');
assert.equal(parseSubscription({ endpoint: 'https://web.push.apple.com.evil.com/x', keys }, prod), null, 'look-alike host');
assert.equal(parseSubscription({ endpoint: 'https://web.push.apple.com:8443/x', keys }, prod), null, 'custom port');
assert.equal(parseSubscription({ endpoint: 'https://user:pw@web.push.apple.com/x', keys }, prod), null, 'credentials in URL');
assert.equal(parseSubscription({ endpoint: 'https://127.0.0.1:9999/push', keys }, { NODE_ENV: 'production', PUSH_ALLOW_LOCAL_ENDPOINTS: 'true' } as NodeJS.ProcessEnv), null, 'local endpoints never in production');
assert.ok(parseSubscription({ endpoint: 'https://127.0.0.1:9999/push', keys }, { NODE_ENV: 'test', PUSH_ALLOW_LOCAL_ENDPOINTS: 'true' } as NodeJS.ProcessEnv), 'local endpoints for tests');
assert.equal(parseSubscription({ endpoint: 'https://127.0.0.1:9999/push', keys }, { NODE_ENV: 'test' } as NodeJS.ProcessEnv), null, 'only with the explicit test flag');
assert.equal(parseSubscription({ endpoint: 'https://web.push.apple.com/x', keys: { ...keys, p256dh: 'short' } }, prod), null, 'bad key');
assert.equal(parseSubscription({ endpoint: 'https://web.push.apple.com/x', keys: { ...keys, auth: 'tBHItJI5' } }, prod), null, 'bad auth');
assert.equal(parseSubscription({ endpoint: 'https://web.push.apple.com/x' }, prod), null, 'no keys');
assert.equal(parseSubscription(null, prod), null);
assert.equal(parseSubscription({ endpoint: `https://web.push.apple.com/${'a'.repeat(3000)}`, keys }, prod), null, 'oversized');

// --- VAPID configuration ----------------------------------------------------------------------------------------
const vapid = webpush.generateVAPIDKeys();
assert.equal(vapidConfig({} as NodeJS.ProcessEnv), null, 'not configured');
assert.deepEqual(vapidConfig({ VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:ops@example.com' } as NodeJS.ProcessEnv), { publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: 'mailto:ops@example.com' });
assert.throws(() => vapidConfig({ VAPID_PUBLIC_KEY: vapid.publicKey } as NodeJS.ProcessEnv), /together/);
assert.throws(() => vapidConfig({ VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'ops' } as NodeJS.ProcessEnv), /VAPID_SUBJECT/);
assert.throws(() => vapidConfig({ VAPID_PUBLIC_KEY: 'abc', VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:a@b.c' } as NodeJS.ProcessEnv), /P-256/);

console.log('Episode alert rule tests passed');
