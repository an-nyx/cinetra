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
