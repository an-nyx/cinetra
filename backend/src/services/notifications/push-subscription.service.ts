/**
 * Push subscriptions and notification preferences. Every query is scoped to the authenticated user; raw endpoints
 * and keys are never returned to clients.
 */
import { prisma } from '../../database/prisma';
import { endpointHash, type SubscriptionInput } from './push-sender';

export const DEFAULT_PREFERENCES = { newEpisodes: true, movies: false, dailyDigest: false, showScope: 'all_except_dropped' as const };
export type Preferences = { newEpisodes: boolean; movies: boolean; dailyDigest: boolean; showScope: 'all_except_dropped' };

export async function getPreferences(userId: string): Promise<Preferences> {
  const row = await prisma.notificationPreference.findUnique({ where: { userId } });
  return row ? { newEpisodes: row.newEpisodes, movies: row.movies, dailyDigest: row.dailyDigest, showScope: 'all_except_dropped' } : { ...DEFAULT_PREFERENCES };
}

/** Only the new-episode switch can change; movie alerts and the daily digest are not offered and stay off. */
export async function updatePreferences(userId: string, change: { newEpisodes: boolean }): Promise<Preferences> {
  await prisma.notificationPreference.upsert({
    where: { userId },
    create: { userId, ...DEFAULT_PREFERENCES, newEpisodes: change.newEpisodes },
    update: { newEpisodes: change.newEpisodes },
  });
  return getPreferences(userId);
}

export type DeviceStatus = { registered: boolean; subscriptionId: string | null; notifyFrom: string | null; lastSuccessAt: string | null; failureCount: number };
const toStatus = (row: { id: string; notifyFrom: Date; lastSuccessAt: Date | null; failureCount: number } | null): DeviceStatus => row
  ? { registered: true, subscriptionId: row.id, notifyFrom: row.notifyFrom.toISOString(), lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null, failureCount: row.failureCount }
  : { registered: false, subscriptionId: null, notifyFrom: null, lastSuccessAt: null, failureCount: 0 };

/**
 * Save this device's subscription for the user. Re-saving the same endpoint keeps its opt-in time (no new backlog).
 * An endpoint previously saved by another account on a shared browser moves to this user with a fresh opt-in time
 * and none of the other account's delivery history.
 */
export async function saveSubscription(userId: string, input: SubscriptionInput, userAgent: string | null, now = new Date()): Promise<DeviceStatus> {
  const hash = endpointHash(input.endpoint);
  const agent = userAgent ? userAgent.slice(0, 300) : null;
  const row = await prisma.$transaction(async tx => {
    const existing = await tx.pushSubscription.findUnique({ where: { endpointHash: hash } });
    if (existing && existing.userId !== userId) await tx.pushSubscription.delete({ where: { id: existing.id } });
    if (existing && existing.userId === userId) {
      return tx.pushSubscription.update({ where: { id: existing.id }, data: { p256dh: input.p256dh, auth: input.auth, userAgent: agent } });
    }
    return tx.pushSubscription.create({ data: { userId, endpointHash: hash, endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth, userAgent: agent, notifyFrom: now } });
  }).catch(async error => {
    // Two saves of one endpoint at once: the other request created it; return that row if it is this user's.
    if ((error as { code?: string })?.code === 'P2002') return prisma.pushSubscription.findFirst({ where: { endpointHash: hash, userId } });
    throw error;
  });
  return toStatus(row);
}

export async function deviceStatus(userId: string, endpoint: string): Promise<DeviceStatus> {
  return toStatus(await prisma.pushSubscription.findFirst({ where: { endpointHash: endpointHash(endpoint), userId } }));
}

/** Remove this user's subscription for an endpoint. Another user's subscription is never touched. */
export async function removeSubscription(userId: string, endpoint: string): Promise<boolean> {
  const result = await prisma.pushSubscription.deleteMany({ where: { endpointHash: endpointHash(endpoint), userId } });
  return result.count > 0;
}

/** A push the device's service accepted (e.g. the test button): record it so diagnostics show the device works. */
export async function recordDeliverySuccess(subscriptionId: string) {
  await prisma.pushSubscription.updateMany({ where: { id: subscriptionId }, data: { lastSuccessAt: new Date(), failureCount: 0 } });
}

/**
 * A show of this user's for the preview notification: the most recently updated show that alerts would cover (not
 * Dropped), preferring one with a poster. Its "next" episode follows the saved position. Read-only.
 */
export async function previewShow(userId: string) {
  const shows = await prisma.show.findMany({
    where: { userId, OR: [{ status: null }, { status: { not: 'dropped' } }] },
    orderBy: { updatedAt: 'desc' }, take: 25,
    select: { id: true, name: true, posterURL: true, seasonsWatched: true, episodesWatched: true },
  });
  const show = shows.find(s => !!s.posterURL) ?? shows[0];
  if (!show) return null;
  const season = Math.max(1, show.seasonsWatched);
  const number = show.seasonsWatched >= 1 ? Math.max(1, show.episodesWatched + 1) : 1;
  return { showId: show.id, showName: show.name, posterURL: show.posterURL, season, number };
}

export async function countSubscriptions(userId: string) {
  return prisma.pushSubscription.count({ where: { userId } });
}

export async function findOwnSubscription(userId: string, endpoint: string) {
  return prisma.pushSubscription.findFirst({ where: { endpointHash: endpointHash(endpoint), userId } });
}
