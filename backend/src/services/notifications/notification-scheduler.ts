/**
 * Background scheduler for new-episode notifications, inside the existing backend process (no extra worker).
 *
 * Off unless NOTIFICATIONS_SCHEDULER=enabled and VAPID keys are configured. Each tick is one notifier pass; ticks
 * never overlap in this process, and the database ledger keeps concurrent processes from double-sending.
 *
 * The scheduler keeps a small status record (timestamps and counts only, never endpoints, titles or user data) so
 * /health and the per-account diagnostics can show whether notifications are actually running.
 */
import { runEpisodeNotifications, type RunReport } from './episode-notifier.service';
import { defaultSender } from './push-sender';

export function notificationSchedulerSettings(env: NodeJS.ProcessEnv = process.env) {
  const minutes = Number(env.NOTIFICATIONS_INTERVAL_MINUTES || 15);
  return { enabled: env.NOTIFICATIONS_SCHEDULER === 'enabled', intervalMs: Math.max(5, Number.isFinite(minutes) ? minutes : 15) * 60_000 };
}

export type SchedulerStatus = {
  /** NOTIFICATIONS_SCHEDULER asks for the scheduler. */
  enabled: boolean;
  /** VAPID keys are present and well-formed. */
  configured: boolean;
  /** Why the keys were rejected, when they were (never the keys themselves). */
  configError: string | null;
  /** The timer is armed in this process. */
  running: boolean;
  intervalMinutes: number;
  startedAt: string | null;
  nextTickAt: string | null;
  ticks: number;
  lastTickStartedAt: string | null;
  lastTickFinishedAt: string | null;
  lastTickDurationMs: number | null;
  /** Counts from the last completed pass (see RunReport); no identifiers. */
  lastRun: RunReport | null;
  lastError: { at: string; message: string } | null;
};

const status: SchedulerStatus = {
  enabled: false, configured: false, configError: null, running: false, intervalMinutes: 15, startedAt: null, nextTickAt: null,
  ticks: 0, lastTickStartedAt: null, lastTickFinishedAt: null, lastTickDurationMs: null, lastRun: null, lastError: null,
};
/** A copy of the scheduler's status for health and diagnostics. */
export const notificationSchedulerStatus = (): SchedulerStatus => structuredClone(status);

/** Error text safe for logs and status: type and message only, no endpoints or keys (the notifier never includes them). */
const describe = (error: unknown) => error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : 'unknown error';

let running = false;
export async function tick() {
  if (running) return;
  running = true;
  const startedAt = new Date();
  status.ticks++; status.lastTickStartedAt = startedAt.toISOString();
  try {
    const sender = defaultSender();
    if (!sender) { status.configured = false; return; }
    const r = await runEpisodeNotifications({ sender });
    status.lastRun = r;
    // Counts only: no endpoints, titles or user identifiers in logs.
    console.log(`Episode notifications: ${r.devices} devices, ${r.showsChecked} shows checked (${r.verifiedShows} verified, ${r.unverifiedShows} unverified, ${r.unavailableShows} unavailable), ${r.premiered} premieres in window (${r.alreadyWatched} watched, ${r.beforeOptIn} before opt-in), ${r.ledgerCreated} queued, ${r.delivered} sent, ${r.retry} retry, ${r.failed} failed, ${r.uncertain} uncertain, ${r.gone} expired subscriptions, ${r.skipped} skipped, ${r.expired} too old`);
  } catch (error) {
    status.lastError = { at: new Date().toISOString(), message: describe(error) };
    console.error('Episode notification run failed:', describe(error));
  } finally {
    running = false;
    const finishedAt = new Date();
    status.lastTickFinishedAt = finishedAt.toISOString();
    status.lastTickDurationMs = finishedAt.getTime() - startedAt.getTime();
    if (status.running) status.nextTickAt = new Date(finishedAt.getTime() + status.intervalMinutes * 60_000).toISOString();
  }
}

export function startNotificationScheduler(env: NodeJS.ProcessEnv = process.env) {
  const settings = notificationSchedulerSettings(env);
  status.enabled = settings.enabled;
  status.intervalMinutes = settings.intervalMs / 60_000;
  try { status.configured = !!defaultSender(); status.configError = null; }
  catch (error) { status.configured = false; status.configError = error instanceof Error ? error.message : 'Invalid VAPID configuration'; }
  if (!settings.enabled) { console.log('Episode notification scheduler disabled (set NOTIFICATIONS_SCHEDULER=enabled to run it)'); return null; }
  if (status.configError) console.error(status.configError);
  if (!status.configured) { console.log('Episode notification scheduler not started: VAPID keys are not configured'); return null; }
  // First pass shortly after start-up (also recovers rows a previous process left mid-send), then on the interval.
  const first = setTimeout(() => { void tick(); }, 60_000);
  const timer = setInterval(() => { void tick(); }, settings.intervalMs);
  first.unref(); timer.unref();
  status.running = true; status.startedAt = new Date().toISOString(); status.nextTickAt = new Date(Date.now() + 60_000).toISOString();
  console.log(`Episode notification scheduler running every ${status.intervalMinutes} minutes`);
  return { stop: () => { clearTimeout(first); clearInterval(timer); status.running = false; status.nextTickAt = null; } };
}
