import type { EpisodeGuide, TrackingSummary } from "../services/show.service";
import { isEpisodeReleased } from "./release.ts";

/**
 * Confirmed watch progress shared between the Watch Room, Home, Continue watching and the show cards.
 *
 * An episode save answers with the committed tracking summary, so pages patch one show in place instead of reloading
 * the whole library. Ordering uses one monotonic clock per tab: saves are compared by when they started, and a full
 * library read that started before a confirmation can never bring that show's older progress back.
 */
export const TRACKING_SUMMARY_EVENT = "cinetra:tracking-summary";

let clock = 0;
/** Monotonic order of tracking reads and saves in this tab. */
export const trackingTick = () => ++clock;

export type ConfirmedSummary = { summary: TrackingSummary; started: number; confirmed: number };

export function publishConfirmedSummary(update: ConfirmedSummary) {
  window.dispatchEvent(new CustomEvent<ConfirmedSummary>(TRACKING_SUMMARY_EVENT, { detail: update }));
}
export function onConfirmedSummary(listener: (update: ConfirmedSummary) => void) {
  const handler = (event: Event) => { const detail = (event as CustomEvent<ConfirmedSummary>).detail; if (detail?.summary?.showId) listener(detail); };
  window.addEventListener(TRACKING_SUMMARY_EVENT, handler);
  return () => window.removeEventListener(TRACKING_SUMMARY_EVENT, handler);
}

export function createConfirmedSummaries() {
  const confirmed = new Map<string, ConfirmedSummary>();
  return {
    /** Record a confirmation. False when a save for that show that started later was already confirmed. */
    accept(update: ConfirmedSummary) {
      const current = confirmed.get(update.summary.showId);
      if (current && current.started > update.started) return false;
      confirmed.set(update.summary.showId, update);
      return true;
    },
    /**
     * Overlay confirmations on rows from a read that started at `readStarted` (0: rows already shown). Confirmations
     * older than that read are already included in it and are forgotten.
     */
    merge(rows: TrackingSummary[], readStarted = 0) {
      for (const [id, entry] of confirmed) if (readStarted > entry.confirmed) confirmed.delete(id);
      if (!confirmed.size) return rows;
      return rows.map(row => confirmed.get(row.showId)?.summary ?? row);
    },
  };
}


/** Same rounding as the server: never 0% or 100% unless exact. */
export function progressPercent(watched: number, released: number) {
  if (released <= 0) return null;
  if (watched >= released) return 100;
  if (watched <= 0) return 0;
  return Math.min(99, Math.max(1, Math.round(watched / released * 100)));
}

/**
 * The Watch Room's immediate view of one episode change, before the server confirms it. Only what follows safely
 * from the visible data changes: counts for a released episode, and the next episode when it is in the loaded season.
 * Otherwise `nextPending` says the next episode is unknown until the confirmed summary arrives.
 */
export function optimisticSummary(summary: TrackingSummary, guide: EpisodeGuide | null, season: number, number: number, watched: boolean, today: string): { summary: TrackingSummary; nextPending: boolean } {
  const episodes = guide?.season === season ? [...guide.episodes].sort((a, b) => a.number - b.number) : [];
  const episode = episodes.find(e => e.number === number);
  const isNext = summary.nextEpisode?.season === season && summary.nextEpisode.number === number;
  const wasWatched = episode ? episode.watched : isNext ? false : null;
  if (wasWatched === null || wasWatched === watched) return { summary, nextPending: false };
  const released = episode ? isEpisodeReleased(episode, today) : !!summary.nextEpisode && isEpisodeReleased(summary.nextEpisode, today);
  const counted = summary.countDataAvailable && summary.progressPercent !== null && season > 0 && number > 0 && released;
  let next: TrackingSummary = summary;
  if (counted) {
    const delta = watched ? 1 : -1;
    const watchedCount = summary.watchedCount + delta;
    next = { ...summary, watchedCount, remainingCount: summary.remainingCount - delta, progressPercent: progressPercent(watchedCount, summary.releasedCount) };
  }
  if (watched && isNext) {
    const following = episodes.find(e => e.number > number && !e.watched && isEpisodeReleased(e, today));
    if (following) return { summary: { ...next, nextEpisode: { season, number: following.number, name: following.name, airDate: following.airDate, releaseAt: following.releaseAt, runtime: following.runtime, watchedAt: null } }, nextPending: false };
    return { summary: { ...next, nextEpisode: null }, nextPending: true };
  }
  if (!watched && counted && episode) {
    const current = summary.nextEpisode;
    const earlier = !current || season < current.season || (season === current.season && number < current.number);
    if (earlier) {
      const viewingState = next.viewingState === "caught_up" || next.viewingState === "fully_watched" ? "in_progress" : next.viewingState;
      return { summary: { ...next, viewingState, completionEligible: false, nextEpisode: { season, number, name: episode.name, airDate: episode.airDate, releaseAt: episode.releaseAt, runtime: episode.runtime, watchedAt: null } }, nextPending: false };
    }
  }
  return { summary: next, nextPending: false };
}
