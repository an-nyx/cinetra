import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../src/database/prisma';

type AppliedRow = { showId: string; previousTmdbId: number | null; appliedTmdbId: number };
const association = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../docs/tmdb-association-transaction.json'), 'utf8')) as { mode: string; updates: number; rollbackBeforeImage: AppliedRow[] };

async function main() {
  if (association.mode !== 'apply' || association.updates !== 90) throw new Error('Approved association transaction record is not the expected 90-row apply.');
  const before = association.rollbackBeforeImage;
  const ids = before.map(row => row.showId);
  if (new Set(ids).size !== 90) throw new Error('Association transaction contains duplicate show IDs.');
  const rows = await prisma.show.findMany({ where: { id: { in: ids } }, select: { id: true, tmdbId: true } });
  const byId = new Map(rows.map(row => [row.id, row.tmdbId]));
  const mismatches = before.filter(row => byId.get(row.showId) !== row.appliedTmdbId);
  const linkedTmdbIds = before.map(row => row.appliedTmdbId);
  const duplicateTmdbIds = linkedTmdbIds.filter((id, i) => linkedTmdbIds.indexOf(id) !== i);
  const boba = await prisma.show.findUnique({ where: { id: 'c5de0bd2-f672-4cb4-b2c6-f4769b264a6e' }, select: { name: true, seasonsWatched: true, episodesWatched: true, tmdbId: true, status: true, completed: true, favorite: true } });
  const episodeWatchCount = await prisma.episodeWatch.count();
  const showCount = await prisma.show.count();
  const result = { shows: showCount, approvedAssociations: before.length, linkedAssociationsVerified: before.length - mismatches.length, mismatches: mismatches.length, duplicateProposedTmdbIds: new Set(duplicateTmdbIds).size, boba: boba && { correctRecord: boba.name === 'The Book of Boba Fett', seasonsWatched: boba.seasonsWatched, episodesWatched: boba.episodesWatched, tmdbId: boba.tmdbId, status: boba.status, completed: boba.completed, favorite: boba.favorite }, episodeWatchRows: episodeWatchCount };
  console.log(JSON.stringify(result));
  if (mismatches.length || duplicateTmdbIds.length || !boba || boba.name !== 'The Book of Boba Fett' || boba.seasonsWatched !== 1 || boba.episodesWatched !== 7) process.exitCode = 1;
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Verification failed'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
