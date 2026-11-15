/** One approved batch, separate from prospective automation. Never writes tracking or provider identities. */
import { prisma } from '../database/prisma';
import { evaluateShow, automaticStatusWritesEnabled } from './show-status.service';
import { historyDigest, scopedTarget, scopeDigest, stableJSON, statusScope } from './show-status-scope.model';
import type { ShowRow } from './episode-guide.service';

export class StatusActivationConflict extends Error {}
function approval(userId: string, digest: string) {
  const scope = statusScope();
  if (process.env.TV_STATUS_ACTIVATION_BATCH_ENABLED !== 'true' || automaticStatusWritesEnabled() || !scope || scope.userId !== userId || scopeDigest() !== digest || scope.targets.length !== 6 || scope.targets.some(t => !t.initial)) throw new StatusActivationConflict('Approved six-row activation is not available');
  return scope;
}
async function records(showId: string) {
  const [watches, unwatches] = await Promise.all([prisma.episodeWatch.findMany({ where: { showId } }), prisma.episodeUnwatch.findMany({ where: { showId } })]);
  return { watches, unwatches };
}
export async function prepareStatusActivation(userId: string, digest: string) {
  const scope = approval(userId, digest);
  const rows = await prisma.show.findMany({ where: { userId, id: { in: scope.targets.map(t => t.showId) } }, orderBy: { id: 'asc' } });
  if (rows.length !== 6 || rows.some(s => !scopedTarget(s))) throw new StatusActivationConflict('Approved show identities changed');
  const states = await Promise.all(rows.map(async show => ({ show, ...(await records(show.id)) })));
  for (const { show, watches, unwatches } of states) {
    const initial = scopedTarget(show)!.initial!;
    if (show.seasonsWatched !== initial.seasonsWatched || show.episodesWatched !== initial.episodesWatched || historyDigest(watches, unwatches) !== initial.historySha256) throw new StatusActivationConflict('Reviewed viewing history changed; refresh the approval plan');
  }
  if (rows.every(s => s.status === 'watching' && !s.completed)) return { alreadyApplied: true as const, rows, evaluations: [] };
  if (rows.some(s => !(s.status === 'watching' && !s.completed) && !matchesInitial(s))) throw new StatusActivationConflict('Reviewed show revision or status changed; no rows updated');
  const evaluations = [];
  for (const show of rows) {
    const evaluation = await evaluateShow(show, { fresh: true });
    const target = scopedTarget(show)!;
    const initial = target.initial!;
    const correctDirection = show.status === 'watching' && !show.completed
      ? evaluation?.reopen.reopen === true
      : evaluation?.transition?.from === 'completed' && evaluation.transition.to === 'watching';
    if (!evaluation?.fresh || !correctDirection || evaluation.evidenceIssue || evaluation.legacyCompletion || evaluation.resolvedTvmazeId !== target.tvmazeId || evaluation.released !== initial.released || evaluation.watched !== initial.watched || stableJSON(evaluation.unwatched) !== stableJSON(initial.unwatched)) throw new StatusActivationConflict(`Fresh episode verification changed for ${show.name}; no rows updated`);
    evaluations.push(evaluation);
  }
  return { alreadyApplied: false as const, rows, evaluations };
}
function matchesInitial(show: ShowRow) {
  const initial = scopedTarget(show)?.initial;
  return !!initial && show.status === initial.status && show.completed === initial.completed && show.updatedAt.toISOString() === initial.updatedAt && (show.completedMonitorFrom?.toISOString() ?? null) === initial.completedMonitorFrom;
}
export async function applyStatusActivation(userId: string, digest: string) {
  const prepared = await prepareStatusActivation(userId, digest);
  if (prepared.alreadyApplied) return { updated: 0, alreadyApplied: true, shows: prepared.rows.map(s => ({ id: s.id, name: s.name, status: s.status })) };
  const now = new Date();
  return prisma.$transaction(async tx => {
    approval(userId, digest);
    for (const show of prepared.rows) await tx.$queryRaw`SELECT id FROM "Show" WHERE id = ${show.id} AND "userId" = ${userId} FOR UPDATE`;
    for (let i = 0; i < prepared.rows.length; i++) {
      const evaluated = prepared.rows[i];
      const show = await tx.show.findFirst({ where: { id: evaluated.id, userId } });
      const target = show && scopedTarget(show);
      const [watches, unwatches] = await Promise.all([tx.episodeWatch.findMany({ where: { showId: evaluated.id } }), tx.episodeUnwatch.findMany({ where: { showId: evaluated.id } })]);
      if (!show || !target || show.status !== evaluated.status || show.completed !== evaluated.completed || show.updatedAt.getTime() !== evaluated.updatedAt.getTime() || (show.completedMonitorFrom?.getTime() ?? null) !== (evaluated.completedMonitorFrom?.getTime() ?? null) || show.seasonsWatched !== target.initial!.seasonsWatched || show.episodesWatched !== target.initial!.episodesWatched || historyDigest(watches, unwatches) !== target.initial!.historySha256 || Date.now() - prepared.evaluations[i].evaluatedAt > 120_000) throw new StatusActivationConflict('Concurrent change detected; entire batch rolled back');
    }
    for (const show of prepared.rows) {
      if (show.status === 'watching' && !show.completed) continue;
      const result = await tx.show.updateMany({ where: { id: show.id, userId, updatedAt: show.updatedAt, status: show.status, completed: show.completed }, data: { status: 'watching', completed: false, completedMonitorFrom: null } });
      if (result.count !== 1) throw new StatusActivationConflict('Concurrent status edit; entire batch rolled back');
    }
    return { updated: prepared.rows.filter(s => s.status === 'completed').length, alreadyWatching: prepared.rows.filter(s => s.status === 'watching').length, alreadyApplied: false, verifiedAt: now.toISOString(), shows: prepared.rows.map(s => ({ id: s.id, name: s.name, from: s.status, status: 'watching', unchanged: s.status === 'watching' })) };
  }, { timeout: 15000 });
}
