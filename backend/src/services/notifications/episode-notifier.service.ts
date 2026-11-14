/**
 * New-episode notifier: one pass finds newly premiered regular episodes of eligible saved shows and delivers each to
 * each subscribed device at most once.
 *
 * Delivery guarantee (at most once per device and TVMaze episode):
 * 1. Every (user, device, TVMaze show, TVMaze episode, event) gets one ledger row; the database unique key makes
 *    repeated runs, restarts, concurrent workers, cache refreshes and duplicate provider records collapse onto it.
 * 2. A row is sent only after an atomic claim (pending|retry -> sending) that exactly one worker can win.
 * 3. Results are written only by the claim holder. Explicit push-service rejections (429/503) are retried a few times;
 *    anything ambiguous (timeout, connection reset, other 5xx, a worker dying mid-send) becomes "uncertain" and is
 *    never re-sent. A missed alert is preferred over a duplicate.
 *
 * Saved tracking (statuses, checkpoints, watch records, ratings, favorites) is only read, never written.
 */
import crypto from 'crypto';
import { prisma } from '../../database/prisma';
import type { Prisma } from '../../../generated/prisma/client';
import { checkForUpdates, getSchedule } from '../tvmaze/tvmaze.service';
import type { IdentityResult, TVMazeEpisode, TVMazeShow } from '../tvmaze/tvmaze-schedule.model';
import { resolveShowIdentity, tmdbEpisodeInfo } from '../episode-guide.service';
import { mapLimit } from '../swr-cache';
import { EPISODE_PREMIERE_EVENT, NOTIFY_LOOKBACK_MS, episodePayload, isEpisodeWatched, isShowEligible, premiereKind, scheduleTimeZone, selectPremieredEpisodes, verifiedFinaleKind, type EpisodeKind, type PremiereExclusions } from './episode-alerts.model';
import { classifySend, type PushSender } from './push-sender';

/** Where identities and episode lists come from. The default reuses Cinetra's cached TVMaze matching and schedules. */
export type ScheduleSource = {
  resolve(show: { name: string; overview: string | null; tmdbId: number }): Promise<IdentityResult>;
  schedule(tvmazeId: number): Promise<{ show: TVMazeShow; episodes: TVMazeEpisode[] }>;
  /** Re-read shows that TVMaze reports as changed (one request, rate-limited); failures are ignored. */
  refreshChanged(): Promise<void>;
  /** TMDB's episode label and air date (wording only: finale or not). Optional; absent means "regular". */
  episodeInfo?(show: { name: string; tmdbId: number }, season: number, number: number): Promise<{ episodeType: string | null; airDate: string | null } | null>;
};
export const tvmazeScheduleSource: ScheduleSource = {
  resolve: show => resolveShowIdentity(show.tmdbId, show),
  schedule: id => getSchedule(id),
  refreshChanged: () => checkForUpdates(30 * 60_000),
  episodeInfo: (show, season, number) => tmdbEpisodeInfo(show, season, number),
};

/** How long wording may wait for TMDB's episode label before the alert goes out as a regular episode. */
const EPISODE_INFO_TIMEOUT_MS = 4000;
/**
 * Wording only, never eligibility: premieres from TVMaze numbering; finales only when TMDB agrees (see
 * verifiedFinaleKind). Any lookup failure or timeout falls back to the plain kind, so delivery is never held up.
 */
async function episodeKind(source: ScheduleSource, show: { name: string; tmdbId: number | null }, delivery: { season: number; episode: number; premieredAt: Date }): Promise<EpisodeKind> {
  const premiere = premiereKind(delivery.season, delivery.episode);
  if (premiere !== 'regular' || !source.episodeInfo || show.tmdbId === null) return premiere;
  let timer: NodeJS.Timeout | undefined;
  try {
    const info = await Promise.race([
      source.episodeInfo({ name: show.name, tmdbId: show.tmdbId }, delivery.season, delivery.episode),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), EPISODE_INFO_TIMEOUT_MS); }),
    ]);
    return verifiedFinaleKind(info, delivery.premieredAt) ?? 'regular';
  } catch { return 'regular'; }
  finally { clearTimeout(timer); }
}

/** A "sending" claim older than this belongs to a worker that died mid-send. */
export const CLAIM_TIMEOUT_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 5 * 60_000;
/** Alerts still queued this long after the premiere are dropped instead of arriving days late. */
const EXPIRE_AFTER_MS = NOTIFY_LOOKBACK_MS + 24 * 60 * 60_000;
/** Push services keep an undelivered message (device offline) for up to this long. */
const PUSH_TTL_SECONDS = 24 * 60 * 60;

export type RunOptions = { sender: PushSender; source?: ScheduleSource; now?: Date; maxSends?: number; concurrency?: number };
export type RunReport = {
  startedAt: string; users: number; devices: number; showsChecked: number; verifiedShows: number; unverifiedShows: number; unavailableShows: number;
  premiered: number; alreadyWatched: number; beforeOptIn: number; ledgerCreated: number;
  delivered: number; gone: number; retry: number; failed: number; uncertain: number; skipped: number; lostClaims: number;
  recoveredInterrupted: number; expired: number; exclusions: PremiereExclusions;
};

const emptyExclusions = (): PremiereExclusions => ({ specials: 0, undated: 0, duplicates: 0, repeats: 0, notYet: 0, tooOld: 0 });

/** Rows left "sending" by a crashed worker are marked uncertain (never re-sent); stale queued rows expire. */
async function recover(now: Date) {
  const interrupted = await prisma.notificationDelivery.updateMany({
    where: { status: 'sending', claimedAt: { lt: new Date(now.getTime() - CLAIM_TIMEOUT_MS) } },
    data: { status: 'uncertain', claimToken: null, lastError: 'Interrupted while sending; not re-sent to avoid a duplicate' },
  });
  const expired = await prisma.notificationDelivery.updateMany({
    where: { status: { in: ['pending', 'retry'] }, premieredAt: { lt: new Date(now.getTime() - EXPIRE_AFTER_MS) } },
    data: { status: 'expired', lastError: 'Premiere is too old to announce' },
  });
  return { interrupted: interrupted.count, expired: expired.count };
}

/** Find newly premiered episodes and record one ledger row per device that should hear about each. Read-only for tracking. */
async function discover(now: Date, source: ScheduleSource, report: RunReport) {
  const subscriptions = await prisma.pushSubscription.findMany({ select: { id: true, userId: true, notifyFrom: true } });
  const userIds = [...new Set(subscriptions.map(s => s.userId))];
  if (!userIds.length) return;
  const preferences = await prisma.notificationPreference.findMany({ where: { userId: { in: userIds } } });
  const optedOut = new Set(preferences.filter(p => !p.newEpisodes).map(p => p.userId));
  const users = userIds.filter(id => !optedOut.has(id));
  report.users = users.length;
  report.devices = subscriptions.filter(s => !optedOut.has(s.userId)).length;
  if (!users.length) return;

  const [shows, watches, unwatches] = await Promise.all([
    prisma.show.findMany({ where: { userId: { in: users } }, select: { id: true, userId: true, name: true, overview: true, status: true, tmdbId: true, tvmazeId: true, seasonsWatched: true, episodesWatched: true } }),
    prisma.episodeWatch.findMany({ where: { show: { userId: { in: users } } }, select: { showId: true, season: true, episode: true } }),
    prisma.episodeUnwatch.findMany({ where: { show: { userId: { in: users } } }, select: { showId: true, season: true, episode: true } }),
  ]);
  const watchesByShow = new Map<string, { season: number; episode: number }[]>();
  for (const w of watches) watchesByShow.set(w.showId, [...(watchesByShow.get(w.showId) || []), w]);
  const unwatchesByShow = new Map<string, { season: number; episode: number }[]>();
  for (const u of unwatches) unwatchesByShow.set(u.showId, [...(unwatchesByShow.get(u.showId) || []), u]);

  // Only shows with a stored TMDB identity (canonical) that are not Dropped. Completed shows stay eligible.
  const eligible = shows.filter((s): s is typeof s & { tmdbId: number } => isShowEligible(s) && s.tmdbId !== null);
  report.showsChecked = eligible.length;
  await source.refreshChanged().catch(() => undefined);

  const identities = new Map<string, number | null>();
  await mapLimit(eligible, 4, async show => {
    try {
      const identity = await source.resolve(show);
      const verified = identity.status === 'verified' && (!show.tvmazeId || show.tvmazeId === identity.tvmazeId);
      identities.set(show.id, verified ? identity.tvmazeId : null);
    } catch { report.unavailableShows++; }
  });
  // Two library entries resolving to one TVMaze series cannot both be right: neither is trusted (as in Upcoming).
  const perUser = new Map<string, number>();
  for (const show of eligible) { const id = identities.get(show.id); if (id) perUser.set(`${show.userId}:${id}`, (perUser.get(`${show.userId}:${id}`) || 0) + 1); }
  const trusted = eligible.filter(show => { const id = identities.get(show.id); return !!id && perUser.get(`${show.userId}:${id}`) === 1; });
  report.verifiedShows = trusted.length;
  report.unverifiedShows = eligible.length - trusted.length - report.unavailableShows;

  const tvmazeIds = [...new Set(trusted.map(show => identities.get(show.id)!))];
  const schedules = new Map<number, ReturnType<typeof selectPremieredEpisodes>['episodes']>();
  const window = { since: new Date(now.getTime() - NOTIFY_LOOKBACK_MS), now };
  await mapLimit(tvmazeIds, 4, async id => {
    try {
      const schedule = await source.schedule(id);
      const { episodes, excluded } = selectPremieredEpisodes(schedule.episodes, window, scheduleTimeZone(schedule.show));
      for (const key of Object.keys(excluded) as (keyof PremiereExclusions)[]) report.exclusions[key] += excluded[key];
      schedules.set(id, episodes);
    } catch { report.unavailableShows++; }
  });

  const subsByUser = new Map<string, typeof subscriptions>();
  for (const s of subscriptions) subsByUser.set(s.userId, [...(subsByUser.get(s.userId) || []), s]);
  const rows: Prisma.NotificationDeliveryCreateManyInput[] = [];
  for (const show of trusted) {
    const tvmazeShowId = identities.get(show.id)!;
    for (const episode of schedules.get(tvmazeShowId) || []) {
      report.premiered++;
      if (isEpisodeWatched(show, watchesByShow.get(show.id) || [], episode.season, episode.number, unwatchesByShow.get(show.id) || [])) { report.alreadyWatched++; continue; }
      for (const sub of subsByUser.get(show.userId) || []) {
        // Never announce what premiered before this device opted in: enabling alerts sends no backlog.
        if (episode.premieredAt.getTime() < sub.notifyFrom.getTime()) { report.beforeOptIn++; continue; }
        rows.push({
          userId: show.userId, subscriptionId: sub.id, tvmazeShowId, tvmazeEpisodeId: episode.tvmazeEpisodeId, eventType: EPISODE_PREMIERE_EVENT,
          showId: show.id, season: episode.season, episode: episode.number, premieredAt: episode.premieredAt, status: 'pending', nextAttemptAt: now,
        });
      }
    }
  }
  if (rows.length) {
    // Existing rows (any state) win: a second run, a second worker or a refreshed cache cannot create another.
    const created = await prisma.notificationDelivery.createMany({ data: rows, skipDuplicates: true });
    report.ledgerCreated = created.count;
  }
}

type Due = Awaited<ReturnType<typeof dueDeliveries>>[number];
const dueDeliveries = (now: Date, take: number) => prisma.notificationDelivery.findMany({
  where: { status: { in: ['pending', 'retry'] }, nextAttemptAt: { lte: now } },
  orderBy: { createdAt: 'asc' }, take,
  include: { subscription: { select: { id: true, endpoint: true, p256dh: true, auth: true, userId: true } } },
});

/** Re-read tracking right before sending: the user may have watched, dropped or removed the show, or opted out. */
async function stillWanted(delivery: Due) {
  if (delivery.subscription.userId !== delivery.userId) return null;
  const [show, preference, watches, unwatches] = await Promise.all([
    prisma.show.findFirst({ where: { id: delivery.showId, userId: delivery.userId }, select: { name: true, status: true, seasonsWatched: true, episodesWatched: true, tmdbId: true, posterURL: true } }),
    prisma.notificationPreference.findUnique({ where: { userId: delivery.userId }, select: { newEpisodes: true } }),
    prisma.episodeWatch.findMany({ where: { showId: delivery.showId, season: delivery.season, episode: delivery.episode }, select: { season: true, episode: true } }),
    prisma.episodeUnwatch.findMany({ where: { showId: delivery.showId, season: delivery.season, episode: delivery.episode }, select: { season: true, episode: true } }),
  ]);
  if (!show || !isShowEligible(show) || preference?.newEpisodes === false) return null;
  if (isEpisodeWatched(show, watches, delivery.season, delivery.episode, unwatches)) return null;
  return show;
}

async function deliver(delivery: Due, now: Date, sender: PushSender, source: ScheduleSource, report: RunReport) {
  const show = await stillWanted(delivery);
  if (!show) {
    const skipped = await prisma.notificationDelivery.updateMany({ where: { id: delivery.id, status: delivery.status, attempts: delivery.attempts }, data: { status: 'skipped', lastError: 'No longer relevant (watched, dropped, removed or switched off)' } });
    if (skipped.count) report.skipped++;
    return;
  }
  // Atomic claim: exactly one worker moves this row from the state it read to "sending".
  const claimToken = crypto.randomUUID();
  const claim = await prisma.notificationDelivery.updateMany({
    where: { id: delivery.id, status: delivery.status, attempts: delivery.attempts },
    data: { status: 'sending', claimToken, claimedAt: now, attempts: { increment: 1 } },
  });
  if (claim.count !== 1) { report.lostClaims++; return; }

  const kind = await episodeKind(source, show, delivery);
  const payload = episodePayload({ showName: show.name, showId: delivery.showId, tvmazeShowId: delivery.tvmazeShowId, tvmazeEpisodeId: delivery.tvmazeEpisodeId, season: delivery.season, number: delivery.episode, kind, posterURL: show.posterURL });
  let result: Awaited<ReturnType<PushSender['send']>>;
  let deliveredNote: string | null = null;
  try {
    // Topic lets the push service replace (not stack) a message for the same episode still waiting for an offline
    // device. Urgency is "high", like the test notification: Apple's push service has been seen rejecting
    // "Urgency: normal" with 400 BadUrgency (WebKit bug 247128) although the value is standard.
    result = await sender.send(delivery.subscription, payload, { ttlSeconds: PUSH_TTL_SECONDS, topic: `ep${delivery.tvmazeEpisodeId}`.slice(0, 32), urgency: 'high' });
    if (result.statusCode === 400) {
      // The service named the request itself bad, so nothing was accepted or delivered. Some services reject
      // optional headers they should support (Apple: BadUrgency/BadWebPushTopic); one spec-minimal retry without
      // them tells a transient header rejection apart from a genuinely bad request. Never repeated on its own.
      const firstError = result.error ?? 'HTTP 400';
      const fallback = await sender.send(delivery.subscription, payload, { ttlSeconds: PUSH_TTL_SECONDS, urgency: 'high' });
      if (classifySend(fallback) === 'delivered') deliveredNote = `First attempt rejected (${firstError}); delivered without the Topic header`;
      else fallback.error = `${firstError}; retry without optional headers: ${fallback.error ?? `HTTP ${fallback.statusCode}`}`;
      result = fallback;
    }
  } catch { result = { statusCode: null, error: 'Push sender failed' }; }
  const outcome = classifySend(result);
  const mine = { id: delivery.id, claimToken, status: 'sending' };
  const attempts = delivery.attempts + 1;
  if (outcome === 'delivered') {
    await prisma.notificationDelivery.updateMany({ where: mine, data: { status: 'sent', sentAt: new Date(), claimToken: null, lastError: deliveredNote } });
    await prisma.pushSubscription.updateMany({ where: { id: delivery.subscriptionId }, data: { lastSuccessAt: new Date(), failureCount: 0 } });
    report.delivered++;
  } else if (outcome === 'gone') {
    // Expired or revoked: remove the subscription (its ledger rows go with it).
    await prisma.pushSubscription.deleteMany({ where: { id: delivery.subscriptionId } });
    report.gone++;
  } else if (outcome === 'retry' && attempts < MAX_ATTEMPTS) {
    await prisma.notificationDelivery.updateMany({ where: mine, data: { status: 'retry', claimToken: null, nextAttemptAt: new Date(now.getTime() + RETRY_BASE_MS * 2 ** (attempts - 1)), lastError: result.error ?? `HTTP ${result.statusCode}` } });
    await prisma.pushSubscription.updateMany({ where: { id: delivery.subscriptionId }, data: { lastFailureAt: new Date(), failureCount: { increment: 1 } } });
    report.retry++;
  } else if (outcome === 'uncertain') {
    await prisma.notificationDelivery.updateMany({ where: mine, data: { status: 'uncertain', claimToken: null, lastError: result.error ?? 'Outcome unknown' } });
    report.uncertain++;
  } else {
    await prisma.notificationDelivery.updateMany({ where: mine, data: { status: 'failed', claimToken: null, lastError: result.error ?? `HTTP ${result.statusCode}` } });
    await prisma.pushSubscription.updateMany({ where: { id: delivery.subscriptionId }, data: { lastFailureAt: new Date(), failureCount: { increment: 1 } } });
    report.failed++;
  }
}

/** One full pass. Safe to run repeatedly and concurrently; see the delivery guarantee above. */
export async function runEpisodeNotifications(options: RunOptions): Promise<RunReport> {
  const now = options.now ?? new Date();
  const source = options.source ?? tvmazeScheduleSource;
  const report: RunReport = {
    startedAt: now.toISOString(), users: 0, devices: 0, showsChecked: 0, verifiedShows: 0, unverifiedShows: 0, unavailableShows: 0,
    premiered: 0, alreadyWatched: 0, beforeOptIn: 0, ledgerCreated: 0, delivered: 0, gone: 0, retry: 0, failed: 0, uncertain: 0, skipped: 0, lostClaims: 0,
    recoveredInterrupted: 0, expired: 0, exclusions: emptyExclusions(),
  };
  const recovered = await recover(now);
  report.recoveredInterrupted = recovered.interrupted;
  report.expired = recovered.expired;
  await discover(now, source, report);
  const due = await dueDeliveries(now, options.maxSends ?? 500);
  await mapLimit(due, options.concurrency ?? 4, delivery => deliver(delivery, now, options.sender, source, report));
  return report;
}
