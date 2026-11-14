/**
 * Automatic Watching <-> Completed lifecycle for saved TV shows (pure: no database or network).
 *
 * "Completed" means every released regular episode is watched and the latest released season has verifiably finished
 * airing. It does not require the series to have ended: an announced future season that has not started does not
 * reopen the show. A verified premiere of a new episode after the show was completed moves it back to Watching.
 *
 * Only the two managed statuses ever change: Dropped, Paused, Planned and "no status" are never touched. Anything
 * uncertain (incomplete or contradictory provider data) yields "no change".
 */
import type { TVMazeEpisode } from './tvmaze/tvmaze-schedule.model';
import { premiereInstant } from './notifications/episode-alerts.model';

/** Earliest premiere that may reopen a completed show: episodes that were already out before automatic statuses existed never do. */
export const AUTO_STATUS_SINCE = new Date('2026-11-14T00:00:00Z');

export type ManagedStatus = 'watching' | 'completed';
/** The effective personal status, honoring the legacy `completed` flag for shows saved without a status. */
export const effectiveStatus = (show: { status: string | null; completed: boolean }) => show.status || (show.completed ? 'completed' : null);
export const isManaged = (status: string | null): status is ManagedStatus => status === 'watching' || status === 'completed';

export type StatusEpisode = { season: number; number: number; airDate: string | null; watched: boolean };
export type StatusCatalog = {
  seasons: { number: number; episodeCount: number }[];
  /** TMDB's next_episode_to_air, when announced. */
  nextEpisode: { season: number; number: number; airDate: string | null } | null;
};
/** What TVMaze can contribute: a verified schedule, "not on TVMaze" (TMDB alone decides), or unusable. */
export type TVMazeEvidence =
  | { kind: 'verified'; episodes: TVMazeEpisode[]; timeZone: string | null }
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
  return { complete: true };
}

export type ReopenCheck = { reopen: true; season: number; number: number } | { reopen: false; reason: string };
/**
 * Whether a verified new regular episode premiered after the show was completed (and after automatic statuses were
 * introduced), and is unwatched. TMDB lists the episode; a verified TVMaze schedule must confirm the same episode has
 * premiered (its conservative premiere instant). Without a TVMaze listing, the TMDB air date must have fully passed.
 */
export function newPremiereSinceCompleted(input: { episodes: StatusEpisode[]; completedSince: Date | null; tvmaze: TVMazeEvidence; today: string; now: Date; featureSince?: Date }): ReopenCheck {
  const { tvmaze, now, today } = input;
  if (tvmaze.kind === 'unavailable') return { reopen: false, reason: 'TVMaze schedule unavailable' };
  const since = new Date(Math.max((input.featureSince ?? AUTO_STATUS_SINCE).getTime(), input.completedSince?.getTime() ?? 0));
  const sinceDay = since.toISOString().slice(0, 10);
  const candidates = input.episodes
    .filter(e => regular(e) && !e.watched && !!e.airDate && e.airDate <= today && e.airDate >= sinceDay)
    .sort((a, b) => a.season - b.season || a.number - b.number);
  for (const episode of candidates) {
    if (tvmaze.kind === 'verified') {
      const match = tvmaze.episodes.filter(e => tvRegular(e) && e.season === episode.season && e.number === episode.number);
      if (match.length !== 1) continue;   // not listed, or listed twice: no guessing
      const premiere = premiereInstant(match[0], tvmaze.timeZone);
      if (!premiere || premiere.at.getTime() > now.getTime() || premiere.at.getTime() < since.getTime()) continue;
    } else if (Date.parse(`${episode.airDate}T00:00:00Z`) + 2 * 86_400_000 > now.getTime()) {
      continue;   // TMDB dates carry no time zone: wait until the listed day has ended everywhere
    }
    return { reopen: true, season: episode.season, number: episode.number };
  }
  return { reopen: false, reason: candidates.length ? 'premiere not yet verified' : 'no new unwatched premiere' };
}

export type StatusTransition = { from: ManagedStatus; to: ManagedStatus; reason: string };
/**
 * The single decision used by every trigger. `brokeCompletion` is true when a user action (unwatching) turned a
 * verified completion into an incomplete one; only then may an unwatch reopen a Completed show.
 */
export function decideStatus(input: { status: string | null; completion: CompletionCheck; reopen: ReopenCheck; brokeCompletion?: boolean }): StatusTransition | null {
  if (input.status === 'watching' && input.completion.complete) return { from: 'watching', to: 'completed', reason: 'all released episodes watched and the latest season has finished' };
  if (input.status === 'completed') {
    if (input.reopen.reopen) return { from: 'completed', to: 'watching', reason: `S${input.reopen.season}E${input.reopen.number} premiered` };
    if (input.brokeCompletion && !input.completion.complete) return { from: 'completed', to: 'watching', reason: 'a watched episode was unmarked' };
  }
  return null;
}
