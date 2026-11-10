/**
 * Background scheduler for new-episode notifications, inside the existing backend process (no extra worker).
 *
 * Off unless NOTIFICATIONS_SCHEDULER=enabled and VAPID keys are configured. Each tick is one notifier pass; ticks
 * never overlap in this process, and the database ledger keeps concurrent processes from double-sending.
 */
import { runEpisodeNotifications } from './episode-notifier.service';
import { defaultSender } from './push-sender';

export function notificationSchedulerSettings(env: NodeJS.ProcessEnv = process.env) {
  const minutes = Number(env.NOTIFICATIONS_INTERVAL_MINUTES || 15);
  return { enabled: env.NOTIFICATIONS_SCHEDULER === 'enabled', intervalMs: Math.max(5, Number.isFinite(minutes) ? minutes : 15) * 60_000 };
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const sender = defaultSender();
    if (!sender) return;
    const r = await runEpisodeNotifications({ sender });
    // Counts only: no endpoints, titles or user identifiers in logs.
    console.log(`Episode notifications: ${r.ledgerCreated} queued, ${r.delivered} sent, ${r.retry} retry, ${r.failed} failed, ${r.uncertain} uncertain, ${r.gone} expired subscriptions, ${r.skipped} skipped`);
  } catch (error) {
    console.error('Episode notification run failed:', error instanceof Error ? error.name : 'unknown error');
  } finally { running = false; }
}

export function startNotificationScheduler(env: NodeJS.ProcessEnv = process.env) {
  const settings = notificationSchedulerSettings(env);
  if (!settings.enabled) { console.log('Episode notification scheduler disabled (set NOTIFICATIONS_SCHEDULER=enabled to run it)'); return null; }
  let configured = false;
  try { configured = !!defaultSender(); } catch (error) { console.error(error instanceof Error ? error.message : 'Invalid VAPID configuration'); }
  if (!configured) { console.log('Episode notification scheduler not started: VAPID keys are not configured'); return null; }
  // First pass shortly after start-up (also recovers rows a previous process left mid-send), then on the interval.
  const first = setTimeout(() => { void tick(); }, 60_000);
  const timer = setInterval(() => { void tick(); }, settings.intervalMs);
  first.unref(); timer.unref();
  console.log(`Episode notification scheduler running every ${settings.intervalMs / 60_000} minutes`);
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}
