/**
 * TVMaze schedule rules (pure, no network).
 *
 * TVMaze is Cinetra's only source of upcoming episode dates. TMDB remains the canonical identity and tracking
 * provider: a saved show is matched to TVMaze through the external identifiers TMDB publishes for it (TheTVDB, IMDb),
 * and only when TMDB has none, or TVMaze does not index them, through strict title + premiere + synopsis evidence.
 * Nothing here is persisted and nothing here touches watch progress.
 */
import { descriptionSimilarity, normalizeText } from '../schedule-identity';

export type TVMazeExternals = { tvrage?: number | null; thetvdb?: number | null; imdb?: string | null };
export type TVMazeEpisode = {
  id: number; season: number | null; number: number | null; type?: string | null; name?: string | null;
  airdate?: string | null; airtime?: string | null; airstamp?: string | null; runtime?: number | null;
};
export type TVMazeShow = {
  id: number; name: string; premiered?: string | null; summary?: string | null; status?: string | null; updated?: number | null;
  externals?: TVMazeExternals | null; network?: { name?: string | null } | null; webChannel?: { name?: string | null } | null;
};
/** External identifiers TMDB publishes for a series. */
export type TMDBExternalIds = { tvdbId: number | null; imdbId: string | null };

export type IdentityMethod = 'external_id' | 'title_corroborated';
export type IdentityFailure = 'no_tmdb_identity' | 'not_on_tvmaze' | 'external_id_conflict' | 'ambiguous' | 'weak_evidence' | 'shared_tvmaze_identity' | 'stored_tvmaze_conflict';
export type IdentityResult =
  | { status: 'verified'; tvmazeId: number; method: IdentityMethod }
  | { status: 'unresolved'; reason: IdentityFailure };

export const IDENTITY_FAILURE_TEXT: Record<IdentityFailure, string> = {
  no_tmdb_identity: 'Not linked to TMDB, so there is no reliable identity to look up on TVMaze.',
  not_on_tvmaze: 'TVMaze has no show with the TheTVDB or IMDb ID TMDB lists for this series, and no title match could be verified.',
  external_id_conflict: 'TVMaze and TMDB disagree on this series’ TheTVDB or IMDb ID.',
  ambiguous: 'Several TVMaze shows fit equally well; none was chosen.',
  weak_evidence: 'A TVMaze show has the same title, but its premiere date and description do not confirm it is the same series.',
  shared_tvmaze_identity: 'Another show in your library resolves to the same TVMaze series.',
  stored_tvmaze_conflict: 'The saved TVMaze link disagrees with the series TMDB identifies.',
};

const sameImdb = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** True when a TVMaze record carries a TheTVDB or IMDb ID that contradicts TMDB's. Missing IDs are not a contradiction. */
export function externalsConflict(candidate: Pick<TVMazeShow, 'externals'>, ext: TMDBExternalIds) {
  const tvdb = candidate.externals?.thetvdb ?? null;
  const imdb = candidate.externals?.imdb ?? null;
  return (!!ext.tvdbId && !!tvdb && tvdb !== ext.tvdbId) || (!!ext.imdbId && !!imdb && !sameImdb(imdb, ext.imdbId));
}

/**
 * Decide identity from external-ID lookups. `found` holds the TVMaze shows that the TheTVDB and/or IMDb lookups
 * returned (already fetched, with their externals). Returns null when no lookup found anything, so a caller may try
 * the strict title fallback; never guesses between different results.
 */
export function decideExternalIdentity(ext: TMDBExternalIds, found: TVMazeShow[]): IdentityResult | null {
  if (!found.length) return null;
  const ids = new Set(found.map(show => show.id));
  if (ids.size > 1) return { status: 'unresolved', reason: 'external_id_conflict' };
  if (found.some(show => externalsConflict(show, ext))) return { status: 'unresolved', reason: 'external_id_conflict' };
  return { status: 'verified', tvmazeId: found[0].id, method: 'external_id' };
}

export type TitleEvidence = { names: Array<string | null | undefined>; firstAirDate: string | null; overview: string | null };
const dayDistance = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
/** Minimum synopsis agreement when the premiere date only matches by year. */
export const TITLE_FALLBACK_MIN_OVERVIEW = 0.35;

/**
 * Fallback when external IDs cannot be used. Requires an exact (normalised) title, the same premiere year as TMDB,
 * no contradicting external ID, and either the same premiere date (±1 day for time zones) or strong synopsis
 * agreement. Exactly one candidate must qualify. A same-title remake or adaptation from another year never passes.
 */
export function chooseTitleCorroboratedMatch(evidence: TitleEvidence, candidates: TVMazeShow[], ext: TMDBExternalIds): IdentityResult {
  const names = new Set(evidence.names.filter((name): name is string => !!name).map(normalizeText).filter(Boolean));
  const titled = candidates.filter(candidate => names.has(normalizeText(candidate.name)));
  if (!titled.length) return { status: 'unresolved', reason: 'not_on_tvmaze' };
  const first = evidence.firstAirDate && /^\d{4}-\d{2}-\d{2}/.test(evidence.firstAirDate) ? evidence.firstAirDate.slice(0, 10) : null;
  if (!first) return { status: 'unresolved', reason: 'weak_evidence' };
  const qualified = titled.filter(candidate => {
    const premiered = candidate.premiered && /^\d{4}-\d{2}-\d{2}/.test(candidate.premiered) ? candidate.premiered.slice(0, 10) : null;
    if (!premiered || premiered.slice(0, 4) !== first.slice(0, 4) || externalsConflict(candidate, ext)) return false;
    return dayDistance(premiered, first) <= 1 || descriptionSimilarity(evidence.overview, candidate.summary) >= TITLE_FALLBACK_MIN_OVERVIEW;
  });
  const unique = [...new Map(qualified.map(candidate => [candidate.id, candidate])).values()];
  if (!unique.length) return { status: 'unresolved', reason: 'weak_evidence' };
  if (unique.length > 1) return { status: 'unresolved', reason: 'ambiguous' };
  return { status: 'verified', tvmazeId: unique[0].id, method: 'title_corroborated' };
}

export type ScheduledEpisode = {
  episodeId: number; season: number; number: number; name: string; airDate: string;
  /** Network-local "HH:MM" exactly as TVMaze lists it; null when TVMaze gives a date only. */
  airTime: string | null;
  /** UTC instant, only when TVMaze confirms an air time. Date-only releases never get an invented time. */
  airTimestamp: string | null;
  runtime: number | null; seasonPremiere: boolean;
};
export type EpisodeExclusions = { specials: number; past: number; undated: number; duplicates: number; repeats: number };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Pick genuinely new, dated, regular episodes from a show's TVMaze episode list.
 *
 * The per-show episode list holds each episode once, dated by its original premiere; broadcast schedule feeds (which
 * also list reruns and syndicated repeats) are never read. On top of that:
 * - the same TVMaze episode ID is used once (duplicate responses or records);
 * - a second record for an already-listed season/episode number is a repeat, and the earliest premiere wins, so a
 *   rebroadcast of an episode that already premiered never appears as new;
 * - specials, unnumbered records and undated announcements are left out (undated ones are counted for "Date TBA");
 * - anything dated before `cutoff` (YYYY-MM-DD) has already premiered.
 */
export function selectScheduledEpisodes(episodes: TVMazeEpisode[], cutoff: string): { episodes: ScheduledEpisode[]; excluded: EpisodeExclusions } {
  const excluded: EpisodeExclusions = { specials: 0, past: 0, undated: 0, duplicates: 0, repeats: 0 };
  const ordered = [...episodes].sort((a, b) => (a.airdate && DATE.test(a.airdate) ? a.airdate : '9999-99-99').localeCompare(b.airdate && DATE.test(b.airdate) ? b.airdate : '9999-99-99') || a.id - b.id);
  const seenIds = new Set<number>();
  const seenNumbers = new Set<string>();
  const selected: ScheduledEpisode[] = [];
  for (const episode of ordered) {
    if (seenIds.has(episode.id)) { excluded.duplicates++; continue; }
    seenIds.add(episode.id);
    const season = episode.season ?? 0;
    const number = episode.number ?? 0;
    if ((episode.type && episode.type !== 'regular') || !Number.isInteger(season) || season < 1 || !Number.isInteger(number) || number < 1) { excluded.specials++; continue; }
    const numberKey = `${season}:${number}`;
    const repeat = seenNumbers.has(numberKey);
    seenNumbers.add(numberKey);
    if (!episode.airdate || !DATE.test(episode.airdate)) { if (repeat) excluded.repeats++; else excluded.undated++; continue; }
    if (repeat) { excluded.repeats++; continue; }
    if (episode.airdate < cutoff) { excluded.past++; continue; }
    const timed = !!episode.airtime && TIME.test(episode.airtime) && !!episode.airstamp && !Number.isNaN(Date.parse(episode.airstamp));
    selected.push({
      episodeId: episode.id, season, number, name: (episode.name || '').trim(), airDate: episode.airdate,
      airTime: timed ? episode.airtime! : null, airTimestamp: timed ? new Date(episode.airstamp!).toISOString() : null,
      runtime: episode.runtime && episode.runtime > 0 ? episode.runtime : null, seasonPremiere: number === 1,
    });
  }
  return { episodes: selected, excluded };
}

/** TVMaze statuses that mean more episodes are expected. "Ended" never does. */
export const CONTINUING_TVMAZE_STATUSES = ['Running', 'To Be Determined', 'In Development'];
export const isReturningWithoutDate = (tvmazeStatus: string | null | undefined, datedEpisodes: number) =>
  datedEpisodes === 0 && CONTINUING_TVMAZE_STATUSES.includes(tvmazeStatus || '');

/** A web channel (Netflix, Prime Video, …) without a broadcast network is a streaming release. */
export const channelOf = (show: Pick<TVMazeShow, 'network' | 'webChannel'>) => ({
  channel: show.network?.name || show.webChannel?.name || null,
  streaming: !show.network?.name && !!show.webChannel?.name,
});
