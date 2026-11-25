/**
 * Automatic Watching <-> Completed lifecycle for saved TV shows (pure: no database or network).
 *
 * "Completed" means every released regular episode is watched and the latest released season has verifiably finished
 * airing. It does not require the series to have ended: an announced future season that has not started does not
 * reopen the show. Tracked gaps can move an automatic completion back to Watching. A personal Completed assertion without regular tracking is protected;
 * only verified premieres after a user-confirmed baseline can reopen it. A Completed chosen by hand (manualCompletedAt)
 * is never reopened by episodes released before that choice; only a verified release strictly after it can reopen it.
 *
 * Only the two managed statuses ever change: Dropped, Paused, Planned and "no status" are never touched. Anything
 * uncertain (incomplete or contradictory provider data) yields "no change".
 */
import type { TVMazeEpisode } from './tvmaze/tvmaze-schedule.model';
import { premiereInstant } from './notifications/episode-alerts.model';
import { isEpisodeReleased } from './release-rule.model';



export type ManagedStatus = 'watching' | 'completed';
/** The effective personal status, honoring the legacy `completed` flag for shows saved without a status. */
export const effectiveStatus = (show: { status: string | null; completed: boolean }) => show.status || (show.completed ? 'completed' : null);
export const isManaged = (status: string | null): status is ManagedStatus => status === 'watching' || status === 'completed';
/**
 * The instant the user chose Completed by hand, while the show is still Completed; null otherwise (automatic
 * completions and records saved before this was stored). A manual Completed is the user's own statement: released
 * episodes left unwatched never override it, and only a verified release strictly after this instant can reopen it.
 */
export function manualCompletionBaseline(show: { status: string | null; completed: boolean; manualCompletedAt?: Date | null }): Date | null {
  const at = show.manualCompletedAt;
  return effectiveStatus(show) === 'completed' && at instanceof Date && Number.isFinite(at.getTime()) ? at : null;
}

/** `releaseAt` is Cinetra's effective release instant (release-rule.model); when present, it must also have passed. */
export type StatusEpisode = { season: number; number: number; airDate: string | null; watched: boolean; releaseAt?: string | null };
export type StatusCatalog = {
  seasons: { number: number; episodeCount: number }[];
  /** TMDB's next_episode_to_air, when announced. */
  nextEpisode: { season: number; number: number; airDate: string | null } | null;
};
/** What TVMaze can contribute: a verified schedule, "not on TVMaze" (TMDB alone decides), or unusable. */
export type TVMazeEvidence =
  | { kind: 'verified'; tvmazeId?: number; episodes: TVMazeEpisode[]; timeZone: string | null }
  | { kind: 'not_listed' }
  | { kind: 'unavailable' };

const regular = (e: { season: number; number: number }) => e.season > 0 && e.number > 0;
const tvRegular = (e: TVMazeEpisode) => (!e.type || e.type === 'regular') && (e.season ?? 0) > 0 && (e.number ?? 0) > 0;

export type CompletionCheck = { complete: true } | { complete: false; reason: string };
/**
 * Whether the show is verifiably completed right now. `progressReliable` is the tracking model's verdict that
 * released-episode metadata is complete and the saved position fits it.
 */
export function verifyCompletion(input: { episodes: StatusEpisode[]; catalog: StatusCatalog | null; progressReliable: boolean; tvmaze: TVMazeEvidence; today: string; now: Date }): CompletionCheck {
  const { catalog, today, now, tvmaze } = input;
  if (!catalog || !input.progressReliable) return { complete: false, reason: 'episode data incomplete or saved position does not fit' };
  const episodes = input.episodes.filter(regular);
  const released = episodes.filter(e => !!e.airDate && e.airDate <= today);
  if (!released.length) return { complete: false, reason: 'no released episodes' };
  if (released.some(e => !e.watched)) return { complete: false, reason: 'released episodes remain unwatched' };
  const latest = Math.max(...released.map(e => e.season));
  const declared = catalog.seasons.find(s => s.number === latest);
  const inSeason = episodes.filter(e => e.season === latest);
  // The season must be fully listed and fully aired: a missing date is never proof that a season has finished.
  if (!declared || declared.episodeCount <= 0 || inSeason.length !== declared.episodeCount) return { complete: false, reason: `season ${latest} episode list incomplete` };
  if (inSeason.some(e => !e.airDate || e.airDate > today)) return { complete: false, reason: `season ${latest} still airing` };
  if (catalog.nextEpisode && catalog.nextEpisode.season === latest) return { complete: false, reason: `TMDB announces more of season ${latest}` };
  if (tvmaze.kind === 'unavailable') return { complete: false, reason: 'TVMaze schedule unavailable' };
  if (tvmaze.kind === 'verified') {
    const listed = tvmaze.episodes.filter(e => tvRegular(e) && e.season === latest);
    // TVMaze numbers this season differently (e.g. by year): the two sources cannot be compared safely.
    if (!listed.length) return { complete: false, reason: `TVMaze has no season ${latest} to confirm` };
    // Per episode number, the earliest record counts: a later record for the same number is a rerun, never new.
    const earliest = new Map<number, number | null>();
    for (const e of listed) {
      const at = premiereInstant(e, tvmaze.timeZone)?.at.getTime() ?? null;
      const seen = earliest.get(e.number!);
      if (seen === undefined || (at !== null && (seen === null || at < seen))) earliest.set(e.number!, at);
    }
    if ([...earliest.values()].some(at => at === null || at > now.getTime())) return { complete: false, reason: `TVMaze lists unaired episodes of season ${latest}` };
  }
  const coverage = verifiedCoverage(input);
  if (coverage.reason) return { complete: false, reason: coverage.reason };
  return { complete: true };
}

export type ReopenCheck = { reopen: true; season: number; number: number } | { reopen: false; reason: string };
/** Find an unwatched canonical regular episode whose premiere is verified, regardless of its age. */
export function verifiedUnwatchedPremiere(input: { episodes: StatusEpisode[]; tvmaze: TVMazeEvidence; today: string; now: Date }): ReopenCheck {
  const coverage = verifiedCoverage(input);
  if (coverage.reason) return { reopen: false, reason: coverage.reason };
  const gap = coverage.released.find(e => !e.watched);
  return gap ? { reopen: true, season: gap.season, number: gap.number }
    : { reopen: false, reason: 'No verified released regular episode remains unwatched' };

}

export type StatusTransition = { from: ManagedStatus; to: ManagedStatus; reason: string };
/** The single decision used by every trigger; unwatch actions also require verified evidence. */
export function decideStatus(input: { status: string | null; completion: CompletionCheck; reopen: ReopenCheck }): StatusTransition | null {
  if (input.status === 'watching' && input.completion.complete) return { from: 'watching', to: 'completed', reason: 'all released episodes watched and the latest season has finished' };
  if (input.status === 'completed') {
    if (input.reopen.reopen) return { from: 'completed', to: 'watching', reason: `S${input.reopen.season}E${input.reopen.number} is verified released and unwatched` };

  }
  return null;
}

/** Canonical episode identities only; unknown or conflicting schedules block status writes. */
export function verifiedCoverage(input: { episodes: StatusEpisode[]; tvmaze: TVMazeEvidence; today: string; now: Date }) {
  const released: StatusEpisode[] = [];
  const canonical = input.episodes.filter(regular);
  if (new Set(canonical.map(e => `${e.season}:${e.number}`)).size !== canonical.length)
    return { released, reason: 'Contradictory duplicate TMDB episode identities' };
  if (input.tvmaze.kind === 'verified') {
    for (const t of input.tvmaze.episodes.filter(tvRegular)) {
      const at = premiereInstant(t, input.tvmaze.timeZone)?.at.getTime();
      if (at !== undefined && at <= input.now.getTime() && !canonical.some(e => e.season === t.season && e.number === t.number && !!e.airDate && e.airDate <= input.today))
        return { released, reason: `Cannot reconcile released TVMaze S${t.season}E${t.number} with TMDB` };
    }
  }

  for (const e of input.episodes.filter(e => regular(e) && !!e.airDate && e.airDate <= input.today)) {
    if (input.tvmaze.kind === 'unavailable') return { released, reason: 'TVMaze schedule unavailable' };
    if (input.tvmaze.kind === 'verified') {
      const matches = input.tvmaze.episodes.filter(t => tvRegular(t) && t.season === e.season && t.number === e.number);
      const times = matches.map(t => premiereInstant(t, input.tvmaze.kind === 'verified' ? input.tvmaze.timeZone : null)?.at.getTime());
      if (!times.length || times.some(t => t === undefined)) return { released, reason: `Cannot verify S${e.season}E${e.number} premiere` };
      if (times.filter(t => t === Math.min(...times as number[])).length > 1) return { released, reason: `Cannot verify duplicate TVMaze S${e.season}E${e.number}` };
      if (Math.min(...times as number[]) > input.now.getTime()) return { released, reason: `S${e.season}E${e.number} premiere not yet verified` };
    } else if (Date.parse(`${e.airDate}T00:00:00Z`) + 2 * 86400000 > input.now.getTime()) {
      return { released, reason: `S${e.season}E${e.number} premiere not yet verified` };
    }
    // Statuses never move ahead of what every page shows: the episode must also be released by Cinetra's own rule
    // (TVMaze exact premiere, validated manual override or conservative TMDB fallback).
    if ('releaseAt' in e && !isEpisodeReleased(e, input.now)) return { released, reason: `S${e.season}E${e.number} is not yet released in Cinetra` };
    released.push(e);
  }
  return { released, reason: null };
}

/** A personal Completed assertion is viewing evidence even when no regular tracking was recorded. */
export function hasRegularTracking(input: { seasonsWatched: number; episodesWatched: number; watches: { season: number; episode: number }[]; unwatches: { season: number; episode: number }[] }) {
  return input.seasonsWatched !== 0 || input.episodesWatched !== 0 ||
    [...input.watches, ...input.unwatches].some(e => e.season > 0 && e.episode > 0);
}

/** A supplied baseline is a per-show user assertion, never inferred from createdAt/updatedAt/monitor timestamps. */
export function verifiedPremieresAfterBaseline(input: Parameters<typeof verifiedUnwatchedPremiere>[0] & { baseline: Date }) {
  if (!Number.isFinite(input.baseline.getTime()) || input.baseline > input.now)
    return { episodes: [] as StatusEpisode[], reason: 'Completion baseline must be a valid past instant' };
  const coverage = verifiedCoverage(input);
  if (coverage.reason) return { episodes: [] as StatusEpisode[], reason: coverage.reason };
  const episodes = coverage.released.filter(e => {
    if (e.watched) return false;
    if (input.tvmaze.kind === 'verified') {
      const times = input.tvmaze.episodes.filter(t => tvRegular(t) && t.season === e.season && t.number === e.number)
        .map(t => premiereInstant(t, input.tvmaze.kind === 'verified' ? input.tvmaze.timeZone : null)!.at.getTime());
      return Math.min(...times) > input.baseline.getTime();
    }
    // A date without a timezone cannot prove a premiere was after a baseline within that day.
    return Date.parse(`${e.airDate}T00:00:00Z`) - 14 * 3600000 > input.baseline.getTime();
  });
  return { episodes, reason: null };
}

export function verifiedPremiereAfterBaseline(input: Parameters<typeof verifiedPremieresAfterBaseline>[0]): ReopenCheck {
  const result = verifiedPremieresAfterBaseline(input);
  if (result.reason) return { reopen: false, reason: result.reason };
  const gap = result.episodes[0];
  return gap ? { reopen: true, season: gap.season, number: gap.number }
    : { reopen: false, reason: 'No verified new regular premiere after your confirmed completion baseline' };
}
