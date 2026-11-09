import assert from 'node:assert/strict';
import { calculateLegacyCoverage, calculateTrackingProgress, mergeEpisodeWatchState, type EpisodeCatalog } from '../src/services/legacy-progress.model';
import { resolveTMDBRequestAuth } from '../src/services/tmdb/tmdb-auth';

const today = '2026-11-09';
function catalog(counts: number[], status = 'Ended', inProduction: boolean | null = false, nextEpisodeAnnounced = false): EpisodeCatalog & { broadcastStatus: string; inProduction: boolean | null; nextEpisodeAnnounced: boolean } {
  const seasons = counts.map((episodeCount, index) => ({ number: index + 1, episodeCount }));
  const episodes = seasons.flatMap(season => Array.from({ length: season.episodeCount }, (_, index) => ({ season: season.number, number: index + 1, airDate: '2024-01-01' })));
  return { seasons, episodes, broadcastStatus: status, inProduction, nextEpisodeAnnounced };
}
function effective(c: EpisodeCatalog, season: number, episode: number, explicit: { season: number; episode: number; watchedAt: Date }[] = []) {
  const legacy = calculateLegacyCoverage(season, episode, c, today);
  const merged = mergeEpisodeWatchState(c.episodes.map(item => ({ ...item, name: `S${item.season}E${item.number}`, runtime: null, watchedAt: null as Date | null })), explicit, legacy);
  return { legacy, merged };
}

// Halo: nine regular episodes in S1 and eight in S2; no individual records exist.
{
  const c = catalog([9, 8]) as ReturnType<typeof catalog>;
  const { legacy, merged } = effective(c, 2, 8);
  const progress = calculateTrackingProgress(merged, c, legacy.needsReview, 'ended', false, false, today);
  assert.equal(merged.filter(episode => episode.watched).length, 17);
  assert.equal(merged.filter(episode => episode.watchSource === 'legacy').length, 17);
  assert.equal(progress.progressPercent, 100);
  assert.equal(progress.viewingState, 'fully_watched');
}

// S03E00 means S1 and S2 complete, with S3 not started.
{
  const c = catalog([9, 8, 10]);
  const { legacy, merged } = effective(c, 3, 0);
  assert.equal(merged.filter(episode => episode.watched).length, 17);
  assert.equal(legacy.normalizedSeason, 3);
  assert.equal(legacy.normalizedEpisode, 1);
}

// S04E00 remains a completed S3 position when TMDB has no fourth season.
{
  const c = catalog([4, 5, 6]);
  const { legacy, merged } = effective(c, 4, 0);
  assert.equal(merged.filter(episode => episode.watched).length, 15);
  assert.equal(legacy.normalizedSeason, 3);
  assert.equal(legacy.normalizedEpisode, 6);
  assert.equal(legacy.needsReview, false);
}

// Mid-season: prior season plus the first five regular S2 episodes.
{
  const c = catalog([9, 8]);
  const { legacy, merged } = effective(c, 2, 5);
  assert.equal(merged.filter(episode => episode.watched).length, 14);
  assert.equal(merged.filter(episode => episode.season === 2 && episode.watched).length, 5);
  assert.equal(legacy.normalizedSeason, 2);
  assert.equal(legacy.normalizedEpisode, 6);
}

// Ended final season: full release progress is 100%; no 99% cap.
{
  const c = catalog([4]);
  const { legacy, merged } = effective(c, 1, 4);
  const progress = calculateTrackingProgress(merged, c, legacy.needsReview, 'ended', false, false, today);
  assert.equal(progress.progressPercent, 100);
  assert.equal(progress.finalityConfirmed, true);
  assert.equal(progress.viewingState, 'fully_watched');
}

// Returning series: 100% released progress is caught up, not series-complete.
{
  const c = catalog([4], 'Returning Series', true, true);
  const { legacy, merged } = effective(c, 1, 4);
  const progress = calculateTrackingProgress(merged, c, legacy.needsReview, 'returning', true, true, today);
  assert.equal(progress.progressPercent, 100);
  assert.equal(progress.viewingState, 'caught_up');
  assert.equal(progress.finalityConfirmed, false);
}

// Explicit-only and mixed tracking are unioned, without double-counting overlap.
{
  const c = catalog([4]);
  const explicit = [{ season: 1, episode: 1, watchedAt: new Date('2025-01-01') }, { season: 1, episode: 2, watchedAt: new Date('2025-01-02') }];
  const noLegacy = effective(c, 0, 0, explicit);
  assert.equal(noLegacy.merged.filter(episode => episode.watched).length, 2);
  assert.equal(noLegacy.merged.filter(episode => episode.watchSource === 'explicit').length, 2);
  const explicitProgress = calculateTrackingProgress(noLegacy.merged, c, false, 'unknown', null, false, today);
  assert.equal(explicitProgress.progressPercent, 50);
  assert.equal(explicitProgress.viewingState, 'in_progress');
  const mixed = effective(c, 1, 2, explicit);
  assert.equal(mixed.merged.filter(episode => episode.watched).length, 2);
  assert.equal(mixed.merged.find(episode => episode.season === 1 && episode.number === 1)?.watchSource, 'both');
}

// TMDB supports server-side Bearer access tokens and v3 API keys, retaining the old env var.
{
  assert.deepEqual(resolveTMDBRequestAuth({ TMDB_READ_ACCESS_TOKEN: 'token' }), { headers: { Authorization: 'Bearer token' } });
  assert.deepEqual(resolveTMDBRequestAuth({ TMDB_READ_ACCESS_TOKEN: 'Bearer token' }), { headers: { Authorization: 'Bearer token' } });
  assert.deepEqual(resolveTMDBRequestAuth({ TMDB_API_KEY: 'key' }), { params: { api_key: 'key' } });
  assert.deepEqual(resolveTMDBRequestAuth({ API_AUTHORIZATION: 'Bearer legacy' }), { headers: { Authorization: 'Bearer legacy' } });
  assert.equal(resolveTMDBRequestAuth({}), null);
  // Literal env vars may keep surrounding quotes; credentials placed in the wrong variable still authenticate.
  const v3 = '0123456789abcdef0123456789abcdef';
  const v4 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig_part-1';
  assert.deepEqual(resolveTMDBRequestAuth({ API_AUTHORIZATION: '"Bearer legacy"' }), { headers: { Authorization: 'Bearer legacy' } });
  assert.deepEqual(resolveTMDBRequestAuth({ API_AUTHORIZATION: `Bearer ${v3}` }), { params: { api_key: v3 } });
  assert.deepEqual(resolveTMDBRequestAuth({ TMDB_READ_ACCESS_TOKEN: `'${v3}'` }), { params: { api_key: v3 } });
  assert.deepEqual(resolveTMDBRequestAuth({ TMDB_API_KEY: v4 }), { headers: { Authorization: `Bearer ${v4}` } });
  assert.equal(resolveTMDBRequestAuth({ API_AUTHORIZATION: '""' }), null);
  assert.deepEqual(resolveTMDBRequestAuth({ API_AUTHORIZATION: 'bearer legacy' }), { headers: { Authorization: 'Bearer legacy' } });
  assert.deepEqual(resolveTMDBRequestAuth({ API_AUTHORIZATION: v4 }), { headers: { Authorization: `Bearer ${v4}` } });
}

// Missing catalog data does not invent episodes or a percentage.
{
  const noCatalog = calculateLegacyCoverage(2, 5, null, today);
  assert.equal(noCatalog.known, false);
  assert.equal(noCatalog.covered.size, 0);
  // A saved position exists (S02E05), so this is activity with unknown coverage, never "not started".
  const progress = calculateTrackingProgress([], null, false, 'unknown', null, false, today, true);
  assert.equal(progress.progressPercent, null);
  assert.equal(progress.viewingState, 'unknown');
}

// An inconsistent saved counter is preserved, flagged, and cannot yield a guessed percentage.
{
  const c: EpisodeCatalog = { seasons: [{ number: 1, episodeCount: 3 }], episodes: [{ season: 1, number: 1, airDate: '2024-01-01' }, { season: 1, number: 2, airDate: '2024-01-02' }] };
  const { legacy, merged } = effective(c, 1, 5);
  assert.equal(legacy.needsReview, true);
  assert.equal(merged.filter(episode => episode.watched).length, 2);
  const progress = calculateTrackingProgress(merged, c, legacy.needsReview, 'ended', false, false, today);
  assert.equal(progress.progressPercent, null);
  assert.equal(progress.viewingState, 'needs_review'); // surfaced for review, never guessed or rewritten
  assert.equal(progress.fullyWatched, false);
}

console.log('legacy progress and TMDB authentication tests passed');
