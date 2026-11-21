/**
 * Upcoming assembly (pure). Every dated release comes from TVMaze; TMDB dates are never merged in or used as a
 * fallback. A show whose TVMaze identity cannot be verified is listed for review and contributes nothing.
 */
import type { ReleaseSource } from './release-rule.model';
import { channelOf, IDENTITY_FAILURE_TEXT, isReturningWithoutDate, type EpisodeExclusions, type IdentityFailure, type IdentityMethod, type ScheduledEpisode, type TVMazeShow } from './tvmaze/tvmaze-schedule.model';

export type LibraryShow = { id: string; name: string; posterURL: string | null; status: string | null };
/**
 * Cinetra's effective release instant for the same canonical episode (release-rule.model): the moment Home and the
 * Watch Room treat it as released. Null when the TMDB catalog is unavailable or TVMaze's numbering for this series is
 * not verified against TMDB (then the TVMaze date is shown alone, as before).
 */
export type ReleaseInfo = { releaseAt: string | null; releaseSource: ReleaseSource | null };
export type UpcomingRelease = ScheduledEpisode & ReleaseInfo & {
  /** Stable key: TVMaze show ID + TVMaze episode ID. */
  id: string; tvmazeShowId: number;
  showId: string; showName: string; posterURL: string | null; showStatus: string | null;
  channel: string | null; streaming: boolean; scheduleSource: 'TVMaze';
};
export type ShowOutcome =
  | { kind: 'scheduled'; show: LibraryShow; tvmaze: Pick<TVMazeShow, 'id' | 'name' | 'status' | 'network' | 'webChannel'>; method: IdentityMethod; tmdbBasis: 'linked' | 'schedule_match'; episodes: (ScheduledEpisode & Partial<ReleaseInfo>)[]; excluded: EpisodeExclusions; stale: boolean }
  | { kind: 'review'; show: LibraryShow; reason: IdentityFailure }
  | { kind: 'unavailable'; show: LibraryShow; provider: 'TMDB' | 'TVMaze' };

// TVMaze's own (network-local) date first, then the confirmed instant; date-only entries lead their day. Pages re-sort in local time.
const byRelease = (a: UpcomingRelease, b: UpcomingRelease) => a.airDate.localeCompare(b.airDate) || (a.airTimestamp ? Date.parse(a.airTimestamp) : 0) - (b.airTimestamp ? Date.parse(b.airTimestamp) : 0);

export function assembleUpcoming(input: ShowOutcome[], generatedAt: string) {
  // Two library entries that resolve to one TVMaze series cannot both be right: neither is trusted.
  const byTVMaze = new Map<number, number>();
  for (const outcome of input) if (outcome.kind === 'scheduled') byTVMaze.set(outcome.tvmaze.id, (byTVMaze.get(outcome.tvmaze.id) || 0) + 1);
  const outcomes: ShowOutcome[] = input.map(outcome => outcome.kind === 'scheduled' && byTVMaze.get(outcome.tvmaze.id)! > 1
    ? { kind: 'review', show: outcome.show, reason: 'shared_tvmaze_identity' } : outcome);

  const releases = new Map<string, UpcomingRelease>();
  const returningTba: { showId: string; showName: string; posterURL: string | null; showStatus: string | null; tvmazeStatus: string; announcedEpisodes: number }[] = [];
  const excluded: EpisodeExclusions = { specials: 0, past: 0, undated: 0, duplicates: 0, repeats: 0 };
  for (const outcome of outcomes) {
    if (outcome.kind !== 'scheduled') continue;
    for (const key of Object.keys(excluded) as (keyof EpisodeExclusions)[]) excluded[key] += outcome.excluded[key];
    const { channel, streaming } = channelOf(outcome.tvmaze);
    for (const episode of outcome.episodes) {
      const id = `${outcome.tvmaze.id}:${episode.episodeId}`;
      if (releases.has(id)) { excluded.duplicates++; continue; }
      releases.set(id, {
        ...episode, releaseAt: episode.releaseAt ?? null, releaseSource: episode.releaseSource ?? null, id, tvmazeShowId: outcome.tvmaze.id, showId: outcome.show.id, showName: outcome.show.name,
        posterURL: outcome.show.posterURL, showStatus: outcome.show.status, channel, streaming, scheduleSource: 'TVMaze',
      });
    }
    if (isReturningWithoutDate(outcome.tvmaze.status, outcome.episodes.length)) returningTba.push({
      showId: outcome.show.id, showName: outcome.show.name, posterURL: outcome.show.posterURL, showStatus: outcome.show.status,
      tvmazeStatus: outcome.tvmaze.status!, announcedEpisodes: outcome.excluded.undated,
    });
  }
  const scheduled = outcomes.filter((o): o is Extract<ShowOutcome, { kind: 'scheduled' }> => o.kind === 'scheduled');
  const review = outcomes.filter((o): o is Extract<ShowOutcome, { kind: 'review' }> => o.kind === 'review');
  const unavailable = outcomes.filter((o): o is Extract<ShowOutcome, { kind: 'unavailable' }> => o.kind === 'unavailable');
  const staleShows = scheduled.filter(o => o.stale).length;
  return {
    status: 'ready' as const, source: 'TVMaze' as const, generatedAt, stale: staleShows > 0 || unavailable.some(o => o.provider === 'TVMaze'),
    releases: [...releases.values()].sort((a, b) => byRelease(a, b) || a.showName.localeCompare(b.showName) || a.season - b.season || a.number - b.number),
    returningTba: returningTba.sort((a, b) => a.showName.localeCompare(b.showName)),
    needsReview: review.map(o => ({ showId: o.show.id, showName: o.show.name, posterURL: o.show.posterURL, reason: o.reason, detail: IDENTITY_FAILURE_TEXT[o.reason] }))
      .sort((a, b) => a.showName.localeCompare(b.showName)),
    unavailable: unavailable.map(o => ({ showId: o.show.id, showName: o.show.name, provider: o.provider })),
    coverage: {
      evaluatedShows: outcomes.length, verifiedShows: scheduled.length,
      verifiedByExternalId: scheduled.filter(o => o.method === 'external_id').length,
      verifiedByTitle: scheduled.filter(o => o.method === 'title_corroborated').length,
      viaScheduleOnlyTMDBMatch: scheduled.filter(o => o.tmdbBasis === 'schedule_match').length,
      scheduledShows: new Set([...releases.values()].map(r => r.showId)).size,
      unresolvedShows: review.length, unavailableShows: unavailable.length, staleShows, excludedEpisodes: excluded,
    },
  };
}
export type UpcomingResponse = ReturnType<typeof assembleUpcoming>;
