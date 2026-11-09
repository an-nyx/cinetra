import assert from 'node:assert/strict';
import { buildTrackingSummary, catalogFromTMDB, checkpointAfterUnwatch, checkpointAfterWatch, type Catalog, type TrackedShow } from '../src/services/tracking-summary.model';
import { auditShow, inContinueWatching, type GuidePage, type Summary } from '../scripts/audit/tracking-audit.model';
import { mergeShowEpisodes } from '../src/services/tracking-summary.model';

// Generic: a season-1-complete checkpoint ("S2E0") on a returning show, as TMDB publishes season 2 over time.
const today = '2026-11-09';
type Ep = [season: number, number: number, airDate: string | null];
function catalog(episodes: Ep[], seasons: Record<number, number>): Catalog {
  return {
    source: 'TMDB', broadcastStatus: 'Returning Series', inProduction: true, nextEpisodeAnnounced: true,
    seasons: Object.entries(seasons).map(([number, episodeCount]) => ({ number: Number(number), episodeCount })),
    episodes: episodes.map(([season, number, airDate]) => ({ season, number, airDate, name: '', airTimestamp: null, runtime: null })),
  };
}
const season1: Ep[] = Array.from({ length: 8 }, (_, i) => [1, i + 1, '2022-07-01']);
const special: Ep = [0, 1, '2022-06-15'];
const s2 = (dates: (string | null)[]): Ep[] => dates.map((d, i) => [2, i + 1, d]);
const show = (s: number, e: number, status = 'watching'): TrackedShow => ({ id: 'show', name: 'Sample', posterURL: null, status, completed: status === 'completed', seasonsWatched: s, episodesWatched: e });
type Watch = { season: number; episode: number; watchedAt: Date };
const watch = (season: number, episode: number): Watch => ({ season, episode, watchedAt: new Date(`2026-11-0${episode}T20:00:00Z`) });

function check(label: string, sh: TrackedShow, c: Catalog, watches: Watch[], expect: { watched: number; released: number; percent: number; state: string; next: string | null; newEpisodes?: number; inContinue: boolean }) {
  const summary = buildTrackingSummary(sh, c, null, watches, today);
  const next = summary.nextEpisode ? `S${summary.nextEpisode.season}E${summary.nextEpisode.number}` : null;
  assert.deepEqual({ watched: summary.watchedCount, released: summary.releasedCount, percent: summary.progressPercent, state: summary.viewingState, next, inContinue: inContinueWatching(JSON.parse(JSON.stringify(summary))) },
    { watched: expect.watched, released: expect.released, percent: expect.percent, state: expect.state, next: expect.next, inContinue: expect.inContinue }, label);
  if (expect.newEpisodes !== undefined) assert.equal(summary.newEpisodes, expect.newEpisodes, `${label}: new episodes`);
  // Saved position and personal status are reported exactly as stored.
  assert.deepEqual([summary.legacyPosition?.fullSeasons, summary.legacyPosition?.episodesInNextSeason, summary.status], [sh.seasonsWatched, sh.episodesWatched, sh.status], `${label}: stored values`);
  // The independent audit agrees on every count, checkmark and state (consistency across pages and the audit).
  const { episodes } = mergeShowEpisodes(sh, c, watches, today);
  const guides: GuidePage[] = c.seasons.map(season => ({ seasons: c.seasons, season: season.number, watched: watches.map(w => ({ season: w.season, episode: w.episode, watchedAt: w.watchedAt.toISOString() })), episodes: episodes.filter(e => e.season === season.number).sort((a, b) => a.number - b.number).map(e => ({ number: e.number, airDate: e.airDate, watched: e.watched, watchSource: e.watchSource })) }));
  const served = JSON.parse(JSON.stringify(summary)) as Summary;
  const facts = { ...c, status: c.broadcastStatus, inProduction: c.inProduction, nextEpisodeAnnounced: c.nextEpisodeAnnounced, nextEpisode: null };
  const upcoming = c.episodes.filter(e => e.season > 0 && e.airDate && e.airDate > today).slice(0, 1).map(e => ({ showId: sh.id, season: e.season, number: e.number, name: '', airDate: e.airDate!, scheduleSource: 'TMDB' as const }));
  const defects = auditShow({ show: { ...sh, favorite: false, tmdbId: 1 }, summary: served, detail: served, guides, facts, upcoming, today }).issues.filter(i => i.severity !== 'info');
  assert.deepEqual(defects.map(i => i.code), [], `${label}: audit`);
  return summary;
}

{
  // Before season 2 exists on TMDB: 8/8, Caught Up; the S2E0 checkpoint is valid.
  check('no season 2 yet', show(2, 0), catalog([...season1, special], { 1: 8 }), [], { watched: 8, released: 8, percent: 100, state: 'caught_up', next: null, newEpisodes: 0, inContinue: false });
  // Season 2 announced (undated, or dated in the future): progress unchanged.
  check('season 2 announced, undated', show(2, 0), catalog([...season1, special, ...s2([null, null, null, null, null, null, null, null])], { 1: 8, 2: 8 }), [], { watched: 8, released: 8, percent: 100, state: 'caught_up', next: null, inContinue: false });
  check('season 2 dated in the future', show(2, 0), catalog([...season1, ...s2(['2026-12-01', '2026-12-08'])], { 1: 8, 2: 2 }), [], { watched: 8, released: 8, percent: 100, state: 'caught_up', next: null, inContinue: false });
  // Announced season listed with a declared count but no episodes yet.
  check('season 2 declared, no episodes', show(2, 0), catalog([...season1], { 1: 8, 2: 10 }), [], { watched: 8, released: 8, percent: 100, state: 'caught_up', next: null, inContinue: false });
}

const released2 = catalog([...season1, special, ...s2(['2026-11-01', '2026-11-08', '2026-11-15', null, null, null, null, null])], { 1: 8, 2: 8 });
{
  // Two season-2 episodes released: 8/10 = 80%, In Progress, next S2E1, shown in Continue watching with 2 new.
  check('two released', show(2, 0), released2, [], { watched: 8, released: 10, percent: 80, state: 'in_progress', next: 'S2E1', newEpisodes: 2, inContinue: true });
  // Personal Completed status does not hide the new episodes and is not changed.
  check('two released, personally completed', show(2, 0, 'completed'), released2, [], { watched: 8, released: 10, percent: 80, state: 'in_progress', next: 'S2E1', inContinue: true });
  // Metadata alone never moves the checkpoint.
  assert.equal(checkpointAfterWatch(show(2, 0), released2, [], today), null);
}

{
  // The user marks S2E1: 9/10 = 90%, and the checkpoint advances to S2E1 (the service applies this on the user action).
  const watches = [watch(2, 1)];
  const moved = checkpointAfterWatch(show(2, 0), released2, watches, today);
  assert.deepEqual(moved, { seasonsWatched: 2, episodesWatched: 1 });
  check('after marking S2E1', show(2, 1), released2, watches, { watched: 9, released: 10, percent: 90, state: 'in_progress', next: 'S2E2', inContinue: true });
  // Un-marking that same episode steps the checkpoint back to S2E0 and restores 80%.
  assert.deepEqual(checkpointAfterUnwatch(show(2, 1), released2, 2, 1, today), { seasonsWatched: 2, episodesWatched: 0 });
  // Any other covered episode cannot be un-marked this way.
  assert.equal(checkpointAfterUnwatch(show(2, 1), released2, 1, 4, today), null);
  // Out of order: S2E2 first does not move the checkpoint; S2E1 afterwards advances it through S2E2.
  assert.equal(checkpointAfterWatch(show(2, 0), released2, [watch(2, 2)], today), null);
  assert.deepEqual(checkpointAfterWatch(show(2, 0), released2, [watch(2, 2), watch(2, 1)], today), { seasonsWatched: 2, episodesWatched: 2 });
  check('after marking both', show(2, 2), released2, [watch(2, 1), watch(2, 2)], { watched: 10, released: 10, percent: 100, state: 'caught_up', next: null, inContinue: false });
  // Never advances into unreleased episodes, never for shows without a saved position or positions needing review.
  assert.equal(checkpointAfterWatch(show(2, 2), released2, [watch(2, 1), watch(2, 2)], today), null); // S2E3 has not aired: no change
  assert.equal(checkpointAfterWatch(show(0, 0), released2, [watch(1, 1)], today), null);
  assert.equal(checkpointAfterWatch(show(1, 12), released2, [watch(2, 1)], today), null);
  // First episode of the series un-marked from S1E1: back to no saved position (not an invented S1E0).
  assert.deepEqual(checkpointAfterUnwatch(show(1, 1), released2, 1, 1, today), { seasonsWatched: 0, episodesWatched: 0 });
  // An E0 checkpoint un-marked at its last covered episode steps back within the previous season.
  assert.deepEqual(checkpointAfterUnwatch(show(2, 0), released2, 1, 8, today), { seasonsWatched: 1, episodesWatched: 7 });
}

{
  // A failed TMDB page for a season that has not aired is tolerated; for an aired season it is an error.
  const details = { status: 'Returning Series', in_production: true, next_episode_to_air: null, seasons: [{ season_number: 1, episode_count: 2, air_date: '2022-07-01' }, { season_number: 2, episode_count: 8, air_date: '2027-03-01' }, { season_number: 3, episode_count: 0, air_date: null }] };
  const page1 = { episodes: [{ episode_number: 1, air_date: '2022-07-01' }, { episode_number: 2, air_date: '2022-07-08' }, { episode_number: 0, air_date: '2022-06-01' }] };
  const built = catalogFromTMDB(details, [{ season: 1, data: page1 }, { season: 2, data: null }, { season: 3, data: null }], today);
  assert.equal(built.episodes.length, 2); // the special is excluded
  check('unreleased season page missing', show(2, 0), built, [], { watched: 2, released: 2, percent: 100, state: 'caught_up', next: null, inContinue: false });
  assert.throws(() => catalogFromTMDB(details, [{ season: 1, data: null }, { season: 2, data: null }], today), /season 1 could not be loaded/);
}

console.log('dynamic season progress tests passed');
