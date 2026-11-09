import type { TrackingSummary } from "@/services/show.service";

/**
 * Shared viewing-state presentation for Shows, Home, Continue watching and Details.
 * The saved position and the next episode are separate facts: each is labelled on its own and one never replaces the other.
 */
export const episodeCode = (season: number, episode: number) => `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;

export const savedPositionCode = (s: TrackingSummary) =>
  s.legacyPosition ? episodeCode(s.legacyPosition.fullSeasons, s.legacyPosition.episodesInNextSeason) : null;

export const nextEpisodeCode = (s: TrackingSummary) => (s.nextEpisode ? episodeCode(s.nextEpisode.season, s.nextEpisode.number) : null);

/** Metadata-derived state. The personal status (e.g. Completed) is shown separately and never changes this. */
export function viewingStateLabel(s: TrackingSummary) {
  switch (s.viewingState) {
  case "fully_watched": return "Fully watched";
  case "caught_up": return "Caught up";
  case "not_started": return "Not started";
  case "in_progress": return "In progress";
  case "needs_review": return "Needs review";
  default: return s.guideAvailable ? "Progress unverified" : "Episode data unavailable";
  }
}

/** "Saved S02E04 · Next S02E05": whichever of the two facts exist, always both when both exist. */
export function positionDetails(s: TrackingSummary) {
  const parts: string[] = [];
  const saved = savedPositionCode(s);
  const next = nextEpisodeCode(s);
  if (saved) parts.push(`Saved ${saved}`);
  if (next) parts.push(`Next ${next}`);
  return parts.join(" · ");
}

const inactiveStatuses = ["planned", "paused", "dropped"];

/** Continue watching lists only shows with a valid, released next episode to play. */
export function canContinueWatching(s: TrackingSummary) {
  return !s.error && s.viewingState === "in_progress" && !!s.nextEpisode && !inactiveStatuses.includes(s.status || "");
}

/** Shows whose saved progress cannot be placed on episodes. Their saved positions are preserved and shown, not hidden. */
export function attentionReason(s: TrackingSummary): string | null {
  if (s.error || s.status === "dropped") return null;
  if (s.viewingState === "needs_review") return `Saved position ${savedPositionCode(s) ?? ""} does not fit the episode data`.replace("  ", " ");
  if (!s.guideAvailable && (s.legacyPosition || s.explicitWatchedCount > 0)) return s.metadataError || "Episode data unavailable";
  return null;
}

const latestWatch = (s: TrackingSummary) => {
  const times = (Array.isArray(s.recentHistory) ? s.recentHistory : []).map(e => Date.parse(e?.watchedAt)).filter(Number.isFinite);
  return times.length ? Math.max(...times) : 0;
};
const statusRank = (s: TrackingSummary) => (s.status === "watching" ? 0 : !s.status ? 1 : 2);

/**
 * What Home shows, chosen from the user's own tracking data (never a fixed show):
 * - featured + continueWatching: playable shows (released next episode; never Dropped, Planned or Paused), most
 *   recently watched first, Watching before other statuses;
 * - newEpisodes: released, unwatched regular episodes that aired after the latest watch (TMDB data; future
 *   episodes are never "available"), excluding Dropped shows and the featured show;
 * - recent: real recorded watch timestamps only (saved positions carry no dates and are never shown as activity).
 */
export function homeDashboard(tracking: TrackingSummary[], continueLimit = 6) {
  const items = tracking.filter(item => item && typeof item === "object" && !item.error);
  const playable = items.filter(canContinueWatching)
    .sort((a, b) => latestWatch(b) - latestWatch(a) || statusRank(a) - statusRank(b) || b.newEpisodes - a.newEpisodes || a.name.localeCompare(b.name));
  const featured = playable[0] || null;
  const newEpisodes = items
    .filter(item => item.status !== "dropped" && item.showId !== featured?.showId && item.countDataAvailable && item.remainingCount > 0 && (item.newEpisodes > 0 || !!item.newSeasonToWatch))
    .sort((a, b) => Number(!!b.newSeasonToWatch) - Number(!!a.newSeasonToWatch) || latestWatch(b) - latestWatch(a) || b.newEpisodes - a.newEpisodes || a.name.localeCompare(b.name));
  const recent = items.flatMap(item => (Array.isArray(item.recentHistory) ? item.recentHistory : [])
    .filter(event => event && Number.isFinite(Date.parse(event.watchedAt)) && Number.isInteger(event.season) && Number.isInteger(event.episode))
    .map(event => ({ item, event })))
    .sort((a, b) => Date.parse(b.event.watchedAt) - Date.parse(a.event.watchedAt));
  // Totals add up only shows whose counts are verified (reliable released-episode metadata); others are left out.
  const verified = items.filter(item => item.countDataAvailable && item.progressPercent !== null);
  return {
    featured, continueWatching: playable.slice(1, 1 + continueLimit), moreToContinue: Math.max(0, playable.length - 1 - continueLimit),
    newEpisodes, recent,
    watching: items.filter(item => item.status === "watching").length,
    episodesWatched: verified.length ? verified.reduce((n, item) => n + item.watchedCount, 0) : null,
    verifiedShows: verified.length,
    watchlist: items.filter(item => item.status === "planned"),
    attention: items.flatMap(item => { const reason = attentionReason(item); return reason ? [{ item, reason }] : []; }),
    unavailable: tracking.filter(item => item?.error).length,
  };
}
