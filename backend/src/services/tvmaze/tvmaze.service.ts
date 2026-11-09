/**
 * TVMaze client for Upcoming: identity lookups and per-show episode lists, rate-limited and cached in memory.
 * Nothing is persisted; TVMaze never writes TMDB associations, progress or watch records.
 */
import axios from 'axios';
import { SWRCache } from '../swr-cache';
import { chooseTitleCorroboratedMatch, decideExternalIdentity, type IdentityResult, type TitleEvidence, type TMDBExternalIds, type TVMazeEpisode, type TVMazeShow } from './tvmaze-schedule.model';

// Lookups answer with a redirect to /shows/:id; read the ID from it instead of paying for a second request.
const client = axios.create({ baseURL: 'https://api.tvmaze.com', timeout: 8000, maxRedirects: 0, validateStatus: status => (status >= 200 && status < 300) || status === 301 || status === 302 });

// TVMaze allows at least 20 calls per 10 seconds per IP; stay inside that window instead of triggering HTTP 429.
const WINDOW_MS = 10_000;
const WINDOW_CALLS = 18;
const recentCalls: number[] = [];
let requestCount = 0;
async function throttled<T>(request: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    for (;;) {
      const now = Date.now();
      while (recentCalls.length && now - recentCalls[0] >= WINDOW_MS) recentCalls.shift();
      if (recentCalls.length < WINDOW_CALLS) { recentCalls.push(now); break; }
      await new Promise(resolve => setTimeout(resolve, WINDOW_MS - (now - recentCalls[0]) + 5));
    }
    try { requestCount++; return await request(); }
    catch (error) {
      // A 429 means the window was shared with someone else: wait one window and try again, twice at most.
      if (axios.isAxiosError(error) && error.response?.status === 429 && attempt < 2) { await new Promise(resolve => setTimeout(resolve, WINDOW_MS)); continue; }
      throw error;
    }
  }
}
const isNotFound = (error: unknown) => axios.isAxiosError(error) && error.response?.status === 404;

type CachedSchedule = { show: TVMazeShow; episodes: TVMazeEpisode[]; fetchedAt: number };
// Episode lists: fresh for 12 hours, kept up to a week, and refreshed early when the TVMaze updates feed says the show changed.
const scheduleCache = new SWRCache<CachedSchedule>({ freshMs: 12 * 60 * 60_000, staleMs: 7 * 24 * 60 * 60_000, retryMs: 10 * 60_000, maxEntries: 3000 });
// Identities are stable: fresh for 3 days, kept up to 30. Transient failures are not cached as answers.
const identityCache = new SWRCache<IdentityResult>({ freshMs: 3 * 24 * 60 * 60_000, staleMs: 30 * 24 * 60 * 60_000, retryMs: 10 * 60_000, maxEntries: 3000 });
/** Shows whose latest refresh failed and are being served from an older copy. */
const failedRefresh = new Map<number, number>();

async function loadSchedule(tvmazeId: number): Promise<CachedSchedule> {
  try {
    // Show and episodes in one request. Specials are excluded by default.
    const response = await throttled(() => client.get<TVMazeShow & { _embedded?: { episodes?: TVMazeEpisode[] } }>(`/shows/${tvmazeId}`, { params: { embed: 'episodes' } }));
    const { _embedded, ...show } = response.data;
    const keepFrom = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    // Past episodes are kept only as far as rerun detection needs them (number and premiere date).
    const episodes = (_embedded?.episodes || []).map(e => !e.airdate || e.airdate >= keepFrom
      ? { id: e.id, season: e.season, number: e.number, type: e.type, name: e.name, airdate: e.airdate, airtime: e.airtime, airstamp: e.airstamp, runtime: e.runtime }
      : { id: e.id, season: e.season, number: e.number, type: e.type, airdate: e.airdate });
    failedRefresh.delete(tvmazeId);
    return {
      show: { id: show.id, name: show.name, premiered: show.premiered, status: show.status, updated: show.updated, externals: show.externals, network: show.network ? { name: show.network.name } : null, webChannel: show.webChannel ? { name: show.webChannel.name } : null },
      episodes, fetchedAt: Date.now(),
    };
  } catch (error) { failedRefresh.set(tvmazeId, Date.now()); throw error; }
}

/** Cached show + episode list. Rejects only when TVMaze fails and no earlier copy exists. */
export async function getSchedule(tvmazeId: number): Promise<CachedSchedule & { stale: boolean }> {
  const value = await scheduleCache.get(String(tvmazeId), () => loadSchedule(tvmazeId));
  return { ...value, stale: failedRefresh.has(tvmazeId) };
}

let lastUpdatesCheck = 0;
let updatesPending: Promise<void> | null = null;
/**
 * One request tells which TVMaze shows changed recently; only those are re-read. Checked at most every 30 minutes
 * (every 2 when the user asks to refresh). Failures are ignored: cached schedules then refresh on their own timer.
 */
export function checkForUpdates(minIntervalMs = 30 * 60_000) {
  if (updatesPending) return updatesPending;
  const since = Date.now() - lastUpdatesCheck;
  if (since < minIntervalMs) return Promise.resolve();
  updatesPending = (async () => {
    try {
      if (lastUpdatesCheck && since > 6 * 24 * 60 * 60_000) { lastUpdatesCheck = Date.now(); return; } // caches have turned over already
      const period = !lastUpdatesCheck || since > 20 * 60 * 60_000 ? 'week' : 'day';
      const response = await throttled(() => client.get<Record<string, number>>('/updates/shows', { params: { since: period } }));
      lastUpdatesCheck = Date.now();
      const changed = scheduleCache.keys().map(Number).filter(id => {
        const updated = response.data[String(id)];
        const cached = scheduleCache.peek(String(id));
        return !!updated && !!cached && (cached.show.updated ?? 0) < updated;
      });
      // Re-read changed shows now; if TVMaze fails, the previous copy stays in place (and is marked stale).
      await Promise.all(changed.map(id => scheduleCache.refresh(String(id), () => loadSchedule(id)).catch(() => null)));
    } catch { /* keep cached schedules */ }
    finally { updatesPending = null; }
  })();
  return updatesPending;
}

async function lookupId(kind: 'thetvdb' | 'imdb', value: string | number): Promise<number | null> {
  try {
    const response = await throttled(() => client.get('/lookup/shows', { params: { [kind]: value } }));
    if (response.status === 301 || response.status === 302) {
      const match = /\/shows\/(\d+)/.exec(String(response.headers.location || ''));
      return match ? Number(match[1]) : null;
    }
    const data = response.data as { id?: number } | null;
    return data?.id ?? null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export type IdentityInput = { tmdbId: number; externalIds: () => Promise<TMDBExternalIds>; evidence: () => Promise<TitleEvidence> };

/** Resolve a TMDB series to a TVMaze show: external IDs first, then the strict title fallback. Cached per TMDB ID. */
export function resolveIdentity(input: IdentityInput): Promise<IdentityResult> {
  return identityCache.get(`tmdb:${input.tmdbId}`, async () => {
    const ext = await input.externalIds();
    let id: number | null = null;
    if (ext.tvdbId) id = await lookupId('thetvdb', ext.tvdbId);
    if (!id && ext.imdbId) id = await lookupId('imdb', ext.imdbId);
    if (id) {
      // The lookup's record (with its own externals) is the episode list we need anyway.
      const { show } = await getSchedule(id);
      return decideExternalIdentity(ext, [show])!;
    }
    const evidence = await input.evidence();
    const query = evidence.names.find(Boolean);
    if (!query) return { status: 'unresolved', reason: 'not_on_tvmaze' };
    const response = await throttled(() => client.get<Array<{ show: TVMazeShow }>>('/search/shows', { params: { q: query } }));
    return chooseTitleCorroboratedMatch(evidence, (response.data || []).map(result => result.show), ext);
  });
}

export function tvmazeCacheStats() {
  return { identities: identityCache.size, schedules: scheduleCache.size, staleSchedules: failedRefresh.size, requests: requestCount, lastUpdatesCheck: lastUpdatesCheck ? new Date(lastUpdatesCheck).toISOString() : null };
}
