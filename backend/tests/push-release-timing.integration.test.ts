/**
 * Web Push never announces an episode before Cinetra releases it (the catalog's effective releaseAt: verified TVMaze
 * premiere, documented manual override or conservative fallback). De-duplication, eligibility, preferences and the
 * opt-in rule are unchanged. Disposable local PostgreSQL; TVMaze and release times are simulated; nothing leaves
 * this machine; tracking tables are compared byte for byte around every run.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { IdentityResult, TVMazeEpisode, TVMazeShow } from '../src/services/tvmaze/tvmaze-schedule.model';

if (!process.env.DATABASE_URL?.includes('/cinetra_push_test_20261110')) throw new Error('Use the disposable push notification test database only.');
Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: crypto.randomBytes(32).toString('hex') });

const identities = new Map<number, IdentityResult>();
const schedules = new Map<number, { show: TVMazeShow; episodes: TVMazeEpisode[] }>();
type Release = { found: boolean; releaseAt: string | null; numberingVerified: boolean };
const releases = new Map<string, Release | 'error'>();
const source = {
  resolve: async (show: { tmdbId: number }) => identities.get(show.tmdbId) ?? { status: 'unresolved' as const, reason: 'not_on_tvmaze' as const },
  schedule: async (id: number) => structuredClone(schedules.get(id)!),
  refreshChanged: async () => undefined,
  releaseAt: async (show: { tmdbId: number }, season: number, number: number) => {
    const r = releases.get(`${show.tmdbId}:${season}:${number}`);
    if (r === 'error') throw new Error('TMDB unavailable');
    return r ?? { found: false, releaseAt: null, numberingVerified: true };
  },
};
const tvShow = (id: number, timezone: string | null): TVMazeShow => ({ id, name: `TVMaze ${id}`, status: 'Running', network: timezone ? { name: 'Net', country: { timezone } } : null, webChannel: timezone ? null : { name: 'Streamer', country: null } });
const timed = (id: number, season: number, number: number, iso: string): TVMazeEpisode => ({ id, season, number, type: 'regular', airdate: iso.slice(0, 10), airtime: '21:00', airstamp: iso });
const dateOnly = (id: number, season: number, number: number, airdate: string): TVMazeEpisode => ({ id, season, number, type: 'regular', airdate, airtime: '', airstamp: `${airdate}T12:00:00+00:00` });

const sent: { endpoint: string; body: string; topic?: string }[] = [];
const sender = { async send(target: { endpoint: string }, payload: { body: string }, options: { topic?: string }) { sent.push({ endpoint: target.endpoint, body: payload.body, topic: options.topic }); return { statusCode: 201 }; } };
const T = (iso: string) => new Date(iso);
const keys = () => { const e = crypto.createECDH('prime256v1'); e.generateKeys(); return { p256dh: e.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') }; };

async function main() {
  const { prisma } = await import('../src/database/prisma');
  const { runEpisodeNotifications } = await import('../src/services/notifications/episode-notifier.service');
  const { saveSubscription } = await import('../src/services/notifications/push-subscription.service');
  await prisma.$executeRawUnsafe('TRUNCATE "NotificationDelivery", "PushSubscription", "NotificationPreference", "EpisodeUnwatch", "EpisodeWatch", "MovieWatch", "Movie", "Show", "User" CASCADE');
  const tracking = async () => JSON.stringify([await prisma.show.findMany({ orderBy: { id: 'asc' } }), await prisma.episodeWatch.findMany({ orderBy: { id: 'asc' } }), await prisma.episodeUnwatch.findMany({ orderBy: { id: 'asc' } })]);
  const run = async (now: string) => {
    const before = await tracking();
    const report = await runEpisodeNotifications({ sender, source, now: T(now) });
    assert.equal(await tracking(), before, 'the notifier never modifies tracking data');
    return report;
  };
  const bodies = (endpoint: string) => sent.filter(s => s.endpoint === endpoint).map(s => /S\d+E\d+/.exec(s.body)![0]);

  const user = await prisma.user.create({ data: { email: `release-${crypto.randomUUID()}@example.invalid`, username: 'release', password: 'not-a-password' } });
  const show = (name: string, tmdbId: number, tvmazeId: number, data: Record<string, unknown> = {}) => {
    identities.set(tmdbId, { status: 'verified', tvmazeId, method: 'external_id' });
    return prisma.show.create({ data: { userId: user.id, name, tmdbId, status: 'watching', ...data } });
  };
  const PHONE = 'https://web.push.apple.com/release-phone';
  await saveSubscription(user.id, { endpoint: PHONE, ...keys() }, 'iPhone', T('2026-11-01T00:00:00Z'));

  // The Gilded Age: verified TVMaze exact premiere (HBO, 21:00 New York) = Cinetra's release instant.
  await show('The Gilded Age', 81723, 34685, { seasonsWatched: 4, episodesWatched: 3 });
  schedules.set(34685, { show: tvShow(34685, 'America/New_York'), episodes: [timed(3808839, 4, 4, '2026-11-23T02:00:00Z')] });
  releases.set('81723:4:4', { found: true, releaseAt: '2026-11-23T02:00:00.000Z', numberingVerified: true });
  // The Rings of Power: date-only streaming drop on TVMaze; a documented manual time (fixture) of 2026-11-25T02:00Z.
  await show('The Rings of Power', 84773, 33352, { seasonsWatched: 3, episodesWatched: 6 });
  schedules.set(33352, { show: tvShow(33352, null), episodes: [dateOnly(3682723, 3, 7, '2026-11-25')] });
  releases.set('84773:3:7', { found: true, releaseAt: '2026-11-25T02:00:00.000Z', numberingVerified: true });
  // Nocturne: TVMaze says Wednesday 2026-11-25, TMDB Thursday 2026-11-26 → Cinetra's conservative fallback 11-27 12:00Z.
  await show('Nocturne', 292741, 66811, { seasonsWatched: 1, episodesWatched: 5 });
  schedules.set(66811, { show: tvShow(66811, null), episodes: [dateOnly(3665760, 1, 6, '2026-11-25')] });
  releases.set('292741:1:6', { found: true, releaseAt: '2026-11-27T12:00:00.000Z', numberingVerified: true });
  // Ambiguous numbering (split finale): TVMaze S4E29 is not on TMDB; TVMaze S4E28 maps only by number.
  await show('Split Finale', 1429, 919, { seasonsWatched: 4, episodesWatched: 27 });
  schedules.set(919, { show: tvShow(919, 'Asia/Tokyo'), episodes: [timed(2291261, 4, 28, '2026-11-21T15:10:00Z'), timed(2474146, 4, 29, '2026-11-22T15:10:00Z')] });
  releases.set('1429:4:28', { found: true, releaseAt: '2026-11-22T12:00:00.000Z', numberingVerified: false });
  // Silo: TMDB unavailable during the first attempt.
  await show('Silo', 125988, 1001, { seasonsWatched: 3, episodesWatched: 10 });
  schedules.set(1001, { show: tvShow(1001, 'America/New_York'), episodes: [timed(5003, 4, 1, '2026-11-22T01:00:00Z')] });
  releases.set('125988:4:1', 'error');
  // Dropped shows stay silent whatever the release time.
  await show('Dropped Drama', 77, 7700, { status: 'dropped' });
  schedules.set(7700, { show: tvShow(7700, 'America/New_York'), episodes: [timed(77001, 2, 1, '2026-11-21T02:00:00Z')] });
  releases.set('77:2:1', { found: true, releaseAt: '2026-11-21T02:00:00.000Z', numberingVerified: true });

  // 2026-11-22T00:30Z: inside the old early window for the Gilded Age (TMDB date 11-22) — nothing is announced.
  let r = await run('2026-11-22T00:30:00Z');
  assert.deepEqual(bodies(PHONE), [], 'nothing before any release instant');
  assert.equal(r.releaseUnknown, 1, 'Silo: release time unknown, retried later, never guessed');
  r = await run('2026-11-22T01:30:00Z');
  assert.deepEqual(bodies(PHONE), [], 'Silo still unknown; nothing else released yet');

  // Release time becomes readable: Silo S4E1 premiered at 01:00Z (verified) and is announced once.
  releases.set('125988:4:1', { found: true, releaseAt: '2026-11-22T01:00:00.000Z', numberingVerified: true });
  await run('2026-11-22T01:45:00Z');
  assert.deepEqual(bodies(PHONE), ['S04E01']);

  // Split finale: TVMaze premiered S4E28 at 11-21 15:10Z, but numbering is unverified, so the later of TVMaze's
  // and Cinetra's instants decides (11-22 12:00Z). S4E29 does not exist on TMDB: never announced.
  r = await run('2026-11-22T11:59:00Z');
  assert.deepEqual(bodies(PHONE), ['S04E01']);
  assert.ok(r.awaitingRelease >= 1);
  await run('2026-11-22T12:00:00Z');
  assert.deepEqual(bodies(PHONE), ['S04E01', 'S04E28']);

  // The Gilded Age: 01:59Z nothing; 02:00Z exactly at the verified premiere.
  await run('2026-11-23T01:59:00Z');
  assert.deepEqual(bodies(PHONE), ['S04E01', 'S04E28']);
  await run('2026-11-23T02:00:00Z');
  assert.deepEqual(bodies(PHONE), ['S04E01', 'S04E28', 'S04E04']);

  // The Rings of Power: TVMaze alone would wait until 11-26 12:00Z; the documented time releases it at 11-25 02:00Z.
  await run('2026-11-25T01:59:00Z');
  assert.equal(bodies(PHONE).includes('S03E07'), false);
  await run('2026-11-25T02:00:00Z');
  assert.equal(bodies(PHONE).at(-1), 'S03E07');

  // Nocturne: TVMaze's own date-only rule says 11-26 12:00Z; Cinetra releases it at 11-27 12:00Z — so does the push.
  r = await run('2026-11-26T13:00:00Z');
  assert.equal(bodies(PHONE).includes('S01E06'), false, 'never before Cinetra releases it');
  await run('2026-11-27T12:00:00Z');
  assert.equal(bodies(PHONE).at(-1), 'S01E06');

  // Repeated runs, as after restarts: no duplicates; the dropped show never notified.
  for (const now of ['2026-11-27T12:15:00Z', '2026-11-27T12:30:00Z', '2026-11-28T00:00:00Z']) await run(now);
  assert.deepEqual(bodies(PHONE).sort(), ['S01E06', 'S03E07', 'S04E01', 'S04E04', 'S04E28']);
  assert.equal(new Set(sent.map(s => s.topic)).size, sent.length, 'one push per TVMaze episode');
  const ledger = await prisma.notificationDelivery.findMany({ orderBy: { premieredAt: 'asc' } });
  assert.equal(ledger.length, 5);
  // The ledger records when the episode became available in Cinetra.
  assert.deepEqual(ledger.map(d => [d.season, d.episode, d.premieredAt.toISOString()]), [
    [4, 1, '2026-11-22T01:00:00.000Z'], [4, 28, '2026-11-22T12:00:00.000Z'], [4, 4, '2026-11-23T02:00:00.000Z'],
    [3, 7, '2026-11-25T02:00:00.000Z'], [1, 6, '2026-11-27T12:00:00.000Z'],
  ]);

  // Opt-in rule follows the release instant: a device enabled after Cinetra released an episode gets no backlog.
  const LATE = 'https://web.push.apple.com/late-tablet';
  await saveSubscription(user.id, { endpoint: LATE, ...keys() }, 'iPad', T('2026-11-26T00:00:00Z'));
  r = await run('2026-11-26T20:00:00Z');
  assert.deepEqual(bodies(LATE), [], 'The Rings of Power S03E07 was released (11-25 02:00Z) before this device opted in');
  assert.ok(r.beforeOptIn >= 1);
  await run('2026-11-27T12:00:00Z');
  assert.deepEqual(bodies(LATE), ['S01E06'], 'Nocturne S01E06 was released after this device opted in');

  // Never replay history. A TVMaze premiere 3 days old whose (conflicting, conservative) Cinetra release was only
  // yesterday is not announced, nor is an episode TVMaze dated before a device opted in.
  await show('Old Conflict', 501, 5010);
  schedules.set(5010, { show: tvShow(5010, 'America/New_York'), episodes: [timed(50101, 1, 3, '2026-11-26T02:00:00Z')] });
  releases.set('501:1:3', { found: true, releaseAt: '2026-11-28T12:00:00.000Z', numberingVerified: true });
  await show('Opt-in Gap', 502, 5020);
  schedules.set(5020, { show: tvShow(5020, 'America/New_York'), episodes: [timed(50201, 2, 1, '2026-11-28T20:00:00Z')] });
  releases.set('502:2:1', { found: true, releaseAt: '2026-11-29T12:00:00.000Z', numberingVerified: true });
  const NEW = 'https://web.push.apple.com/new-laptop';
  await saveSubscription(user.id, { endpoint: NEW, ...keys() }, 'Mac', T('2026-11-29T00:00:00Z'));
  r = await run('2026-11-29T13:00:00Z');
  assert.equal(sent.some(x => /S01E03/.test(x.body)), false, 'Old Conflict S01E03: TVMaze premiered it before the lookback; never announced');
  assert.deepEqual(bodies(NEW), [], 'no backlog for a device enabled after TVMaze dated the episode');
  assert.equal(bodies(PHONE).at(-1), 'S02E01', 'the long-subscribed phone still hears about the genuinely new episode');
  assert.ok(r.beforeOptIn >= 1, 'Opt-in Gap: TVMaze dated it before the laptop opted in');

  await prisma.$disconnect();
  console.log('Push release timing integration tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
