import assert from 'node:assert/strict';
import { analyzeRematchProgress, summarizeSeries } from '../src/services/rematch.model';
import { buildTrackingSummary, type Catalog, type TrackedShow } from '../src/services/tracking-summary.model';

// Same title, different series: an anime with long seasons (1999) and a live-action adaptation with short ones (2023).
const today = '2026-11-09';
function catalog(seasons: number[], status = 'Returning Series'): Catalog {
  return {
    source: 'TMDB', broadcastStatus: status, inProduction: true, nextEpisodeAnnounced: false,
    seasons: seasons.map((episodeCount, i) => ({ number: i + 1, episodeCount })),
    episodes: seasons.flatMap((count, i) => Array.from({ length: count }, (_, j) => ({ season: i + 1, number: j + 1, airDate: '2020-01-01', name: '', airTimestamp: null, runtime: null }))),
  };
}
const anime1999 = catalog([61, 77, 14, 39, 13, 52, 33, 35, 73, 45, 26, 14, 101, 58, 62, 50, 118, 33, 98, 14, 197, 70]);
const liveAction2023 = catalog([8, 8]);
const show = (s: number, e: number): TrackedShow => ({ id: 'op', name: 'One Piece', posterURL: null, status: 'watching', completed: false, seasonsWatched: s, episodesWatched: e });
const w = (season: number, episode: number) => ({ season, episode, watchedAt: new Date('2025-02-01T20:00:00Z') });

// Saved position that fits the replacement: interpreted explicitly, no acknowledgement needed.
{
  const p = analyzeRematchProgress(show(1, 8), [], liveAction2023, today);
  assert.equal(p.positionFits, true);
  assert.equal(p.coveredReleasedEpisodes, 8);
  assert.match(p.positionDetail!, /S01E08 will count as 8 released episodes/);
  assert.equal(p.needsAcknowledgement, false);
  assert.equal(p.hasProgress, true);
}

// Saved position recorded against the anime does not fit the live-action series: kept, flagged, acknowledgement required.
{
  const p = analyzeRematchProgress(show(1, 20), [], liveAction2023, today);
  assert.equal(p.positionFits, false);
  assert.equal(p.needsAcknowledgement, true);
  assert.match(p.warnings[0], /S01E20 is beyond the 8 episodes TMDB lists for season 1/);
  assert.match(p.warnings[0], /kept as it is and marked for review/);
  const later = analyzeRematchProgress(show(14, 3), [], liveAction2023, today); // names a season the replacement lacks
  assert.equal(later.positionFits, false);
}

// Individual records: those with a matching episode are listed, the rest are kept but do not count.
{
  const p = analyzeRematchProgress(show(0, 0), [w(1, 3), w(1, 45), w(14, 1), w(1, 3)], liveAction2023, today);
  assert.deepEqual(p.mappedRecords, ['S01E03']);
  assert.deepEqual(p.unmappedRecords, ['S01E45', 'S14E01']);
  assert.equal(p.explicitRecords, 3); // duplicates collapsed
  assert.equal(p.needsAcknowledgement, true);
  assert.match(p.warnings.join(' '), /2 individually logged episodes \(S01E45, S14E01\) do not exist/);
}

// No progress at all: nothing to interpret.
{
  const p = analyzeRematchProgress(show(0, 0), [], liveAction2023, today);
  assert.deepEqual([p.hasProgress, p.needsAcknowledgement, p.warnings.length, p.positionDetail], [false, false, 0, null]);
}

// The other direction (live action -> anime) is generic too: the interpretation is stated, not silent.
{
  const p = analyzeRematchProgress(show(2, 8), [w(2, 8)], anime1999, today);
  assert.equal(p.positionFits, true);
  assert.equal(p.coveredReleasedEpisodes, 61 + 8);
  assert.deepEqual(p.mappedRecords, ['S02E08']);
}

// After re-linking, the stored progress is unchanged and an incompatible position shows as needs review.
{
  const watches = [w(1, 3), w(1, 45)];
  const summary = buildTrackingSummary(show(1, 20), liveAction2023, null, watches, today);
  assert.equal(summary.viewingState, 'needs_review');
  assert.equal(summary.legacyPosition?.fullSeasons, 1);
  assert.equal(summary.legacyPosition?.episodesInNextSeason, 20); // never rewritten
  assert.equal(summary.explicitWatchedCount, 2); // both records kept
  assert.equal(summary.progressPercent, null);
  assert.equal(summary.progressUnavailable?.code, 'saved_position_conflict');
  // A compatible position simply counts against the new series.
  const ok = buildTrackingSummary(show(1, 8), liveAction2023, null, [], today);
  assert.equal(ok.watchedCount, 8); assert.equal(ok.releasedCount, 16); assert.equal(ok.progressPercent, 50);
}

// Comparison cards: the replacement shows only its own TMDB poster and overview, never the saved show's.
{
  const saved = { name: 'One Piece', posterURL: 'https://image.tmdb.org/t/p/w500/saved.jpg', overview: 'Saved overview' };
  const withMeta: Catalog = { ...liveAction2023, meta: { name: 'ONE PIECE', originalName: 'ONE PIECE', overview: 'Live action.', firstAirDate: '2023-08-31', nextEpisode: null, lastAiredSeason: 2, seasonAirDates: {}, posterPath: '/live.jpg' } };
  const bare: Catalog = { ...liveAction2023, meta: { name: 'Carême', originalName: 'Carême', overview: null, firstAirDate: '2025-04-01', nextEpisode: null, lastAiredSeason: 1, seasonAirDates: {}, posterPath: null } };
  const r = summarizeSeries(111110, withMeta, 'replacement', saved, today);
  assert.deepEqual([r.name, r.year, r.posterURL, r.overview, r.seasons, r.releasedEpisodes], ['ONE PIECE', '2023', 'https://image.tmdb.org/t/p/w500/live.jpg', 'Live action.', 2, 16]);
  const missing = summarizeSeries(1, bare, 'replacement', saved, today);
  assert.equal(missing.posterURL, null); // neutral placeholder, not the saved show's poster
  assert.equal(missing.overview, null);
  assert.equal(missing.year, '2025');
  const current = summarizeSeries(37854, null, 'current', saved, today); // current catalog unavailable: the entry's own data
  assert.deepEqual([current.name, current.posterURL, current.overview, current.year], ['One Piece', saved.posterURL, 'Saved overview', null]);
}

console.log('edit show (TMDB rematch) tests passed');
