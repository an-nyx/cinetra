/** Full-library eligibility is independent of the obsolete six-show deployment scope. */
export function libraryStatusTarget(show: { id: string; userId: string; tmdbId: number | null; tvmazeId: number | null; status?: string | null; completed?: boolean }) {
  const status = show.status || (show.completed ? 'completed' : null);
  return show.tmdbId && (status === 'watching' || status === 'completed')
    ? { showId: show.id, tmdbId: show.tmdbId, tvmazeId: show.tvmazeId } : null;
}
export const libraryWritesEnabled = () => process.env.TV_STATUS_RECONCILIATION_MODE === 'full-library' && process.env.TV_STATUS_RECONCILIATION_ENABLED === 'true';
