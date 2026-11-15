/**
 * Automatic Watching <-> Completed status for saved TV shows: evaluation, compare-and-set writes, the background
 * monitor and a read-only preview. Rules live in show-status.model.ts.
 *
 * Writes are user-scoped, transactional compare-and-set updates of the status fields only (status, the legacy
 * `completed` flag and the completion boundary). They never touch episodes, the saved position, ratings, favorites
 * or anything else, and a show whose status changed in the meantime is left alone.
 */
import { statusScope, scopedTarget, scopeDigest } from './show-status-scope.model';
import { prisma } from '../database/prisma';
import { mapLimit } from './swr-cache';
import { resolveShowIdentity, trackingState, type ShowRow } from './episode-guide.service';
import { getSchedule } from './tvmaze/tvmaze.service';
import { scheduleTimeZone } from './notifications/episode-alerts.model';
import { hasRegularTracking, verifiedPremieresAfterBaseline, verifiedPremiereAfterBaseline, verifiedCoverage, verifiedUnwatchedPremiere, decideStatus, effectiveStatus, isManaged, verifyCompletion, type CompletionCheck, type ReopenCheck, type StatusTransition, type TVMazeEvidence } from './show-status.model';

/** TVMaze evidence for a show, through the same verified identity and cached schedules as Upcoming and notifications. */
export async function tvmazeEvidence(show: { name: string; overview: string | null; tmdbId: number | null; tvmazeId: number | null }, fresh = false): Promise<TVMazeEvidence> {
  if (!show.tmdbId) return { kind: 'unavailable' };
  try {
    const identity = await resolveShowIdentity(show.tmdbId, show, fresh);
    if (identity.status !== 'verified') return identity.reason === 'not_on_tvmaze' ? { kind: 'not_listed' } : { kind: 'unavailable' };
    if (show.tvmazeId && show.tvmazeId !== identity.tvmazeId) return { kind: 'unavailable' };   // contradictory links
    const schedule = await getSchedule(identity.tvmazeId, fresh);
    if (schedule.stale) return { kind: 'unavailable' };
    return { kind: 'verified', tvmazeId: identity.tvmazeId, episodes: schedule.episodes, timeZone: scheduleTimeZone(schedule.show) };
  } catch { return { kind: 'unavailable' }; }
}

export const automaticStatusWritesEnabled = () => process.env.TV_STATUS_RECONCILIATION_ENABLED === 'true' && statusScope() !== null;
const recordKeys = (rows: { season: number; episode: number }[]) => rows.map(e => `${e.season}:${e.episode}`).sort().join(',');
export type LegacyCompletionReview = { legacyCompletion: boolean; confirmationRequired: boolean; completionBaseline: string | null; explanation: string };
export type Evaluation = LegacyCompletionReview & { fresh: boolean; evaluatedAt: number; resolvedTvmazeId: number | null; released: number; watched: number | null; unwatched: string[]; evidenceIssue: string | null; watches: string; unwatches: string; status: string | null; completion: CompletionCheck; reopen: ReopenCheck; transition: StatusTransition | null };
/** Evaluate one show without writing anything. Null when TMDB episode data cannot be loaded. */
export async function evaluateShow(show: ShowRow, options: { now?: Date; fresh?: boolean; confirmedCompletionBaseline?: Date } = {}): Promise<Evaluation | null> {
  const now = options.now ?? new Date();
  const status = effectiveStatus(show);
  if (!isManaged(status) || !show.tmdbId) return null;
  let state: Awaited<ReturnType<typeof trackingState>>;
  try { state = await trackingState(show, options.fresh); } catch { return null; }
  const tvmaze = await tvmazeEvidence(show, options.fresh);
  const catalog = { seasons: state.catalog.seasons, nextEpisode: state.catalog.meta?.nextEpisode ?? null };
  const completion = verifyCompletion({ episodes: state.episodes, catalog, progressReliable: state.progress.progressReliable, tvmaze, today: state.today, now });
  const coverage = verifiedCoverage({ episodes: state.episodes, tvmaze, today: state.today, now });
  const known = new Set(state.episodes.map(e => `${e.season}:${e.number}`));
  const unmapped = [...state.watches, ...state.unwatches].some(e => e.season > 0 && e.episode > 0 && !known.has(`${e.season}:${e.episode}`));
  const evidenceIssue = unmapped ? 'Saved watch or unwatch identity does not fit TMDB episodes' : !state.progress.progressReliable ? 'Episode metadata incomplete or checkpoint needs review' : coverage.reason;
  const legacyCompletion = status === 'completed' && !hasRegularTracking({ ...show, watches: state.watches, unwatches: state.unwatches });
  const baseline = options.confirmedCompletionBaseline;
  const confirmationRequired = legacyCompletion && !baseline;
  const explanation = legacyCompletion
    ? baseline ? `Personal Completed preserved through your confirmed baseline ${baseline.toISOString()}. Actual viewing is unrecorded; only verified new premieres after that instant are candidates. This confirmation is for this preview only.`
      : 'Personal Completed is viewing evidence. No regular episode history or checkpoint was recorded; actual viewing is unknown. Confirm when you had finished all then-premiered regular episodes before any reopening can be proposed. Saved status timestamps are not a confirmed viewing baseline.'
    : 'Effective episode tracking is available. Review this correction individually before activation.';
  const reopen: ReopenCheck = confirmationRequired ? { reopen: false, reason: explanation } : evidenceIssue ? { reopen: false, reason: evidenceIssue }
    : legacyCompletion && baseline ? verifiedPremiereAfterBaseline({ episodes: state.episodes, tvmaze, today: state.today, now, baseline })
    : verifiedUnwatchedPremiere({ episodes: state.episodes, tvmaze, today: state.today, now });
  const relevantGaps = legacyCompletion
    ? baseline ? verifiedPremieresAfterBaseline({ episodes: state.episodes, tvmaze, today: state.today, now, baseline }).episodes : []
    : coverage.released.filter(e => !e.watched);
  return { fresh: options.fresh === true, evaluatedAt: Date.now(), resolvedTvmazeId: tvmaze.kind === 'verified' ? tvmaze.tvmazeId ?? null : null, legacyCompletion, confirmationRequired, completionBaseline: legacyCompletion && baseline ? baseline.toISOString() : null, explanation, released: coverage.released.length, watched: legacyCompletion ? null : coverage.released.filter(e => e.watched).length, unwatched: relevantGaps.map(e => `S${e.season}E${e.number}`), evidenceIssue, watches: recordKeys(state.watches), unwatches: recordKeys(state.unwatches), status, completion, reopen, transition: evidenceIssue || confirmationRequired ? null : decideStatus({ status, completion, reopen }) };
}

/** Compare-and-set: only when the status fields are still exactly what was evaluated. True when a row changed. */
export async function applyTransition(show: ShowRow, transition: StatusTransition, now = new Date(), evidence?: Evaluation) {
  const target = scopedTarget(show);
  if (!automaticStatusWritesEnabled() || !target || !evidence?.fresh || evidence.legacyCompletion || evidence.evidenceIssue || evidence.resolvedTvmazeId !== target.tvmazeId || Date.now() - evidence.evaluatedAt > 120_000 || evidence.transition?.from !== transition.from || evidence.transition?.to !== transition.to) return false;
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Show" WHERE id = ${show.id} AND "userId" = ${show.userId} FOR UPDATE`;
    const [watches, unwatches] = await Promise.all([tx.episodeWatch.findMany({ where: { showId: show.id } }), tx.episodeUnwatch.findMany({ where: { showId: show.id } })]);
    if (recordKeys(watches) !== evidence.watches || recordKeys(unwatches) !== evidence.unwatches) return false;
    const result = await tx.show.updateMany({ where: { id: show.id, userId: show.userId, updatedAt: show.updatedAt, seasonsWatched: show.seasonsWatched, episodesWatched: show.episodesWatched, tmdbId: show.tmdbId, tvmazeId: show.tvmazeId, completedMonitorFrom: show.completedMonitorFrom, status: show.status, completed: show.completed }, data: { status: transition.to, completed: transition.to === 'completed', completedMonitorFrom: transition.to === 'completed' ? now : null } });
    return result.count === 1;
  });
}

/** Reevaluate after tracking or manual status edits; tracking success never depends on provider availability. */
export async function reconcileAfterAction(showId: string, userId: string) {
  if (!automaticStatusWritesEnabled()) return null;
  try {
    const show = await prisma.show.findFirst({ where: { id: showId, userId } });
    if (!show || !scopedTarget(show)) return null;
    const evaluation = await evaluateShow(show, { fresh: true });
    if (!evaluation?.transition) return null;
    return (await applyTransition(show, evaluation.transition, new Date(), evaluation)) ? evaluation.transition : null;
  } catch (error) {
    console.error('Automatic show status check failed:', error instanceof Error ? error.name : 'unknown error');
    return null;
  }
}

export type MonitorReport = { startedAt: string; checked: number; reopened: number; completed: number; unchanged: number; unavailable: number; durationMs: number };
let monitorStatus: { running: boolean; intervalMinutes: number | null; lastRun: MonitorReport | null; lastError: string | null } = { running: false, intervalMinutes: null, lastRun: null, lastError: null };
export const showStatusMonitorStatus = () => ({ ...structuredClone(monitorStatus), automaticWritesEnabled: automaticStatusWritesEnabled(), automaticWritesConfigured: process.env.TV_STATUS_RECONCILIATION_ENABLED ?? null, scopedShows: statusScope()?.targets.length ?? 0, scopeSha256: scopeDigest(), activationBatchEnabled: process.env.TV_STATUS_ACTIVATION_BATCH_ENABLED === 'true' && !automaticStatusWritesEnabled() && statusScope() !== null });

/** All managed shows are reevaluated regardless of watch or completion dates. Writes require activation. */
export async function runShowStatusMonitor(now = new Date()): Promise<MonitorReport> {
  const started = Date.now();
  const report: MonitorReport = { startedAt: now.toISOString(), checked: 0, reopened: 0, completed: 0, unchanged: 0, unavailable: 0, durationMs: 0 };
  if (!automaticStatusWritesEnabled()) return report;
  const shows = await prisma.show.findMany({
    where: { userId: statusScope()!.userId, id: { in: statusScope()!.targets.map(t => t.showId) }, tmdbId: { not: null }, OR: [{ status: 'completed' }, { status: null, completed: true }, { status: 'watching' }] },
  });
  await mapLimit(shows, 3, async show => {
    if (!scopedTarget(show)) return;
    report.checked++;
    const evaluation = await evaluateShow(show, { now, fresh: true });
    if (!evaluation) { report.unavailable++; return; }
    if (!evaluation.transition) { report.unchanged++; return; }
    if (!(await applyTransition(show, evaluation.transition, now, evaluation))) { report.unchanged++; return; }
    if (evaluation.transition.to === 'watching') report.reopened++; else report.completed++;
  });
  report.durationMs = Date.now() - started;
  return report;
}

/** Runs the background pass every `intervalMinutes`, never overlapping. Counts only in logs (no titles or users). */
export function startShowStatusMonitor(intervalMinutes = 15) {
  if (!automaticStatusWritesEnabled()) return { stop: () => {} };
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

export type PreviewRow = LegacyCompletionReview & {
  released: number | null; watched: number | null; unwatched: string[];
  showId: string; name: string; status: string | null;
  /** What happens without your approval: changes the automatic rules make on their own (future premieres and actions). */
  automatic: StatusTransition | null;
  /** What applying the new rules to existing shows would change. Never applied without approval. */
  retroactive: StatusTransition | null;
  completion: string; reopen: string;
  ambiguous: boolean;
};
/** Read-only: how the rules see each of the user's managed shows today. Writes nothing. */
export async function statusPreview(userId: string, now = new Date(), confirmedBaselines: Record<string, string> = {}): Promise<PreviewRow[]> {
  const shows = await prisma.show.findMany({ where: { userId }, orderBy: { name: 'asc' } });
  const rows = await mapLimit(shows, 3, async (show): Promise<PreviewRow> => {
    const status = effectiveStatus(show);
    const base = { legacyCompletion: false, confirmationRequired: false, completionBaseline: null as string | null, explanation: '', released: null, watched: null, unwatched: [] as string[], showId: show.id, name: show.name, status };
    if (!isManaged(status)) return { ...base, automatic: null, retroactive: null, completion: status ? `${status}: never changed automatically` : 'no status: never changed automatically', reopen: '-', ambiguous: false };
    const unavailable = async (reason: string): Promise<PreviewRow> => {
      const [watches, unwatches] = await Promise.all([
        prisma.episodeWatch.findMany({ where: { showId: show.id }, select: { season: true, episode: true } }),
        prisma.episodeUnwatch.findMany({ where: { showId: show.id }, select: { season: true, episode: true } }),
      ]);
      const legacyCompletion = status === 'completed' && !hasRegularTracking({ ...show, watches, unwatches });
      const explanation = legacyCompletion ? `Personal Completed preserved. Actual viewing is unrecorded, not zero. ${reason}. A completion baseline requires your confirmation before new premieres can be assessed.` : reason;
      return { ...base, legacyCompletion, confirmationRequired: legacyCompletion && !confirmedBaselines[show.id], completionBaseline: confirmedBaselines[show.id] ?? null, explanation, automatic: null, retroactive: null, completion: explanation, reopen: '-', ambiguous: true };
    };
    if (!show.tmdbId) return unavailable('not linked to TMDB');
    const evaluation = await evaluateShow(show, { now, confirmedCompletionBaseline: confirmedBaselines[show.id] ? new Date(confirmedBaselines[show.id]) : undefined });
    if (!evaluation) return unavailable('TMDB episode data unavailable');
    const t = evaluation.transition;
    const automatic = automaticStatusWritesEnabled() && !!scopedTarget(show) && !evaluation.legacyCompletion ? t : null;
    return {
      ...base, legacyCompletion: evaluation.legacyCompletion, confirmationRequired: evaluation.confirmationRequired, completionBaseline: evaluation.completionBaseline, explanation: evaluation.explanation + (evaluation.evidenceIssue ? ` Verification issue: ${evaluation.evidenceIssue}` : ''), released: evaluation.evidenceIssue ? null : evaluation.released, watched: evaluation.evidenceIssue ? null : evaluation.watched, unwatched: evaluation.unwatched, automatic, retroactive: t && !automatic ? t : null,
      completion: evaluation.legacyCompletion ? evaluation.explanation + (evaluation.evidenceIssue ? ` Verification issue: ${evaluation.evidenceIssue}` : '') : evaluation.evidenceIssue ?? (evaluation.completion.complete ? 'verified complete' : evaluation.completion.reason),
      reopen: evaluation.reopen.reopen ? `S${evaluation.reopen.season}E${evaluation.reopen.number} premiered` : evaluation.reopen.reason,
      ambiguous: !!evaluation.evidenceIssue || (!evaluation.completion.complete && /incomplete|unavailable|does not fit|TVMaze has no|cannot/i.test(evaluation.completion.reason)),
    };
  });
  return rows;
}
