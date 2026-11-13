/**
 * New-episode push notifications against a disposable local PostgreSQL database.
 *
 * TVMaze is simulated through the notifier's ScheduleSource; pushes go to a mock sender or to a fake push service on
 * 127.0.0.1 that verifies the VAPID JWT and decrypts the RFC 8291 (aes128gcm) payload exactly as a browser would.
 * Nothing leaves this machine.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import webpush from 'web-push';
import jwt from 'jsonwebtoken';
import type { IdentityResult, TVMazeEpisode, TVMazeShow } from '../src/services/tvmaze/tvmaze-schedule.model';

if (!process.env.DATABASE_URL?.includes('/cinetra_push_test_20261110')) throw new Error('Use the disposable push notification test database only.');
const vapid = webpush.generateVAPIDKeys();
Object.assign(process.env, {
  NODE_ENV: 'test', JWT_SECRET: crypto.randomBytes(32).toString('hex'), PUSH_ALLOW_LOCAL_ENDPOINTS: 'true',
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:push-test@example.invalid',
});

// ---------------------------------------------------------------------------------------------------------------
// A browser-side subscription key pair, and a fake push service that behaves like Apple/FCM/Mozilla.
const b64u = (buf: Buffer) => buf.toString('base64url');
function browserKeys() {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  return { ecdh, p256dh: b64u(ecdh.getPublicKey()), auth: b64u(crypto.randomBytes(16)) };
}
type Browser = ReturnType<typeof browserKeys>;
/** RFC 8291 + RFC 8188 decryption, as the user agent does it. */
function decrypt(body: Buffer, browser: Browser) {
  const salt = body.subarray(0, 16); const idlen = body[20]; const serverKey = body.subarray(21, 21 + idlen); const ciphertext = body.subarray(21 + idlen);
  const secret = browser.ecdh.computeSecret(serverKey);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.from(browser.auth, 'base64url'), Buffer.concat([Buffer.from('WebPush: info\0'), browser.ecdh.getPublicKey(), serverKey]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  let end = padded.length - 1; while (end >= 0 && padded[end] === 0) end--;
  assert.equal(padded[end], 2, 'last-record padding delimiter');
  return JSON.parse(padded.subarray(0, end).toString('utf8'));
}
const pushService = { received: [] as { path: string; payload: Record<string, unknown>; headers: http.IncomingHttpHeaders }[], browsers: new Map<string, Browser>(), status: new Map<string, number>(), origin: '' };
// Throwaway self-signed certificate for 127.0.0.1 (web-push always uses HTTPS; TLS verification stays on).
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinetra-push-test-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem')], { stdio: 'ignore' });
const tls = { key: fs.readFileSync(path.join(certDir, 'key.pem')), cert: fs.readFileSync(path.join(certDir, 'cert.pem')) };
fs.rmSync(certDir, { recursive: true, force: true });
const fakePush = https.createServer(tls, (req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const path = req.url || '';
    const browser = pushService.browsers.get(path);
    if (!browser) { res.writeHead(404).end(); return; }
    // VAPID: "vapid t=<ES256 JWT>, k=<public key>"; the JWT must be signed by the server's private key.
    const auth = /^vapid t=([^,]+), k=(.+)$/.exec(String(req.headers.authorization || ''));
    assert.ok(auth, 'VAPID Authorization header');
    assert.equal(auth![2], vapid.publicKey);
    const raw = Buffer.from(vapid.publicKey, 'base64url');
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: 'jwk' });
    const claims = jwt.verify(auth![1], key, { algorithms: ['ES256'] }) as { aud: string; sub: string; exp: number };
    assert.equal(claims.aud, pushService.origin); assert.equal(claims.sub, 'mailto:push-test@example.invalid');
    assert.equal(req.headers['content-encoding'], 'aes128gcm');
    assert.ok(Number(req.headers.ttl) > 0);
    pushService.received.push({ path, payload: decrypt(Buffer.concat(chunks), browser), headers: req.headers });
    res.writeHead(pushService.status.get(path) ?? 201).end();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Simulated TVMaze (identity + per-show episode lists) and a recording mock sender.
const identities = new Map<number, IdentityResult>();
const schedules = new Map<number, { show: TVMazeShow; episodes: TVMazeEpisode[] }>();
let scheduleReads = 0;
const source = {
  resolve: async (show: { tmdbId: number }) => identities.get(show.tmdbId) ?? { status: 'unresolved' as const, reason: 'not_on_tvmaze' as const },
  schedule: async (id: number) => { scheduleReads++; const s = schedules.get(id); if (!s) throw new Error('TVMaze unavailable'); return structuredClone(s); },
  refreshChanged: async () => undefined,
};
const verified = (tmdbId: number, tvmazeId: number) => identities.set(tmdbId, { status: 'verified', tvmazeId, method: 'external_id' });
const tvShow = (id: number, timezone: string | null = 'America/New_York'): TVMazeShow => ({ id, name: `TVMaze ${id}`, status: 'Running', network: { name: 'Net', country: timezone ? { timezone } : null }, webChannel: null });
const timed = (id: number, season: number, number: number, iso: string, type = 'regular'): TVMazeEpisode => ({ id, season, number, type, airdate: iso.slice(0, 10), airtime: '21:00', airstamp: iso });
const dateOnly = (id: number, season: number, number: number, airdate: string): TVMazeEpisode => ({ id, season, number, type: 'regular', airdate, airtime: '', airstamp: null });

type Sent = { endpoint: string; title: string; body: string; url: string; topic?: string };
const sent: Sent[] = [];
const scripted = new Map<string, (number | null)[]>();
let sendDelayMs = 0;
const mockSender = {
  async send(target: { endpoint: string }, payload: { title: string; body: string; url: string }, options: { topic?: string }) {
    if (sendDelayMs) await new Promise(r => setTimeout(r, sendDelayMs));
    const queue = scripted.get(`${target.endpoint}#${options.topic}`)?.length ? scripted.get(`${target.endpoint}#${options.topic}`) : scripted.get(target.endpoint);
    const status = queue?.length ? queue.shift()! : 201;
    if (status !== null && status >= 200 && status < 300) sent.push({ endpoint: target.endpoint, title: payload.title, body: payload.body, url: payload.url, topic: options.topic });
    return status === null ? { statusCode: null, error: 'timeout' } : { statusCode: status };
  },
};
const sentTo = (endpoint: string) => sent.filter(s => s.endpoint === endpoint).map(s => s.body.replace(' has premiered.', '') + ' · ' + s.title.replace('New episode of ', ''));

const T = (iso: string) => new Date(iso);
const keysFor = () => { const k = browserKeys(); return { p256dh: k.p256dh, auth: k.auth }; };

async function main() {
  const { prisma } = await import('../src/database/prisma');
  const { runEpisodeNotifications } = await import('../src/services/notifications/episode-notifier.service');
  const { saveSubscription } = await import('../src/services/notifications/push-subscription.service');
  const { webPushSender, vapidConfig, useTransportAgent } = await import('../src/services/notifications/push-sender');
  const reset = () => prisma.$executeRawUnsafe('TRUNCATE "NotificationDelivery", "PushSubscription", "NotificationPreference", "EpisodeWatch", "MovieWatch", "Movie", "Show", "User" CASCADE');
  await reset();

  // Tracking tables must be byte-for-byte identical before and after every notifier run.
  const tracking = async () => JSON.stringify([await prisma.show.findMany({ orderBy: { id: 'asc' } }), await prisma.episodeWatch.findMany({ orderBy: { id: 'asc' } })]);
  const run = async (now: Date, sender: Parameters<typeof runEpisodeNotifications>[0]['sender'] = mockSender) => {
    const before = await tracking();
    const report = await runEpisodeNotifications({ sender, source, now });
    assert.equal(await tracking(), before, 'the notifier never modifies tracking data');
    return report;
  };

  const user = (name: string) => prisma.user.create({ data: { email: `${name}-${crypto.randomUUID()}@example.invalid`, username: name, password: 'not-a-password' } });
  const a = await user('alice'); const b = await user('bob'); const c = await user('carol');
  const show = (userId: string, name: string, data: Record<string, unknown>) => prisma.show.create({ data: { userId, name, ...data } });

  // ----- Library: one of each case -----
  const silo = await show(a.id, 'Silo', { tmdbId: 125988, status: 'watching', seasonsWatched: 3, episodesWatched: 1, favorite: true });
  verified(125988, 1001);
  schedules.set(1001, { show: tvShow(1001), episodes: [
    timed(5001, 3, 1, '2026-11-03T02:00:00Z'),           // premiered last week (and watched)
    timed(5002, 3, 2, '2026-11-10T02:00:00Z'),           // NEW after opt-in
    timed(5002, 3, 2, '2026-11-10T02:00:00Z'),           // duplicate provider record
    timed(5090, 3, 1, '2026-11-10T03:00:00Z'),           // rerun of S3E1 under another record
    timed(5091, 0, 1, '2026-11-10T01:00:00Z'),           // season-zero special
    timed(5092, 3, 50, '2026-11-10T01:00:00Z', 'significant_special'),
    timed(5003, 3, 3, '2026-11-17T02:00:00Z'),           // not yet premiered
    { id: 5004, season: 3, number: 4, type: 'regular', airdate: null, airtime: null, airstamp: null }, // rumoured / undated
  ] });
  await show(a.id, 'Backlog Show', { tmdbId: 2, status: null }); verified(2, 1002);
  schedules.set(1002, { show: tvShow(1002), episodes: [timed(5100, 1, 4, '2026-11-09T20:00:00Z')] }); // premiered before opt-in
  await show(a.id, 'Dropped Show', { tmdbId: 3, status: 'dropped' }); verified(3, 1003);
  schedules.set(1003, { show: tvShow(1003), episodes: [timed(5200, 2, 1, '2026-11-10T04:00:00Z')] });
  const completed = await show(a.id, 'Finished Then Renewed', { tmdbId: 4, status: 'completed', completed: true, seasonsWatched: 2, episodesWatched: 0 }); verified(4, 1004);
  schedules.set(1004, { show: tvShow(1004), episodes: [timed(5300, 1, 8, '2026-01-01T02:00:00Z'), timed(5301, 2, 1, '2026-11-10T05:00:00Z')] });
  await show(a.id, 'Ahead By Checkpoint', { tmdbId: 5, status: 'watching', seasonsWatched: 2, episodesWatched: 3 }); verified(5, 1005);
  schedules.set(1005, { show: tvShow(1005), episodes: [timed(5400, 2, 3, '2026-11-10T04:00:00Z')] });             // S2E3 covered by S2E3
  await show(a.id, 'Seasons Done', { tmdbId: 55, status: 'watching', seasonsWatched: 3, episodesWatched: 0 }); verified(55, 1055);
  schedules.set(1055, { show: tvShow(1055), episodes: [timed(5450, 2, 9, '2026-11-10T04:00:00Z')] });            // late S2 episode, covered by S3E0
  const explicit = await show(a.id, 'Watched Early', { tmdbId: 6, status: 'watching' }); verified(6, 1006);
  await prisma.episodeWatch.create({ data: { showId: explicit.id, season: 1, episode: 5 } });
  schedules.set(1006, { show: tvShow(1006), episodes: [timed(5500, 1, 5, '2026-11-10T06:00:00Z')] });
  await show(a.id, 'Unverified Match', { tmdbId: 7, status: 'planned' }); identities.set(7, { status: 'unresolved', reason: 'weak_evidence' });
  schedules.set(1007, { show: tvShow(1007), episodes: [timed(5600, 1, 1, '2026-11-10T06:00:00Z')] });
  await show(a.id, 'Not Linked To TMDB', { status: 'paused' });
  await show(a.id, 'Stored Link Conflict', { tmdbId: 9, tvmazeId: 9999, status: 'watching' }); verified(9, 1009);
  schedules.set(1009, { show: tvShow(1009), episodes: [timed(5700, 1, 1, '2026-11-10T06:00:00Z')] });
  await show(a.id, 'Twin A', { tmdbId: 10, status: 'watching' }); await show(a.id, 'Twin B', { tmdbId: 11, status: 'watching' });
  verified(10, 1010); verified(11, 1010);
  schedules.set(1010, { show: tvShow(1010), episodes: [timed(5800, 1, 1, '2026-11-10T06:00:00Z')] });
  const dated = await show(a.id, 'Date Only Drama', { tmdbId: 12, status: 'paused' }); verified(12, 1012);
  schedules.set(1012, { show: tvShow(1012, 'America/New_York'), episodes: [dateOnly(5900, 1, 1, '2026-11-09'), dateOnly(5901, 1, 2, '2026-11-10')] });
  // Bob dropped Silo; Carol switched new-episode alerts off.
  await show(b.id, 'Silo', { tmdbId: 125988, status: 'dropped' });
  await show(c.id, 'Silo', { tmdbId: 125988, status: 'watching' });
  await prisma.notificationPreference.create({ data: { userId: c.id, newEpisodes: false } });

  const PHONE = 'https://web.push.apple.com/alice-phone';
  const optIn = T('2026-11-10T00:00:00Z');
  const phone = await saveSubscription(a.id, { endpoint: PHONE, ...keysFor() }, 'iPhone', optIn);
  await saveSubscription(b.id, { endpoint: 'https://web.push.apple.com/bob', ...keysFor() }, null, optIn);
  await saveSubscription(c.id, { endpoint: 'https://web.push.apple.com/carol', ...keysFor() }, null, optIn);

  // ===== 1. First pass: only genuinely new, unwatched, verified, eligible premieres after opt-in =====
  let r = await run(T('2026-11-10T12:00:00Z'));
  assert.deepEqual(sentTo(PHONE).sort(), [
    'Season 1, Episode 1 · Date Only Drama',          // date-only 9 Nov (New York) ended 10 Nov 05:00 UTC
    'Season 2, Episode 1 · Finished Then Renewed',    // Completed shows stay eligible for a new season
    'Season 3, Episode 2 · Silo',
  ]);
  assert.equal(sent.length, 3, 'Bob (Dropped) and Carol (switched off) get nothing');
  assert.deepEqual(sent.find(s => s.title === 'New episode of Silo'), { endpoint: PHONE, title: 'New episode of Silo', body: 'Season 3, Episode 2 has premiered.', url: `/shows?show=${silo.id}`, topic: 'ep5002' });
  assert.equal(r.beforeOptIn, 1, 'no backlog from before opt-in');
  assert.equal(r.alreadyWatched, 3, 'checkpoint S2E3, checkpoint S3E0 and an explicit record');
  assert.equal(r.unverifiedShows, 4, 'weak match, stored-link conflict and both shared-identity twins');
  assert.equal(r.users, 2, 'Carol opted out');
  assert.ok(r.exclusions.repeats >= 1 && r.exclusions.duplicates >= 1 && r.exclusions.specials >= 2 && r.exclusions.notYet >= 2 && r.exclusions.undated >= 1);
  const statuses = await prisma.show.findMany({ where: { id: { in: [completed.id, silo.id, dated.id] } }, select: { status: true, completed: true } });
  assert.deepEqual(statuses.map(s => s.status).sort(), ['completed', 'paused', 'watching'], 'statuses are never changed');
  console.log('✓ new, verified, eligible premieres only; Dropped, watched, unverified, specials, reruns and backlog excluded');

  // ===== 2. Repeated runs (scheduler ticks, restarts) never re-send =====
  for (const at of ['2026-11-10T12:15:00Z', '2026-11-10T12:30:00Z', '2026-11-10T18:00:00Z']) {
    r = await run(T(at));
    assert.equal(r.ledgerCreated, 0); assert.equal(r.delivered, 0);
  }
  assert.equal(sent.length, 3);
  // A refreshed TVMaze cache with duplicated and re-numbered records for the same episode changes nothing.
  schedules.get(1001)!.episodes.push(timed(5002, 3, 2, '2026-11-10T02:00:00Z'), timed(5098, 3, 2, '2026-11-10T09:00:00Z'));
  r = await run(T('2026-11-10T19:00:00Z'));
  assert.equal(r.delivered, 0); assert.equal(sent.length, 3);
  assert.equal(await prisma.notificationDelivery.count({ where: { tvmazeEpisodeId: 5002 } }), 1);
  console.log('✓ duplicate scheduler runs and duplicate provider records send nothing twice');

  // ===== 3. Concurrent workers: one delivery per device and episode =====
  schedules.get(1001)!.episodes.push(timed(5003, 3, 3, '2026-11-10T20:00:00Z'));
  schedules.get(1001)!.episodes = schedules.get(1001)!.episodes.filter(e => !(e.id === 5003 && e.airdate === '2026-11-17'));
  sendDelayMs = 40;
  const reports = await Promise.all(Array.from({ length: 5 }, () => runEpisodeNotifications({ sender: mockSender, source, now: T('2026-11-10T21:00:00Z') })));
  sendDelayMs = 0;
  assert.equal(sent.filter(s => s.body.startsWith('Season 3, Episode 3')).length, 1);
  assert.equal(reports.reduce((n, x) => n + x.delivered, 0), 1);
  assert.equal(reports.reduce((n, x) => n + x.ledgerCreated, 0), 1, 'the unique key admits one ledger row');
  console.log('✓ five concurrent workers delivered S3E3 exactly once');

  // ===== 4. Enabling a second device later sends it no history =====
  const LAPTOP = 'https://fcm.googleapis.com/fcm/send/alice-laptop';
  await saveSubscription(a.id, { endpoint: LAPTOP, ...keysFor() }, 'Chrome', T('2026-11-10T22:00:00Z'));
  r = await run(T('2026-11-10T22:01:00Z'));
  assert.equal(r.delivered, 0); assert.equal(sentTo(LAPTOP).length, 0);
  // Re-saving the same device keeps its original opt-in time.
  const again = await saveSubscription(a.id, { endpoint: PHONE, ...keysFor() }, 'iPhone', T('2026-11-10T22:05:00Z'));
  assert.equal(again.notifyFrom, phone.notifyFrom);
  schedules.get(1004)!.episodes.push(timed(5302, 2, 2, '2026-11-10T22:30:00Z'));
  r = await run(T('2026-11-10T23:00:00Z'));
  assert.deepEqual([sentTo(PHONE).filter(x => x.startsWith('Season 2, Episode 2')).length, sentTo(LAPTOP).length], [1, 1]);
  console.log('✓ first-time opt-in sends no historical flood; new premieres reach every device once');

  // ===== 5. Delivery failures =====
  const TABLET = 'https://updates.push.services.mozilla.com/wpush/v2/alice-tablet';
  const WATCH = 'https://web.push.apple.com/alice-old-device';
  await saveSubscription(a.id, { endpoint: TABLET, ...keysFor() }, 'Firefox', T('2026-11-10T23:00:00Z'));
  await saveSubscription(a.id, { endpoint: WATCH, ...keysFor() }, 'Old', T('2026-11-10T23:00:00Z'));
  scripted.set(PHONE, [503]);     // explicit "try later": retried with back-off
  scripted.set(LAPTOP, [410]);    // expired subscription: removed
  scripted.set(TABLET, [null]);   // timeout: uncertain, never re-sent
  scripted.set(WATCH, [400]);     // permanent failure
  schedules.get(1001)!.episodes.push(timed(5005, 3, 5, '2026-11-11T02:00:00Z'));
  r = await run(T('2026-11-11T03:00:00Z'));
  assert.deepEqual([r.delivered, r.retry, r.gone, r.uncertain, r.failed], [0, 1, 1, 1, 1]);
  assert.equal(await prisma.pushSubscription.count({ where: { endpoint: LAPTOP } }), 0, 'expired subscription removed');
  r = await run(T('2026-11-11T03:01:00Z'));
  assert.equal(r.delivered, 0, 'retry waits for its back-off');
  r = await run(T('2026-11-11T03:06:00Z'));
  assert.equal(r.delivered, 1);
  assert.equal(sentTo(PHONE).filter(x => x.startsWith('Season 3, Episode 5')).length, 1);
  assert.equal([...sentTo(TABLET), ...sentTo(WATCH), ...sentTo(LAPTOP)].filter(x => x.startsWith('Season 3, Episode 5')).length, 0, 'uncertain, failed and expired rows are never re-sent');
  r = await run(T('2026-11-11T04:00:00Z'));
  assert.equal(r.delivered, 0);
  // Repeated 503s stop after the attempt limit.
  scripted.set(`${PHONE}#ep5006`, [503, 503, 503, 503]);
  schedules.get(1001)!.episodes.push(timed(5006, 3, 6, '2026-11-11T05:00:00Z'));
  for (const at of ['2026-11-11T05:10:00Z', '2026-11-11T05:20:00Z', '2026-11-11T05:40:00Z', '2026-11-11T07:00:00Z']) await run(T(at));
  const capped = await prisma.notificationDelivery.findFirstOrThrow({ where: { tvmazeEpisodeId: 5006, subscription: { endpoint: PHONE } } });
  assert.deepEqual([capped.status, capped.attempts], ['failed', 3]);
  scripted.clear();
  console.log('✓ 503 retried then delivered once; 410 removes the subscription; timeouts and 4xx are never re-sent');

  // ===== 6. A retry is re-checked against tracking: watched in the meantime -> skipped =====
  scripted.set(PHONE, [503]);
  schedules.get(1004)!.episodes.push(timed(5303, 2, 3, '2026-11-11T08:00:00Z'));
  await run(T('2026-11-11T08:30:00Z'));
  await prisma.episodeWatch.create({ data: { showId: completed.id, season: 2, episode: 3 } });
  r = await run(T('2026-11-11T08:40:00Z'));
  assert.equal(r.skipped, 1); assert.equal(sentTo(PHONE).filter(x => x.startsWith('Season 2, Episode 3')).length, 0);
  // And a show dropped before its queued alert goes out is skipped too.
  scripted.set(PHONE, [503]);
  schedules.get(1012)!.episodes.push(timed(5902, 1, 3, '2026-11-11T09:00:00Z'));
  await run(T('2026-11-11T09:30:00Z'));
  await prisma.show.update({ where: { id: dated.id }, data: { status: 'dropped' } });
  r = await run(T('2026-11-11T09:40:00Z'));
  assert.equal(r.skipped, 1);
  await prisma.show.update({ where: { id: dated.id }, data: { status: 'paused' } });
  scripted.clear();
  console.log('✓ queued alerts are re-checked: watched or Dropped in the meantime are not sent');

  // ===== 7. Backend restart recovery =====
  const phoneSub = await prisma.pushSubscription.findFirstOrThrow({ where: { endpoint: PHONE } });
  schedules.get(1001)!.episodes.push(timed(5007, 3, 7, '2026-11-11T10:00:00Z'), timed(5008, 3, 8, '2026-11-11T10:05:00Z'));
  const ledger = (tvmazeEpisodeId: number, number: number, extra: Record<string, unknown>) => prisma.notificationDelivery.create({ data: {
    userId: a.id, subscriptionId: phoneSub.id, tvmazeShowId: 1001, tvmazeEpisodeId, eventType: 'episode_premiere', showId: silo.id, season: 3, episode: number, premieredAt: T('2026-11-11T10:00:00Z'), ...extra } });
  // A process died mid-send (claimed 20 minutes ago): the push may have gone out, so it is never re-sent.
  await ledger(5007, 7, { status: 'sending', claimToken: 'dead-worker', claimedAt: T('2026-11-11T10:10:00Z'), attempts: 1 });
  // A process died after recording the row but before sending: it is sent once on the next pass.
  await ledger(5008, 8, { status: 'pending', nextAttemptAt: T('2026-11-11T10:10:00Z') });
  r = await run(T('2026-11-11T10:30:00Z'));
  assert.equal(r.recoveredInterrupted, 1);
  assert.equal((await prisma.notificationDelivery.findFirstOrThrow({ where: { tvmazeEpisodeId: 5007, subscriptionId: phoneSub.id } })).status, 'uncertain');
  assert.deepEqual(sentTo(PHONE).filter(x => /Episode [78] /.test(x + ' ')), ['Season 3, Episode 8 · Silo']);
  r = await run(T('2026-11-11T10:45:00Z'));
  assert.equal(r.delivered, 0);
  // A fresh claim (another worker still sending) is left alone.
  await ledger(5009, 9, { status: 'sending', claimToken: 'live-worker', claimedAt: T('2026-11-11T10:58:00Z'), attempts: 1 });
  r = await run(T('2026-11-11T11:00:00Z'));
  assert.equal(r.recoveredInterrupted, 0);
  assert.equal((await prisma.notificationDelivery.findFirstOrThrow({ where: { tvmazeEpisodeId: 5009 } })).status, 'sending');
  console.log('✓ restart recovery: interrupted sends are not repeated, unsent rows are sent once');

  // ===== 8. Quiet failures: TVMaze unavailable for one show does not stop the others =====
  schedules.delete(1012);
  schedules.get(1004)!.episodes.push(timed(5304, 2, 4, '2026-11-11T11:30:00Z'));
  r = await run(T('2026-11-11T12:00:00Z'));
  assert.equal(r.unavailableShows, 1); assert.ok(r.delivered >= 1);
  assert.ok(scheduleReads > 0);
  console.log('✓ a provider outage for one show does not block the rest');

  // ===== 9. Real Web Push: VAPID + aes128gcm, decrypted by a fake push service =====
  await reset(); sent.length = 0;
  await new Promise<void>(resolve => fakePush.listen(0, '127.0.0.1', resolve));
  pushService.origin = `https://127.0.0.1:${(fakePush.address() as AddressInfo).port}`;
  useTransportAgent(new https.Agent({ ca: tls.cert }));
  const dana = await user('dana');
  const danaSilo = await show(dana.id, 'Silo', { tmdbId: 125988, status: 'watching', seasonsWatched: 3, episodesWatched: 1 });
  schedules.set(1001, { show: tvShow(1001), episodes: [timed(5001, 3, 1, '2026-11-03T02:00:00Z'), timed(5002, 3, 2, '2026-11-10T02:00:00Z')] });
  const browser = browserKeys();
  pushService.browsers.set('/push/dana', browser);
  await saveSubscription(dana.id, { endpoint: `${pushService.origin}/push/dana`, p256dh: browser.p256dh, auth: browser.auth }, null, T('2026-11-10T00:00:00Z'));
  r = await run(T('2026-11-10T12:00:00Z'), webPushSender(vapidConfig()!));
  assert.equal(r.delivered, 1);
  assert.equal(pushService.received.length, 1);
  assert.deepEqual(pushService.received[0].payload, { title: 'New episode of Silo', body: 'Season 3, Episode 2 has premiered.', url: `/shows?show=${danaSilo.id}`, tag: 'episode-1001-5002', icon: '/icon-192.png?v=2', badge: '/icon-192.png?v=2' });
  assert.equal(pushService.received[0].headers.topic, 'ep5002');
  console.log('✓ real encrypted push decrypted:', JSON.stringify(pushService.received[0].payload));
  r = await run(T('2026-11-10T12:30:00Z'), webPushSender(vapidConfig()!));
  assert.equal(pushService.received.length, 1, 'no second real push');

  // ===== 10. HTTP API: authentication, authorization, validation, rate limits =====
  const express = (await import('express')).default;
  const apiRoutes = (await import('../src/api/v1')).default;
  const { securityModule } = await import('../src/modules/security');
  const app = express(); app.use(express.json()); app.use('/api/v1', apiRoutes);
  const server = await new Promise<http.Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/notifications`;
  const erin = await user('erin'); const frank = await user('frank');
  const token = (id: string) => `Bearer ${securityModule.Commands.GenerateTokenCommand.execute(id)}`;
  const call = async (method: string, path: string, auth: string | null, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, text, json: text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null };
  };
  for (const [method, path] of [['GET', '/config'], ['GET', '/preferences'], ['POST', '/subscriptions'], ['POST', '/subscriptions/status'], ['DELETE', '/subscriptions'], ['POST', '/test']]) {
    assert.equal((await call(method, path, null, {})).status, 401, `${method} ${path} needs a session`);
    assert.equal((await call(method, path, 'Bearer forged.token.value', {})).status, 401);
  }
  const E = token(erin.id); const F = token(frank.id);
  const config = await call('GET', '/config', E);
  assert.deepEqual(config.json, { configured: true, vapidPublicKey: vapid.publicKey });
  assert.ok(!config.text.includes(vapid.privateKey), 'private key never served');
  assert.deepEqual((await call('GET', '/preferences', E)).json, { preferences: { newEpisodes: true, movies: false, dailyDigest: false, showScope: 'all_except_dropped' }, devices: 0 });
  assert.equal((await call('PUT', '/preferences', E, { newEpisodes: true, movies: true })).status, 400);
  assert.equal((await call('PUT', '/preferences', E, { newEpisodes: true, dailyDigest: true })).status, 400);
  assert.equal((await call('PUT', '/preferences', E, { newEpisodes: 'yes' })).status, 400);
  assert.equal((await call('PUT', '/preferences', E, { newEpisodes: false })).json.preferences.newEpisodes, false);
  assert.equal((await call('PUT', '/preferences', E, { newEpisodes: true })).json.preferences.newEpisodes, true);
  const erinBrowser = browserKeys();
  pushService.browsers.set('/push/erin', erinBrowser);
  const erinEndpoint = `${pushService.origin}/push/erin`;
  const subscription = { endpoint: erinEndpoint, keys: { p256dh: erinBrowser.p256dh, auth: erinBrowser.auth } };
  assert.equal((await call('POST', '/subscriptions', E, { subscription: { endpoint: 'https://attacker.example/collect', keys: subscription.keys } })).status, 400, 'arbitrary hosts rejected');
  assert.equal((await call('POST', '/subscriptions', E, { subscription: { endpoint: erinEndpoint, keys: { p256dh: 'x', auth: 'y' } } })).status, 400);
  assert.equal((await call('POST', '/subscriptions', E, {})).status, 400);
  const created = await call('POST', '/subscriptions', E, { subscription });
  assert.equal(created.status, 201);
  assert.equal(created.json.registered, true);
  assert.ok(!created.text.includes(erinEndpoint) && !created.text.includes(erinBrowser.auth), 'endpoint and keys are not echoed back');
  assert.equal((await call('POST', '/subscriptions/status', E, { endpoint: erinEndpoint })).json.registered, true);
  // Diagnostics: this account only, never the endpoint or keys; Alice's library explains every show.
  assert.equal((await call('GET', '/diagnostics', null)).status, 401);
  const erinDiag = await call('GET', '/diagnostics', E);
  assert.equal(erinDiag.status, 200);
  assert.deepEqual([erinDiag.json.devices.length, erinDiag.json.shows.total, erinDiag.json.deliveries.length], [1, 0, 0]);
  assert.ok(!erinDiag.text.includes(erinEndpoint) && !erinDiag.text.includes(erinBrowser.auth) && !erinDiag.text.includes(vapid.privateKey), 'diagnostics never expose endpoints or keys');
  assert.equal(typeof erinDiag.json.scheduler.enabled, 'boolean');
  const { notificationDiagnostics } = await import('../src/services/notifications/notification-diagnostics.service');
  const latestSilo = (await prisma.show.findFirst({ where: { name: 'Silo' }, orderBy: { createdAt: 'desc' } }))!;
  const trackingBeforeDiag = await tracking();
  const aliceDiag = await notificationDiagnostics(latestSilo.userId, { source, now: T('2026-11-10T12:00:00Z') });
  assert.equal(await tracking(), trackingBeforeDiag, 'diagnostics never modify tracking data');
  assert.equal(aliceDiag.shows.total, await prisma.show.count({ where: { userId: latestSilo.userId } }));
  const siloDiag = aliceDiag.shows.items.find(i => i.showId === latestSilo.id)!;
  assert.deepEqual([siloDiag.eligible, siloDiag.reason, siloDiag.tvmazeId], [true, null, 1001]);
  assert.deepEqual([siloDiag.lastPremiere?.season, siloDiag.lastPremiere?.number, siloDiag.lastPremiere?.withinLookback], [3, 2, true]);
  assert.ok(aliceDiag.shows.items.every(i => i.eligible === (i.reason === null)), 'every ineligible show names its reason');
  assert.ok(aliceDiag.deliveries.length > 0 && aliceDiag.deliveries.every(d => typeof d.status === 'string'), "Alice's ledger is listed");
  assert.ok(!JSON.stringify(aliceDiag).includes('/push/'), 'no endpoint in diagnostics');
  console.log('✓ diagnostics: per-account eligibility, devices and ledger without endpoints or keys');
  // Another user can neither see, test, nor remove Erin's subscription.
  assert.equal((await call('POST', '/subscriptions/status', F, { endpoint: erinEndpoint })).json.registered, false);
  assert.equal((await call('POST', '/test', F, { endpoint: erinEndpoint })).status, 404);
  assert.deepEqual((await call('DELETE', '/subscriptions', F, { endpoint: erinEndpoint })).json, { removed: false });
  assert.equal(await prisma.pushSubscription.count({ where: { userId: erin.id } }), 1);
  assert.equal(pushService.received.length, 1, 'nothing was sent for Frank');
  // Test notification: explicit request, this device only, rate-limited.
  const test = await call('POST', '/test', E, { endpoint: erinEndpoint });
  assert.deepEqual([test.status, test.json], [200, { sent: true }]);
  assert.equal(pushService.received.at(-1)!.payload.title, 'Cinetra notifications are on');
  assert.equal((await call('POST', '/test', E, { endpoint: erinEndpoint })).status, 200);
  assert.equal((await call('POST', '/test', E, { endpoint: erinEndpoint })).status, 200);
  assert.equal((await call('POST', '/test', E, { endpoint: erinEndpoint })).status, 429);
  // Unsubscribe.
  assert.deepEqual((await call('DELETE', '/subscriptions', E, { endpoint: erinEndpoint })).json, { removed: true });
  assert.equal((await call('POST', '/subscriptions/status', E, { endpoint: erinEndpoint })).json.registered, false);
  // Shared browser: the same endpoint saved by another account moves to that account with a fresh opt-in.
  await call('POST', '/subscriptions', E, { subscription });
  await call('POST', '/subscriptions', F, { subscription });
  assert.equal((await call('POST', '/subscriptions/status', E, { endpoint: erinEndpoint })).json.registered, false);
  assert.equal((await call('POST', '/subscriptions/status', F, { endpoint: erinEndpoint })).json.registered, true);
  // An expired subscription found by the test button is removed (410 from the push service).
  pushService.status.set('/push/erin', 410);
  const frankTest = await call('POST', '/test', F, { endpoint: erinEndpoint });
  assert.equal(frankTest.status, 410);
  assert.equal(await prisma.pushSubscription.count({ where: { userId: frank.id } }), 0);
  console.log('✓ API: authentication, per-user isolation, validation, unsubscribe and rate limits');

  server.close(); fakePush.close();
  await reset();
  console.log('Push notification integration tests passed');
  await prisma.$disconnect();
}
// Exit explicitly on failure: open servers and database connections must not keep a failed run alive.
main().catch(error => { console.error(error); process.exit(1); });
