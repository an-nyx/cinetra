/**
 * Per-account notification diagnostics: why each saved show would or would not produce a new-episode alert, what
 * this account's devices look like, and what happened to every alert the ledger holds for it.
 *
 * Read-only. Uses the same cached TVMaze identities and episode lists as Upcoming and the notifier, so the answers
 * reflect exactly what the scheduler sees. Raw push endpoints and keys are never returned.
 */
import { prisma } from '../../database/prisma';
import { mapLimit } from '../swr-cache';
import { tvmazeScheduleSource, type ScheduleSource } from './episode-notifier.service';
import type { IdentityFailure } from '../tvmaze/tvmaze-schedule.model';
import { IDENTITY_FAILURE_TEXT } from '../tvmaze/tvmaze-schedule.model';
import { NOTIFY_LOOKBACK_MS, isEpisodeWatched, isShowEligible, premiereInstant, scheduleTimeZone, selectPremieredEpisodes, type PremiereTiming } from './episode-alerts.model';
import { notificationSchedulerStatus } from './notification-scheduler';
import { getPreferences } from './push-subscription.service';

export type ShowDiagnostic = {
  showId: string; name: string; status: string | null;
  /** Would the notifier consider this show at all, and if not, why. */
  eligible: boolean;
  reason: 'dropped' | 'no_tmdb_link' | 'unverified' | 'unavailable' | 'shared_tvmaze_identity' | null;
  detail: string | null;
  tvmazeId: number | null; tvmazeStatus: string | null; timeZone: string | null; stale: boolean;
  /** Most recent regular episode that has (conservatively) premiered. */
  lastPremiere: { season: number; number: number; airdate: string | null; premieredAt: string; timing: PremiereTiming; watched: boolean; withinLookback: boolean } | null;
  /** Next regular episode TVMaze lists, by its listed date (null when none is announced). */
  nextEpisode: { season: number; number: number; airdate: string | null; airtime: string | null; airstamp: string | null; premieresAt: string | null } | null;
};

const EPISODE_WINDOW_DAYS = 30;

export async function notificationDiagnostics(userId: string, options: { source?: ScheduleSource; now?: Date } = {}) {
  const now = options.now ?? new Date();
  const source = options.source ?? tvmazeScheduleSource;
  const [preferences, subscriptions, shows, watches, deliveries] = await Promise.all([
    getPreferences(userId),
    prisma.pushSubscription.findMany({ where: { userId }, orderBy: { createdAt: 'asc' }, select: { id: true, userAgent: true, notifyFrom: true, createdAt: true, updatedAt: true, lastSuccessAt: true, lastFailureAt: true, failureCount: true } }),
    prisma.show.findMany({ where: { userId }, orderBy: { name: 'asc' }, select: { id: true, name: true, overview: true, status: true, tmdbId: true, tvmazeId: true, seasonsWatched: true, episodesWatched: true } }),
    prisma.episodeWatch.findMany({ where: { show: { userId } }, select: { showId: true, season: true, episode: true } }),
    prisma.notificationDelivery.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 100 }),
  ]);
  const watchesByShow = new Map<string, { season: number; episode: number }[]>();
  for (const w of watches) watchesByShow.set(w.showId, [...(watchesByShow.get(w.showId) || []), w]);
  const nameById = new Map(shows.map(s => [s.id, s.name]));

  // Identity, exactly as the notifier decides it (same cache, same rules).
  const identities = new Map<string, { tvmazeId: number | null; reason: IdentityFailure | 'unavailable' | null }>();
  const candidates = shows.filter(s => isShowEligible(s) && s.tmdbId !== null);
  await mapLimit(candidates, 4, async show => {
    try {
      const identity = await source.resolve({ name: show.name, overview: show.overview, tmdbId: show.tmdbId! });
      if (identity.status !== 'verified') { identities.set(show.id, { tvmazeId: null, reason: identity.reason }); return; }
      if (show.tvmazeId && show.tvmazeId !== identity.tvmazeId) { identities.set(show.id, { tvmazeId: null, reason: 'stored_tvmaze_conflict' }); return; }
      identities.set(show.id, { tvmazeId: identity.tvmazeId, reason: null });
    } catch { identities.set(show.id, { tvmazeId: null, reason: 'unavailable' }); }
  });
  const perTvmaze = new Map<number, number>();
  for (const { tvmazeId } of identities.values()) if (tvmazeId) perTvmaze.set(tvmazeId, (perTvmaze.get(tvmazeId) || 0) + 1);

  const items: ShowDiagnostic[] = await mapLimit(shows, 4, async (show): Promise<ShowDiagnostic> => {
    const base = { showId: show.id, name: show.name, status: show.status, tvmazeId: null, tvmazeStatus: null, timeZone: null, stale: false, lastPremiere: null, nextEpisode: null };
    if (!isShowEligible(show)) return { ...base, eligible: false, reason: 'dropped', detail: 'Marked Dropped: alerts are off for this show.' };
    if (show.tmdbId === null) return { ...base, eligible: false, reason: 'no_tmdb_link', detail: 'Not linked to TMDB. Link it (Edit › TMDB match) so its TVMaze schedule can be verified.' };
    const identity = identities.get(show.id);
    if (!identity || identity.reason === 'unavailable') return { ...base, eligible: false, reason: 'unavailable', detail: 'TMDB or TVMaze could not be reached to verify this show; it is retried on the next pass.' };
    if (!identity.tvmazeId) return { ...base, eligible: false, reason: 'unverified', detail: IDENTITY_FAILURE_TEXT[identity.reason as IdentityFailure] };
    if ((perTvmaze.get(identity.tvmazeId) || 0) > 1) return { ...base, eligible: false, reason: 'shared_tvmaze_identity', tvmazeId: identity.tvmazeId, detail: IDENTITY_FAILURE_TEXT.shared_tvmaze_identity };
    let schedule: Awaited<ReturnType<ScheduleSource['schedule']>> & { stale?: boolean };
    try { schedule = await source.schedule(identity.tvmazeId); }
    catch { return { ...base, eligible: false, reason: 'unavailable', tvmazeId: identity.tvmazeId, detail: 'TVMaze could not be reached for this show’s episode list; it is retried on the next pass.' }; }
    const timeZone = scheduleTimeZone(schedule.show);
    const { episodes } = selectPremieredEpisodes(schedule.episodes, { since: new Date(now.getTime() - EPISODE_WINDOW_DAYS * 86_400_000), now }, timeZone);
    const last = episodes.length ? episodes.reduce((a, b) => (b.premieredAt > a.premieredAt ? b : a)) : null;
    const raw = last ? schedule.episodes.find(e => e.id === last.tvmazeEpisodeId) : null;
    const upcoming = schedule.episodes
      .filter(e => (!e.type || e.type === 'regular') && (e.season ?? 0) >= 1 && (e.number ?? 0) >= 1 && e.airdate)
      .map(e => ({ e, at: premiereInstant(e, timeZone)?.at ?? null }))
      .filter(x => x.at !== null && x.at.getTime() > now.getTime())
      .sort((a, b) => a.at!.getTime() - b.at!.getTime())[0];
    return {
      ...base, eligible: true, reason: null, detail: null, tvmazeId: identity.tvmazeId, tvmazeStatus: schedule.show.status ?? null, timeZone, stale: schedule.stale ?? false,
      lastPremiere: last ? {
        season: last.season, number: last.number, airdate: raw?.airdate ?? null, premieredAt: last.premieredAt.toISOString(), timing: last.timing,
        watched: isEpisodeWatched(show, watchesByShow.get(show.id) || [], last.season, last.number),
        withinLookback: now.getTime() - last.premieredAt.getTime() <= NOTIFY_LOOKBACK_MS,
      } : null,
      nextEpisode: upcoming ? { season: upcoming.e.season!, number: upcoming.e.number!, airdate: upcoming.e.airdate ?? null, airtime: upcoming.e.airtime || null, airstamp: upcoming.e.airstamp ?? null, premieresAt: upcoming.at!.toISOString() } : null,
    };
  });

  const count = (reason: ShowDiagnostic['reason']) => items.filter(i => i.reason === reason).length;
  return {
    generatedAt: now.toISOString(),
    scheduler: notificationSchedulerStatus(),
    preferences,
    devices: subscriptions.map(s => ({
      id: s.id, createdAt: s.createdAt.toISOString(), notifyFrom: s.notifyFrom.toISOString(), updatedAt: s.updatedAt.toISOString(),
      lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null, lastFailureAt: s.lastFailureAt?.toISOString() ?? null, failureCount: s.failureCount,
      userAgent: s.userAgent ? s.userAgent.slice(0, 120) : null,
    })),
    shows: {
      total: items.length, eligible: items.filter(i => i.eligible).length, dropped: count('dropped'), noTmdbLink: count('no_tmdb_link'),
      unverified: count('unverified'), unavailable: count('unavailable'), sharedIdentity: count('shared_tvmaze_identity'),
      recentPremieres: items.filter(i => i.lastPremiere?.withinLookback).length,
      items,
    },
    deliveries: deliveries.map(d => ({
      id: d.id, deviceId: d.subscriptionId, showId: d.showId, showName: nameById.get(d.showId) ?? null, season: d.season, episode: d.episode,
      premieredAt: d.premieredAt.toISOString(), status: d.status, attempts: d.attempts, lastError: d.lastError, sentAt: d.sentAt?.toISOString() ?? null,
      createdAt: d.createdAt.toISOString(), updatedAt: d.updatedAt.toISOString(),
    })),
  };
}
export type NotificationDiagnostics = Awaited<ReturnType<typeof notificationDiagnostics>>;
