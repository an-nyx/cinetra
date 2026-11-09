import assert from 'node:assert/strict';
import { AxiosError } from 'axios';
import { chooseScheduleOnlyTMDBMatch, descriptionSimilarity } from '../src/services/schedule-identity';
import { buildTrackingSummary, type Catalog } from '../src/services/tracking-summary.model';

const today = '2026-11-09';
const overview = 'Two detectives investigate a series of disappearances in a remote coastal town where everyone hides a secret.';

// Schedule-only TMDB identity: exact title + strongly matching overview + unique + not already linked.
{
  const candidate = { id: 11, name: 'Harbor Lights', original_name: 'Harbor Lights', overview, first_air_date: '2024-03-01' };
  const library = { name: 'Harbor Lights', overview };
  assert.deepEqual(chooseScheduleOnlyTMDBMatch(library, [candidate], new Set()), { tmdbId: 11, firstAirDate: '2024-03-01' });
  assert.deepEqual(chooseScheduleOnlyTMDBMatch({ name: 'harbor  lights!', overview }, [candidate], new Set()), { tmdbId: 11, firstAirDate: '2024-03-01' }); // normalised title
  assert.equal(chooseScheduleOnlyTMDBMatch({ name: 'Harbor Lights', overview: '' }, [candidate], new Set()).tmdbId, null); // no overview to corroborate
  assert.deepEqual(chooseScheduleOnlyTMDBMatch({ name: 'Harbor Lights', overview: null }, [candidate], new Set()), { tmdbId: null, reason: 'no_library_overview' });
  assert.deepEqual(chooseScheduleOnlyTMDBMatch({ name: 'Harbour Lights', overview }, [candidate], new Set()), { tmdbId: null, reason: 'no_exact_title' });
  assert.deepEqual(chooseScheduleOnlyTMDBMatch(library, [{ ...candidate, overview: 'A cooking competition between rival chefs in a busy kitchen on weekends.' }], new Set()), { tmdbId: null, reason: 'weak_overview' });
  assert.deepEqual(chooseScheduleOnlyTMDBMatch(library, [candidate, { ...candidate, id: 12, first_air_date: '1998-01-01' }], new Set()), { tmdbId: null, reason: 'ambiguous' }); // remake with same synopsis
  assert.deepEqual(chooseScheduleOnlyTMDBMatch(library, [candidate], new Set([11])), { tmdbId: null, reason: 'already_linked' });
  assert.ok(descriptionSimilarity(overview, overview) === 1 && descriptionSimilarity(overview, '') === 0);
}

// Every unavailable percentage carries a specific, non-invented reason; available ones carry none.
{
  const show = (s: number, e: number) => ({ id: 'x', name: 'Sample', posterURL: null, status: null, completed: false, seasonsWatched: s, episodesWatched: e });
  const catalog = (counts: number[], override: Record<string, string | null> = {}, declared?: number[]): Catalog => ({
    seasons: counts.map((n, i) => ({ number: i + 1, episodeCount: declared?.[i] ?? n })), source: 'TMDB', broadcastStatus: 'Returning Series', inProduction: true, nextEpisodeAnnounced: false,
    episodes: counts.flatMap((n, i) => Array.from({ length: n }, (_, j) => ({ season: i + 1, number: j + 1, airDate: `${i + 1}:${j + 1}` in override ? override[`${i + 1}:${j + 1}`] : '2024-01-01', name: '', airTimestamp: null, runtime: null }))),
  });
  const reason = (s: ReturnType<typeof buildTrackingSummary>) => s.progressUnavailable?.code ?? null;

  const ok = buildTrackingSummary(show(1, 2), catalog([8]), null, [], today);
  assert.equal(ok.progressPercent, 25); assert.equal(ok.progressUnavailable, null);
  // Undated announced episodes never block released progress (Fix 8 preserved).
  assert.equal(buildTrackingSummary(show(1, 2), catalog([8], { '1:7': null, '1:8': null }), null, [], today).progressPercent, 33);

  const unlinked = buildTrackingSummary(show(1, 2), null, 'TMDB match required to load episode metadata', [], today, 'no_tmdb_association');
  assert.equal(reason(unlinked), 'no_tmdb_association'); assert.equal(unlinked.progressUnavailable?.label, 'No TMDB match');
  assert.match(unlinked.progressUnavailable!.detail, /S01E02 is kept/);
  assert.equal(reason(buildTrackingSummary(show(1, 2), null, 'Request failed with status code 401', [], today, 'tmdb_auth_failed')), 'tmdb_auth_failed');
  assert.equal(reason(buildTrackingSummary(show(1, 2), null, 'Request failed with status code 404', [], today, 'tmdb_not_found')), 'tmdb_not_found');
  assert.equal(reason(buildTrackingSummary(show(1, 2), null, 'timeout', [], today, 'tmdb_unavailable')), 'tmdb_unavailable');
  assert.equal(reason(buildTrackingSummary(show(1, 2), null, null, [], today)), 'tmdb_unavailable'); // no catalog, cause unknown: never "fine"

  const conflict = buildTrackingSummary(show(1, 12), catalog([8]), null, [], today);
  assert.equal(reason(conflict), 'saved_position_conflict');
  assert.match(conflict.progressUnavailable!.detail, /S01E12 is beyond the 8 episodes TMDB lists for season 1/);
  assert.equal(conflict.legacyPosition?.episodesInNextSeason, 12); // preserved
  assert.match(buildTrackingSummary(show(0, 5), catalog([8]), null, [], today).progressUnavailable!.detail, /names no season/);

  const gap = buildTrackingSummary(show(1, 2), catalog([8], {}, [10]), null, [], today);
  assert.equal(reason(gap), 'incomplete_metadata');
  assert.match(gap.progressUnavailable!.detail, /season 1 has 10 episodes but lists 8/);
  const undatedEarly = buildTrackingSummary(show(1, 1), catalog([8], { '1:3': null }), null, [], today);
  assert.match(undatedEarly.progressUnavailable!.detail, /S01E03 has no air date/);

  const future = buildTrackingSummary(show(0, 0), catalog([6], Object.fromEntries([1, 2, 3, 4, 5, 6].map(n => [`1:${n}`, '2027-02-01']))), null, [], today);
  assert.equal(reason(future), 'no_released_episodes');
}

console.log('schedule identity and progress reason tests passed');
