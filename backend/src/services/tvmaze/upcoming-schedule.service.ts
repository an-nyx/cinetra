import axios from 'axios';

type TVMazeEpisode = { season: number | null; number: number | null; name: string; airdate: string | null; airstamp: string | null; runtime: number | null };
type TVMazeShow = { id: number; name: string; premiered: string | null; summary: string | null };
export type UpcomingIdentity = { tmdbName?: string | null; tmdbOriginalName?: string | null; tmdbOverview?: string | null; firstAirDate?: string | null; libraryName: string; libraryOverview?: string | null };
export type ScheduleEpisode = { season: number | null; number: number | null; name: string; airDate: string; airTimestamp: string | null; runtime: number | null; scheduleSource: 'TVMaze'; identityVerified: true };
export type TVMazeScheduleResult = { episodes: ScheduleEpisode[] | null; identityStatus: 'verified' | 'ambiguous' | 'not_found' | 'error' };

const client = axios.create({ baseURL: 'https://api.tvmaze.com', timeout: 5000 });
const cache = new Map<string, { until: number; value: Promise<TVMazeScheduleResult> }>();
const normalized = (value: string | null | undefined) => (value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/<[^>]*>/g, ' ').replace(/&[^;]+;/g, ' ').toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = (value: string | null | undefined) => new Set(normalized(value).split(/\s+/).filter(token => token.length > 2));
const descriptionSimilarity = (left: string | null | undefined, right: string | null | undefined) => {
  const a = tokens(left); const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let shared = 0; for (const token of a) if (b.has(token)) shared++;
  return shared / Math.min(a.size, b.size);
};

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
  const verified = titleMatches && !yearConflict && (yearAvailable ? overviewScore >= 0.12 : overviewScore >= 0.35);
  return { verified, titleMatches, yearMatches, overviewScore };
}

export function chooseVerifiedTVMazeMatch(identity: UpcomingIdentity, candidates: TVMazeShow[]) {
  const matches = candidates.filter(candidate => verifyTVMazeIdentity(identity, candidate).verified);
  return { show: matches.length === 1 ? matches[0] : null, status: matches.length === 1 ? 'verified' as const : matches.length > 1 ? 'ambiguous' as const : 'not_found' as const };
}

async function resolveShow(identity: UpcomingIdentity, existingId?: number | null): Promise<{ show: TVMazeShow | null; status: TVMazeScheduleResult['identityStatus'] }> {
  if (existingId) {
    const response = await client.get<TVMazeShow>(`/shows/${existingId}`);
    return verifyTVMazeIdentity(identity, response.data).verified ? { show: response.data, status: 'verified' } : { show: null, status: 'ambiguous' };
  }
  const query = identity.tmdbName || identity.tmdbOriginalName || identity.libraryName;
  const response = await client.get<Array<{ show: TVMazeShow }>>('/search/shows', { params: { q: query } });
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
      // TVMaze excludes specials from this list by default.
      const response = await client.get<TVMazeEpisode[]>(`/shows/${match.show.id}/episodes`);
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
  const ttl = result.identityStatus === 'error' ? 60_000 : 30 * 60_000;
  cache.set(key, { until: Date.now() + ttl, value });
  return result;
}
