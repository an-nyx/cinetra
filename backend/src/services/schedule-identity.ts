/**
 * Conservative, schedule-only identity rules.
 *
 * Used only by Upcoming to find a schedule for a library show that has no stored TMDB association. A match found
 * here is never persisted and never used for tracking, progress, completion or show creation.
 */
export const normalizeText = (value: string | null | undefined) => (value || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/<[^>]*>/g, ' ').replace(/&[^;]+;/g, ' ').toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = (value: string | null | undefined) => new Set(normalizeText(value).split(/\s+/).filter(token => token.length > 2));

/** Share of the shorter description's distinctive words that also appear in the other one (0..1). */
export function descriptionSimilarity(left: string | null | undefined, right: string | null | undefined) {
  const a = tokens(left); const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let shared = 0; for (const token of a) if (b.has(token)) shared++;
  return shared / Math.min(a.size, b.size);
}

export type TMDBCandidate = { id: number; name?: string | null; original_name?: string | null; overview?: string | null; first_air_date?: string | null };
export type ScheduleMatchRejection = 'no_library_overview' | 'no_exact_title' | 'weak_overview' | 'ambiguous' | 'already_linked';
export type ScheduleMatch = { tmdbId: number; firstAirDate: string | null } | { tmdbId: null; reason: ScheduleMatchRejection };

/** Minimum description agreement for a schedule-only match. Library overviews are normally copied from TMDB. */
export const SCHEDULE_MATCH_MIN_OVERVIEW = 0.8;

/**
 * Accept a TMDB candidate only when the title matches exactly (after normalisation), the stored library overview
 * strongly agrees with the candidate's overview, exactly one candidate qualifies, and that TMDB show is not already
 * linked to a different library entry. Anything less is rejected with a reason rather than guessed.
 */
export function chooseScheduleOnlyTMDBMatch(library: { name: string; overview?: string | null }, candidates: TMDBCandidate[], linkedTmdbIds: ReadonlySet<number>): ScheduleMatch {
  if (tokens(library.overview).size < 5) return { tmdbId: null, reason: 'no_library_overview' };
  const title = normalizeText(library.name);
  const titled = candidates.filter(c => [c.name, c.original_name].some(name => !!name && normalizeText(name) === title));
  if (!titled.length) return { tmdbId: null, reason: 'no_exact_title' };
  const corroborated = titled.filter(c => descriptionSimilarity(library.overview, c.overview) >= SCHEDULE_MATCH_MIN_OVERVIEW);
  if (!corroborated.length) return { tmdbId: null, reason: 'weak_overview' };
  if (corroborated.length > 1) return { tmdbId: null, reason: 'ambiguous' };
  if (linkedTmdbIds.has(corroborated[0].id)) return { tmdbId: null, reason: 'already_linked' };
  return { tmdbId: corroborated[0].id, firstAirDate: corroborated[0].first_air_date || null };
}
