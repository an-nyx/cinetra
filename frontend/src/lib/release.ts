/**
 * Episode release eligibility, as the server decides it (backend/src/services/release-rule.model.ts).
 *
 * The server sends each episode's `releaseAt`: the UTC instant from which it counts as released (TVMaze's verified
 * premiere, or the conservative TMDB fallback). The page only compares that instant with the current time, so an
 * open Watch Room flips an episode to released at the same moment Home and the server do. Responses without
 * `releaseAt` (older servers or caches) use the same fallback as the server: the TMDB date has ended everywhere on
 * Earth (D+1 12:00 UTC).
 */
export type Releasable = { airDate: string | null; releaseAt?: string | null };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function tmdbReleaseAt(airDate: string | null | undefined): string | null {
  if (!airDate || !DATE.test(airDate) || Number.isNaN(Date.parse(`${airDate}T00:00:00Z`))) return null;
  return new Date(Date.parse(`${airDate}T12:00:00Z`) + 86_400_000).toISOString();
}

/** A comparable UTC instant; a bare YYYY-MM-DD is the start of that UTC day. */
export function instantOf(now: string | Date): string {
  if (now instanceof Date) return now.toISOString();
  if (DATE.test(now)) return `${now}T00:00:00.000Z`;
  return new Date(Date.parse(now)).toISOString();
}

export function isEpisodeReleased(episode: Releasable, now: string | Date = new Date()): boolean {
  const at = episode.releaseAt !== undefined ? (episode.airDate ? episode.releaseAt : null) : tmdbReleaseAt(episode.airDate);
  return !!at && at <= instantOf(now);
}
