import axios from 'axios';
import { descriptionSimilarity, normalizeText as normalized, SCHEDULE_MATCH_MIN_OVERVIEW } from '../schedule-identity';

type TVMazeEpisode = { season: number | null; number: number | null; name: string; airdate: string | null; airstamp: string | null; runtime: number | null };
type TVMazeShow = { id: number; name: string; premiered: string | null; summary: string | null; status?: string | null; _links?: { nextepisode?: { href?: string } } };
export type UpcomingIdentity = { tmdbName?: string | null; tmdbOriginalName?: string | null; tmdbOverview?: string | null; firstAirDate?: string | null; libraryName: string; libraryOverview?: string | null };
export type ScheduleEpisode = { season: number | null; number: number | null; name: string; airDate: string; airTimestamp: string | null; runtime: number | null; scheduleSource: 'TVMaze'; identityVerified: true };
export type TVMazeScheduleResult = { episodes: ScheduleEpisode[] | null; identityStatus: 'verified' | 'ambiguous' | 'not_found' | 'error' };

const client = axios.create({ baseURL: 'https://api.tvmaze.com', timeout: 5000 });
const cache = new Map<string, { until: number; value: Promise<TVMazeScheduleResult> }>();

// TVMaze allows at least 20 calls per 10 seconds per IP; stay inside that window instead of triggering HTTP 429.
const WINDOW_MS = 10_000;
const WINDOW_CALLS = 18;
const recentCalls: number[] = [];
async function throttled<T>(request: () => Promise<T>): Promise<T> {
  for (;;) {
    const now = Date.now();
    while (recentCalls.length && now - recentCalls[0] >= WINDOW_MS) recentCalls.shift();
    if (recentCalls.length < WINDOW_CALLS) { recentCalls.push(now); return request(); }
    await new Promise(resolve => setTimeout(resolve, WINDOW_MS - (now - recentCalls[0]) + 5));
  }
}

/** A matched show TVMaze reports as Ended with no next episode cannot add schedule entries; skip its episode list. */
export const tvmazeMayHaveUpcoming = (show: Pick<TVMazeShow, 'status' | '_links'>) => show.status !== 'Ended' || !!show._links?.nextepisode?.href;

export function verifyTVMazeIdentity(identity: UpcomingIdentity, candidate: TVMazeShow) {
  const candidateName = normalized(candidate.name);
  const titleMatches = [identity.libraryName, identity.tmdbName, identity.tmdbOriginalName].some(name => !!name && normalized(name) === candidateName);
  const expectedYear = identity.firstAirDate?.slice(0, 4);
  const actualYear = candidate.premiered?.slice(0, 4);
  const yearMatches = !!expectedYear && !!actualYear && expectedYear === actualYear;
  const descriptions = [identity.tmdbOverview, identity.libraryOverview].filter(Boolean);
  const overviewScore = Math.max(0, ...descriptions.map(description => descriptionSimilarity(description, candidate.summary)));
  // Title is mandatory. Require a matching premiere year and synopsis evidence
  // (or a strong synopsis match when a year is unavailable) so title-only results
  // and same-title remakes never become schedule sources.
  const yearAvailable = !!expectedYear && !!actualYear;
  const yearConflict = yearAvailable && !yearMatches;
  // Without any TMDB identity to corroborate, the stored library description must agree as strongly as a TMDB
  // schedule-only match requires; the fallback is never looser than the primary rule.
  const libraryOnly = !identity.tmdbName && !identity.tmdbOriginalName && !identity.tmdbOverview;
  const verified = titleMatches && !yearConflict && (libraryOnly ? overviewScore >= SCHEDULE_MATCH_MIN_OVERVIEW : yearAvailable ? overviewScore >= 0.12 : overviewScore >= 0.35);
  return { verified, titleMatches, yearMatches, overviewScore };
}

export function chooseVerifiedTVMazeMatch(identity: UpcomingIdentity, candidates: TVMazeShow[]) {
  const matches = candidates.filter(candidate => verifyTVMazeIdentity(identity, candidate).verified);
  return { show: matches.length === 1 ? matches[0] : null, status: matches.length === 1 ? 'verified' as const : matches.length > 1 ? 'ambiguous' as const : 'not_found' as const };
}

async function resolveShow(identity: UpcomingIdentity, existingId?: number | null): Promise<{ show: TVMazeShow | null; status: TVMazeScheduleResult['identityStatus'] }> {
  if (existingId) {
    const response = await throttled(() => client.get<TVMazeShow>(`/shows/${existingId}`));
    return verifyTVMazeIdentity(identity, response.data).verified ? { show: response.data, status: 'verified' } : { show: null, status: 'ambiguous' };
  }
  const query = identity.tmdbName || identity.tmdbOriginalName || identity.libraryName;
  const response = await throttled(() => client.get<Array<{ show: TVMazeShow }>>('/search/shows', { params: { q: query } }));
  // Never choose among multiple provider records that satisfy the evidence.
  return chooseVerifiedTVMazeMatch(identity, response.data.map(result => result.show));
}

export async function getVerifiedTVMazeSchedule(identity: UpcomingIdentity, existingId?: number | null, today = new Date().toISOString().slice(0, 10)): Promise<TVMazeScheduleResult> {
  const identityText = normalized([identity.libraryName, identity.tmdbName, identity.tmdbOriginalName, identity.firstAirDate, identity.tmdbOverview, identity.libraryOverview].join('|'));
  const identityHash = [...identityText].reduce((hash, character) => Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0, 2166136261).toString(36);
  const key = `${existingId || 'search'}:${today}:${identityHash}`;
  const cached = cache.get(key);
  if (cached && cached.until > Date.now()) return cached.value;
  const value = (async () => {
    try {
      const match = await resolveShow(identity, existingId);
      if (!match.show) return { episodes: null, identityStatus: match.status } as TVMazeScheduleResult;
      if (!tvmazeMayHaveUpcoming(match.show)) return { episodes: [], identityStatus: 'verified' } as TVMazeScheduleResult;
      // TVMaze excludes specials from this list by default.
      const response = await throttled(() => client.get<TVMazeEpisode[]>(`/shows/${match.show!.id}/episodes`));
      const episodes = response.data.filter(episode => !!episode.airdate && episode.airdate >= today).map(episode => ({
        // TVMaze numbering is schedule metadata only. Callers map it to canonical
        // TMDB numbering only after an independent exact episode match.
        season: episode.season && episode.season > 0 ? episode.season : null,
        number: episode.number && episode.number > 0 ? episode.number : null,
        name: episode.name || '', airDate: episode.airdate!, airTimestamp: episode.airstamp || null, runtime: episode.runtime || null,
        scheduleSource: 'TVMaze' as const, identityVerified: true as const,
      }));
      return { episodes, identityStatus: 'verified' } as TVMazeScheduleResult;
    } catch {
      return { episodes: null, identityStatus: 'error' } as TVMazeScheduleResult;
    }
  })();
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  cache.set(key, { until: Date.now() + 60_000, value });
  const result = await value;
  // Identity outcomes are stable; schedules are re-read every few hours. Errors are retried after a minute.
  const ttl = result.identityStatus === 'error' ? 60_000 : 3 * 60 * 60_000;
  cache.set(key, { until: Date.now() + ttl, value });
  return result;
}
