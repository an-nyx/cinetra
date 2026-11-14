/**
 * Automatic Watching <-> Completed status for saved TV shows: evaluation, compare-and-set writes, the background
 * monitor and a read-only preview. Rules live in show-status.model.ts.
 *
 * Writes are user-scoped, transactional compare-and-set updates of the status fields only (status, the legacy
 * `completed` flag and the completion boundary). They never touch episodes, the saved position, ratings, favorites
 * or anything else, and a show whose status changed in the meantime is left alone.
 */
import { prisma } from '../database/prisma';
import { mapLimit } from './swr-cache';
import { resolveShowIdentity, trackingState, type ShowRow } from './episode-guide.service';
import { getSchedule } from './tvmaze/tvmaze.service';
import { scheduleTimeZone } from './notifications/episode-alerts.model';
import { AUTO_STATUS_SINCE, decideStatus, effectiveStatus, isManaged, newPremiereSinceCompleted, verifyCompletion, type CompletionCheck, type ReopenCheck, type StatusTransition, type TVMazeEvidence } from './show-status.model';

/** TVMaze evidence for a show, through the same verified identity and cached schedules as Upcoming and notifications. */
export async function tvmazeEvidence(show: { name: string; overview: string | null; tmdbId: number | null; tvmazeId: number | null }): Promise<TVMazeEvidence> {
  if (!show.tmdbId) return { kind: 'unavailable' };
  try {
    const identity = await resolveShowIdentity(show.tmdbId, show);
    if (identity.status !== 'verified') return identity.reason === 'not_on_tvmaze' ? { kind: 'not_listed' } : { kind: 'unavailable' };
    if (show.tvmazeId && show.tvmazeId !== identity.tvmazeId) return { kind: 'unavailable' };   // contradictory links
    const schedule = await getSchedule(identity.tvmazeId);
    return { kind: 'verified', episodes: schedule.episodes, timeZone: scheduleTimeZone(schedule.show) };
  } catch { return { kind: 'unavailable' }; }
}

export type Evaluation = { status: string | null; completion: CompletionCheck; reopen: ReopenCheck; transition: StatusTransition | null };
/** Evaluate one show without writing anything. Null when TMDB episode data cannot be loaded. */
export async function evaluateShow(show: ShowRow, options: { brokeCompletion?: boolean; now?: Date; featureSince?: Date } = {}): Promise<Evaluation | null> {
  const now = options.now ?? new Date();
  const status = effectiveStatus(show);
  if (!isManaged(status) || !show.tmdbId) return null;
  let state: Awaited<ReturnType<typeof trackingState>>;
  try { state = await trackingState(show); } catch { return null; }
  const tvmaze = await tvmazeEvidence(show);
  const catalog = { seasons: state.catalog.seasons, nextEpisode: state.catalog.meta?.nextEpisode ?? null };
  const completion = verifyCompletion({ episodes: state.episodes, catalog, progressReliable: state.progress.progressReliable, tvmaze, today: state.today, now });
  const reopen = status === 'completed'
    ? newPremiereSinceCompleted({ episodes: state.episodes, completedSince: show.completedMonitorFrom, tvmaze, today: state.today, now, featureSince: options.featureSince })
    : { reopen: false as const, reason: 'not completed' };
  return { status, completion, reopen, transition: decideStatus({ status, completion, reopen, brokeCompletion: options.brokeCompletion }) };
}

/** Compare-and-set: only when the status fields are still exactly what was evaluated. True when a row changed. */
export async function applyTransition(show: Pick<ShowRow, 'id' | 'userId' | 'status' | 'completed'>, transition: StatusTransition, now = new Date()) {
  const data = transition.to === 'completed'
    ? { status: 'completed', completed: true, completedMonitorFrom: now }
    : { status: 'watching', completed: false, completedMonitorFrom: null };
  const result = await prisma.show.updateMany({ where: { id: show.id, userId: show.userId, status: show.status, completed: show.completed }, data });
  return result.count === 1;
}

/** Whether a show is verifiably completed right now (used before an unwatch, to tell if the action broke it). */
export async function isVerifiedComplete(showId: string, userId: string) {
  const show = await prisma.show.findFirst({ where: { id: showId, userId } });
  if (!show || effectiveStatus(show) !== 'completed') return false;
  return (await evaluateShow(show))?.completion.complete === true;
}

/**
 * After a user's watch action: move Watching -> Completed when completion is now verified, or Completed -> Watching
 * when this action unmarked an episode of a verified-complete show. Never throws: tracking already succeeded.
 */
export async function reconcileAfterAction(showId: string, userId: string, options: { wasComplete?: boolean } = {}) {
  try {
    const show = await prisma.show.findFirst({ where: { id: showId, userId } });
    if (!show) return null;
    const evaluation = await evaluateShow(show, { brokeCompletion: options.wasComplete === true });
    if (!evaluation?.transition) return null;
    return (await applyTransition(show, evaluation.transition)) ? evaluation.transition : null;
  } catch (error) {
    console.error('Automatic show status check failed:', error instanceof Error ? error.name : 'unknown error');
    return null;
  }
}

export type MonitorReport = { startedAt: string; checked: number; reopened: number; completed: number; unchanged: number; unavailable: number; durationMs: number };
let monitorStatus: { running: boolean; intervalMinutes: number | null; lastRun: MonitorReport | null; lastError: string | null } = { running: false, intervalMinutes: null, lastRun: null, lastError: null };
export const showStatusMonitorStatus = () => structuredClone(monitorStatus);

/**
 * Background pass, for every user:
 * - Completed shows reopen to Watching when a verified new episode premiered after they were completed (and after
 *   automatic statuses were introduced).
 * - Watching shows complete when verified, but only if the user watched an episode since automatic statuses were
 *   introduced: shows finished long ago and left on Watching are never changed in bulk (see the status preview).
 * Repeated passes write nothing once a show is in its correct state.
 */
export async function runShowStatusMonitor(now = new Date(), options: { featureSince?: Date } = {}): Promise<MonitorReport> {
  const started = Date.now();
  const report: MonitorReport = { startedAt: now.toISOString(), checked: 0, reopened: 0, completed: 0, unchanged: 0, unavailable: 0, durationMs: 0 };
  const shows = await prisma.show.findMany({
    where: { tmdbId: { not: null }, OR: [{ status: 'completed' }, { status: null, completed: true }, { status: 'watching', episodeWatches: { some: { watchedAt: { gte: options.featureSince ?? AUTO_STATUS_SINCE } } } }] },
  });
  await mapLimit(shows, 3, async show => {
    report.checked++;
    const evaluation = await evaluateShow(show, { now, featureSince: options.featureSince });
    if (!evaluation) { report.unavailable++; return; }
    if (!evaluation.transition) { report.unchanged++; return; }
    if (!(await applyTransition(show, evaluation.transition, now))) { report.unchanged++; return; }
    if (evaluation.transition.to === 'watching') report.reopened++; else report.completed++;
  });
  report.durationMs = Date.now() - started;
  return report;
}

/** Runs the background pass every `intervalMinutes`, never overlapping. Counts only in logs (no titles or users). */
export function startShowStatusMonitor(intervalMinutes = 15) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await runShowStatusMonitor();
      monitorStatus.lastRun = r;
      if (r.reopened || r.completed) console.log(`Show status monitor: ${r.checked} shows checked, ${r.reopened} reopened to Watching, ${r.completed} completed`);
    } catch (error) {
      monitorStatus.lastError = error instanceof Error ? error.name : 'unknown error';
      console.error('Show status monitor failed:', monitorStatus.lastError);
    } finally { busy = false; }
  };
  // Offset from the notifier's first pass (60 s) so start-up work does not pile up.
  const first = setTimeout(() => { void tick(); }, 3 * 60_000);
  const timer = setInterval(() => { void tick(); }, intervalMinutes * 60_000);
  first.unref(); timer.unref();
  monitorStatus = { ...monitorStatus, running: true, intervalMinutes };
  return { stop: () => { clearTimeout(first); clearInterval(timer); monitorStatus.running = false; } };
}

export type PreviewRow = {
  showId: string; name: string; status: string | null;
  /** What happens without your approval: changes the automatic rules make on their own (future premieres and actions). */
  automatic: StatusTransition | null;
  /** What applying the new rules to existing shows would change. Never applied without approval. */
  retroactive: StatusTransition | null;
  completion: string; reopen: string;
  ambiguous: boolean;
};
/** Read-only: how the rules see each of the user's managed shows today. Writes nothing. */
export async function statusPreview(userId: string, now = new Date()): Promise<PreviewRow[]> {
  const shows = await prisma.show.findMany({ where: { userId }, orderBy: { name: 'asc' } });
  const rows = await mapLimit(shows, 3, async (show): Promise<PreviewRow> => {
    const status = effectiveStatus(show);
    const base = { showId: show.id, name: show.name, status };
    if (!isManaged(status)) return { ...base, automatic: null, retroactive: null, completion: status ? `${status}: never changed automatically` : 'no status: never changed automatically', reopen: '-', ambiguous: false };
    if (!show.tmdbId) return { ...base, automatic: null, retroactive: null, completion: 'not linked to TMDB', reopen: '-', ambiguous: true };
    const evaluation = await evaluateShow(show, { now });
    if (!evaluation) return { ...base, automatic: null, retroactive: null, completion: 'TMDB episode data unavailable', reopen: '-', ambiguous: true };
    const recentWatch = status === 'watching' && !!(await prisma.episodeWatch.findFirst({ where: { showId: show.id, watchedAt: { gte: AUTO_STATUS_SINCE } }, select: { id: true } }));
    const t = evaluation.transition;
    const automatic = t && (t.to === 'watching' || recentWatch) ? t : null;
    return {
      ...base, automatic, retroactive: t && !automatic ? t : null,
      completion: evaluation.completion.complete ? 'verified complete' : evaluation.completion.reason,
      reopen: evaluation.reopen.reopen ? `S${evaluation.reopen.season}E${evaluation.reopen.number} premiered` : evaluation.reopen.reason,
      ambiguous: !evaluation.completion.complete && /incomplete|unavailable|does not fit|TVMaze has no|cannot/.test(evaluation.completion.reason),
    };
  });
  return rows;
}
