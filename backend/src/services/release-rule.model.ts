/**
 * Episode release eligibility: the one rule every tracking path uses (pure, no network, no database).
 *
 * TMDB stays the canonical episode identity and numbering. Each catalog episode carries `releaseAt`, the UTC instant
 * from which it counts as released, and `releaseSource`, which says where that instant came from:
 *
 * - `tvmaze_exact`: TVMaze's original premiere airstamp for the same episode. Used only when the TVMaze series was
 *   verified through TheTVDB/IMDb IDs, its schedule is current, its regular numbering fits TMDB's (no TVMaze-only
 *   episodes, no duplicate numbers) and TVMaze lists the same local air date as TMDB.
 * - `manual_override`: a validated entry in backend/config/release-overrides.json (release-override.model), used only
 *   where TVMaze has no exact premiere, the entry still matches TMDB's current air date, and a matched TVMaze date does
 *   not contradict TMDB by more than a day. Never inferred from a platform; every entry cites its source.
 * - `tvmaze_date_local` / `tvmaze_date_worldwide`: the same checks pass but TVMaze gives a date without a time. The
 *   episode counts once that day has ended in the channel's time zone (or everywhere on Earth without a zone); the
 *   same conservative instant Web Push and automatic statuses use (`premiereInstant`).
 * - `tmdb_date`: everything else. TMDB air dates are local calendar dates with no time zone (normally the original
 *   network's), so the only safe reading is "that day has ended everywhere on Earth": the last time zone, UTC-12,
 *   finishes day D at D+1 12:00 UTC. Late by up to about a day and a half, never early.
 *
 * An episode without a TMDB air date is never released, whatever TVMaze says.
 */
import type { TVMazeEpisode, TVMazeShow } from './tvmaze/tvmaze-schedule.model';
import { premiereInstant, scheduleTimeZone } from './notifications/episode-alerts.model';
import { resolveOverride, type OverrideOutcome, type ReleaseOverride } from './release-override.model';

export type ReleaseSource = 'tvmaze_exact' | 'manual_override' | 'tvmaze_date_local' | 'tvmaze_date_worldwide' | 'tmdb_date';
export type Releasable = { airDate: string | null; releaseAt?: string | null };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
/** A TVMaze airstamp further than this from its own listed date is inconsistent and not trusted. */
const MAX_STAMP_DRIFT_MS = 36 * 60 * 60_000;

/** The TMDB date-only fallback: day D has ended everywhere on Earth at D+1 12:00 UTC. Null without a valid date. */
export function tmdbReleaseAt(airDate: string | null | undefined): string | null {
  if (!airDate || !DATE.test(airDate) || Number.isNaN(Date.parse(`${airDate}T00:00:00Z`))) return null;
  return new Date(Date.parse(`${airDate}T12:00:00Z`) + DAY_MS).toISOString();
}

/**
 * Normalise "now" to a comparable UTC ISO instant. A bare YYYY-MM-DD means the start of that UTC day (callers and
 * tests that only know a date never see an episode as released before the date's fallback instant).
 */
export function instantOf(now: string | Date): string {
  if (now instanceof Date) return now.toISOString();
  if (DATE.test(now)) return `${now}T00:00:00.000Z`;
  const parsed = Date.parse(now);
  if (Number.isNaN(parsed)) throw new Error(`Invalid instant: ${now}`);
  return new Date(parsed).toISOString();
}

/** The instant an episode counts as released: its catalog `releaseAt`, else the TMDB date fallback. */
export const releaseInstant = (episode: Releasable): string | null =>
  episode.releaseAt !== undefined ? (episode.airDate ? episode.releaseAt : null) : tmdbReleaseAt(episode.airDate);

/** Whether an episode is released at `now` (an ISO instant, a Date, or a YYYY-MM-DD day start). */
export function isEpisodeReleased(episode: Releasable, now: string | Date): boolean {
  const at = releaseInstant(episode);
  return !!at && at <= instantOf(now);
}

export type ReleaseSchedule = { show: Pick<TVMazeShow, 'network' | 'webChannel'>; episodes: TVMazeEpisode[] };
export type ReleaseTiming = { source: 'tvmaze' | 'tmdb_only'; tvmazeId: number | null; reason: string; overrides?: OverrideOutcome[] };

const tvRegular = (e: TVMazeEpisode) => (!e.type || e.type === 'regular') && Number.isInteger(e.season) && (e.season ?? 0) > 0 && Number.isInteger(e.number) && (e.number ?? 0) > 0;
const key = (season: number, number: number) => `${season}:${number}`;

/** Release instants from TVMaze and TMDB alone, plus the TVMaze record matched to each episode (when trustworthy). */
function baseReleaseTimes<T extends { season: number; number: number; airDate: string | null }>(
  episodes: T[], schedule: ReleaseSchedule | null, tvmazeId: number | null, unavailableReason: string,
): { episodes: (T & { releaseAt: string | null; releaseSource: ReleaseSource | null })[]; timing: ReleaseTiming; matched: Map<string, TVMazeEpisode> } {
  const fallback = (reason: string) => ({
    episodes: episodes.map(e => { const at = tmdbReleaseAt(e.airDate); return { ...e, releaseAt: at, releaseSource: at ? 'tmdb_date' as const : null }; }),
    timing: { source: 'tmdb_only' as const, tvmazeId, reason },
    matched: new Map<string, TVMazeEpisode>(),
  });
  if (!schedule) return fallback(unavailableReason);

  const canonical = new Set(episodes.filter(e => e.season > 0 && e.number > 0).map(e => key(e.season, e.number)));
  // One record per TVMaze episode ID; distinct records sharing a number are reruns or renumbering: never trusted.
  const byId = new Map<number, TVMazeEpisode>();
  for (const e of schedule.episodes.filter(tvRegular)) byId.set(e.id, e);
  const byNumber = new Map<string, TVMazeEpisode[]>();
  for (const e of byId.values()) byNumber.set(key(e.season!, e.number!), [...(byNumber.get(key(e.season!, e.number!)) || []), e]);
  // TVMaze numbers an episode TMDB does not have (split finales, parts vs seasons): the mapping is ambiguous.
  const extra = [...byNumber.keys()].find(k => !canonical.has(k));
  if (extra) return fallback(`TVMaze numbering does not match TMDB (TVMaze S${extra.replace(':', 'E')} is not on TMDB)`);

  const matched = new Map<string, TVMazeEpisode>();
  for (const [k, list] of byNumber) if (list.length === 1) matched.set(k, list[0]);
  const timeZone = scheduleTimeZone(schedule.show);
  return {
    matched,
    episodes: episodes.map(e => {
      const fallbackAt = tmdbReleaseAt(e.airDate);
      const base = { ...e, releaseAt: fallbackAt, releaseSource: fallbackAt ? 'tmdb_date' as ReleaseSource : null };
      if (!fallbackAt || e.season < 1 || e.number < 1) return base;
      const tv = matched.get(key(e.season, e.number));
      if (!tv) return base;
      // Dates that disagree (time zone conventions, early streaming releases, data errors) are not trusted.
      if (tv.airdate !== e.airDate) return base;
      const premiere = premiereInstant(tv, timeZone);
      if (!premiere) return base;
      const at = premiere.at.getTime();
      if (Math.abs(at - Date.parse(`${tv.airdate}T00:00:00Z`)) > MAX_STAMP_DRIFT_MS) return base;
      const source: ReleaseSource = premiere.timing === 'exact' ? 'tvmaze_exact' : premiere.timing === 'date_only_local' ? 'tvmaze_date_local' : 'tvmaze_date_worldwide';
      return { ...e, releaseAt: premiere.at.toISOString(), releaseSource: source };
    }),
    timing: { source: 'tvmaze', tvmazeId, reason: 'Verified TVMaze schedule with matching numbering' },
  };
}

/**
 * Give every catalog episode its release instant. `schedule` is the verified TVMaze schedule for the same series, or
 * null (not verified, not listed, stale or unavailable): then TMDB dates alone decide, through the fallback.
 * `overrides` are this series' validated manual entries (release-override.model): applied only where TVMaze has no
 * exact premiere, the TMDB-date guard holds and a matched TVMaze date does not contradict TMDB by more than a day.
 * A verified TVMaze exact premiere always wins; disagreeing overrides are reported, never silently applied.
 * Never changes episode identity, numbering, names or dates.
 */
export function assignReleaseTimes<T extends { season: number; number: number; airDate: string | null }>(
  episodes: T[], schedule: ReleaseSchedule | null, tvmazeId: number | null = null, unavailableReason = 'TVMaze schedule not verified',
  overrides: readonly ReleaseOverride[] = [],
): { episodes: (T & { releaseAt: string | null; releaseSource: ReleaseSource | null; releaseOverrideId?: string })[]; timing: ReleaseTiming } {
  const base = baseReleaseTimes(episodes, schedule, tvmazeId, unavailableReason);
  if (!overrides.length) return { episodes: base.episodes, timing: base.timing };
  const outcomes: OverrideOutcome[] = [];
  const timed = base.episodes.map(e => {
    if (e.season < 1 || e.number < 1) return e;
    const resolved = resolveOverride(overrides, e);
    if (!resolved) return e;
    const { override, result } = resolved;
    const report = (status: OverrideOutcome['status'], detail: string, releaseAt: string | null = null) => outcomes.push({ id: override.id, season: e.season, episode: e.number, status, releaseAt, detail });
    if ('status' in result) { report(result.status, result.detail); return e; }
    if (e.releaseSource === 'tvmaze_exact') {
      if (result.at === e.releaseAt) report('redundant', 'Same instant as the verified TVMaze premiere', result.at);
      else report('conflict_tvmaze_exact', `Verified TVMaze premiere ${e.releaseAt} is kept; the entry says ${result.at}`, result.at);
      return e;
    }
    const tv = base.matched.get(key(e.season, e.number));
    if (tv?.airdate && e.airDate && Math.abs(Date.parse(`${tv.airdate}T00:00:00Z`) - Date.parse(`${e.airDate}T00:00:00Z`)) > DAY_MS) {
      report('conflict_tvmaze_date', `TVMaze lists ${tv.airdate} for this episode, TMDB ${e.airDate}: the schedule is uncertain`, result.at);
      return e;
    }
    report('applied', `Released at ${result.at} (${override.timeZone})`, result.at);
    return { ...e, releaseAt: result.at, releaseSource: 'manual_override' as const, releaseOverrideId: override.id };
  });
  // Episode entries that name an episode TMDB does not list.
  for (const o of overrides) if (o.kind === 'episode' && !episodes.some(e => e.season === o.season && e.number === o.episode))
    outcomes.push({ id: o.id, season: o.season, episode: o.episode, status: 'no_matching_episode', releaseAt: null, detail: 'TMDB lists no such episode' });
  return { episodes: timed, timing: { ...base.timing, overrides: outcomes } };
}
