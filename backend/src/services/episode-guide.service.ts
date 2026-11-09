import { prisma } from '../database/prisma';
import axios from 'axios';
import { TMDBApiService } from './tmdb/tmdb-api.service';
import { type EpisodeMetadata } from './legacy-progress.model';
import { buildTrackingSummary, catalogFromTMDB, checkpointAfterWatch, mergeShowEpisodes, type Catalog, type Checkpoint, type MetadataFailure } from './tracking-summary.model';
import { TMDB_AUTH_CONFIGURATION_ERROR } from './tmdb/tmdb-auth';
import { checkForUpdates, getSchedule, resolveIdentity, tvmazeCacheStats } from './tvmaze/tvmaze.service';
import { selectScheduledEpisodes } from './tvmaze/tvmaze-schedule.model';
import { assembleUpcoming, type ShowOutcome, type UpcomingResponse } from './upcoming-schedule.model';
import { chooseScheduleOnlyTMDBMatch, type ScheduleMatch } from './schedule-identity';
import { mapLimit, SWRCache } from './swr-cache';
import { analyzeRematchProgress, summarizeSeries } from './rematch.model';

const tmdb = new TMDBApiService();
const today = () => new Date().toISOString().slice(0, 10);
type Episode = EpisodeMetadata & { name: string; airTimestamp: string | null; runtime: number | null; watchedAt: Date | null; episodeType?: string | null; watched: boolean; watchSource: 'explicit' | 'legacy' | 'both' | null };
// Catalogs: fresh for 1 hour, then served stale (up to 24 hours) while one background refresh runs.
const catalogCache = new SWRCache<Catalog>({ freshMs: 60 * 60_000, staleMs: 24 * 60 * 60_000, retryMs: 5 * 60_000 });
// Upcoming per user: fresh for 5 minutes, then served stale (up to 6 hours) while it rebuilds in the background.
const upcomingCache = new SWRCache<UpcomingResponse>({ freshMs: 5 * 60_000, staleMs: 6 * 60 * 60_000, retryMs: 60_000, maxEntries: 200 });

export class EpisodeGuideError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const validNumber = (value: unknown, minimum: number) => typeof value === 'number' && Number.isInteger(value) && value >= minimum;

async function catalogFor(show: { name: string; tmdbId: number | null }): Promise<Catalog> {
  if (!show.tmdbId) throw new EpisodeGuideError(404, 'TMDB match required to load episode metadata');
  const tmdbId = show.tmdbId;
  return catalogCache.get(`tmdb:${tmdbId}`, async () => {
    const details = await tmdb.getShow(tmdbId);
    const numbers = (details.seasons || []).filter(s => s.season_number > 0).map(s => s.season_number);
    // A page that fails for a season that has not aired yet must not break released progress (see catalogFromTMDB).
    const settled = await Promise.allSettled(numbers.map(n => tmdb.getSeason(tmdbId, n)));
    return catalogFromTMDB(details, settled.map((r, i) => ({ season: numbers[i], data: r.status === 'fulfilled' ? r.value : null })), today());
  });
}

async function load(showId: string, userId: string) {
  const show = await prisma.show.findFirst({ where: { id: showId, userId } });
  if (!show) throw new EpisodeGuideError(404, 'Show not found');
  const [catalog, watches] = await Promise.all([catalogFor(show), prisma.episodeWatch.findMany({ where: { showId }, select: { season: true, episode: true, watchedAt: true } })]);
  const { legacy, episodes } = mergeShowEpisodes(show, catalog, watches, today());
  return { show, catalog, episodes, watches, legacy };
}

/** Distinguish a missing association from authentication, not-found and transient TMDB failures. */
export function classifyMetadataFailure(error: unknown): MetadataFailure {
  if (error instanceof EpisodeGuideError && error.status === 404) return 'no_tmdb_association';
  if (error instanceof Error && error.message === TMDB_AUTH_CONFIGURATION_ERROR) return 'tmdb_auth_failed';
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  if (status === 401 || status === 403) return 'tmdb_auth_failed';
  if (status === 404) return 'tmdb_not_found';
  return 'tmdb_unavailable';
}

type ShowRow = NonNullable<Awaited<ReturnType<typeof prisma.show.findFirst>>>;
async function summarize(show: ShowRow, watches: { season: number; episode: number; watchedAt: Date }[]) {
  let catalog: Catalog | null = null;
  let metadataError: string | null = null;
  let metadataFailure: MetadataFailure | null = null;
  try { catalog = await catalogFor(show); } catch (error) {
    // Saved positions remain available without a provider; the cause is classified so pages can explain it.
    metadataError = error instanceof Error ? error.message : 'TMDB metadata unavailable';
    metadataFailure = classifyMetadataFailure(error);
  }
  return buildTrackingSummary(show, catalog, metadataError, watches, today(), metadataFailure);
}

export async function getTrackingSummary(showId: string, userId: string) {
  const show = await prisma.show.findFirst({ where: { id: showId, userId } });
  if (!show) throw new EpisodeGuideError(404, 'Show not found');
  const watches = await prisma.episodeWatch.findMany({ where: { showId }, select: { season: true, episode: true, watchedAt: true } });
  return summarize(show, watches);
}

/** Every show's summary: two database queries for the whole library, and at most 12 catalogs loading at once. */
export async function getLibraryTracking(userId: string) {
  const [shows, watches] = await Promise.all([
    prisma.show.findMany({ where: { userId } }),
    prisma.episodeWatch.findMany({ where: { show: { userId } }, select: { showId: true, season: true, episode: true, watchedAt: true } }),
  ]);
  const byShow = new Map<string, { season: number; episode: number; watchedAt: Date }[]>();
  for (const w of watches) byShow.set(w.showId, [...(byShow.get(w.showId) || []), { season: w.season, episode: w.episode, watchedAt: w.watchedAt }]);
  return mapLimit(shows, 12, async show => {
    try { return { ...(await summarize(show, byShow.get(show.id) || [])), error: null }; }
    catch (error) { return { showId: show.id, error: error instanceof Error ? error.message : 'Episode guide unavailable' }; }
  });
}

const scheduleMatchCache = new Map<string, { until: number; value: Promise<ScheduleMatch | { tmdbId: null; reason: 'search_failed' }> }>();
/** Schedule-only TMDB identity for a show without a stored association. Cached; never persisted. */
function scheduleOnlyTMDBMatch(show: { id: string; name: string; overview: string | null }, linkedTmdbIds: ReadonlySet<number>) {
  const key = `${show.id}:${show.name}:${show.overview || ''}:${[...linkedTmdbIds].sort().join(',')}`;
  const cached = scheduleMatchCache.get(key);
  if (cached && cached.until > Date.now()) return cached.value;
  const value = tmdb.searchTVCandidates(show.name)
    .then(candidates => chooseScheduleOnlyTMDBMatch(show, candidates, linkedTmdbIds))
    .catch(() => { scheduleMatchCache.set(key, { until: Date.now() + 60_000, value }); return { tmdbId: null, reason: 'search_failed' as const }; });
  if (scheduleMatchCache.size > 1000) scheduleMatchCache.delete(scheduleMatchCache.keys().next().value!);
  scheduleMatchCache.set(key, { until: Date.now() + 12 * 60 * 60_000, value });
  return value;
}

/** Where an error came from, so Upcoming can say which provider was unreachable. */
const providerOf = (error: unknown): 'TMDB' | 'TVMaze' => axios.isAxiosError(error) && String(error.config?.baseURL || '').includes('tvmaze') ? 'TVMaze' : 'TMDB';

type UpcomingShowRow = { id: string; name: string; overview: string | null; posterURL: string | null; status: string | null; completed: boolean; tmdbId: number | null; tvmazeId: number | null };
/**
 * One show's TVMaze-only schedule. Identity: the stored TMDB association (or a strictly corroborated schedule-only
 * TMDB match, never stored) gives TheTVDB/IMDb IDs, which select the TVMaze series. Anything unverifiable is
 * returned for review and contributes no dates. TMDB dates are never used here.
 */
async function upcomingOutcome(show: UpcomingShowRow, linkedTmdbIds: ReadonlySet<number>, cutoff: string): Promise<ShowOutcome> {
  const library = { id: show.id, name: show.name, posterURL: show.posterURL, status: show.status || (show.completed ? 'completed' : null) };
  let tmdbId = show.tmdbId;
  let tmdbBasis: 'linked' | 'schedule_match' = 'linked';
  if (!tmdbId) {
    const match = await scheduleOnlyTMDBMatch(show, linkedTmdbIds);
    if (match.tmdbId === null) return match.reason === 'search_failed' ? { kind: 'unavailable', show: library, provider: 'TMDB' } : { kind: 'review', show: library, reason: 'no_tmdb_identity' };
    tmdbId = match.tmdbId; tmdbBasis = 'schedule_match';
  }
  const seriesId = tmdbId;
  let identity: Awaited<ReturnType<typeof resolveIdentity>>;
  try {
    identity = await resolveIdentity({
      tmdbId: seriesId,
      externalIds: () => tmdb.getExternalIds(seriesId),
      evidence: async () => {
        const details = await tmdb.getShow(seriesId);
        return { names: [details.name, details.original_name, show.name], firstAirDate: details.first_air_date || null, overview: details.overview || show.overview || null };
      },
    });
  } catch (error) { return { kind: 'unavailable', show: library, provider: providerOf(error) }; }
  if (identity.status !== 'verified') return { kind: 'review', show: library, reason: identity.reason };
  if (show.tvmazeId && show.tvmazeId !== identity.tvmazeId) return { kind: 'review', show: library, reason: 'stored_tvmaze_conflict' };
  try {
    const schedule = await getSchedule(identity.tvmazeId);
    const { episodes, excluded } = selectScheduledEpisodes(schedule.episodes, cutoff);
    return { kind: 'scheduled', show: library, tvmaze: schedule.show, method: identity.method, tmdbBasis, episodes, excluded, stale: schedule.stale };
  } catch { return { kind: 'unavailable', show: library, provider: 'TVMaze' }; }
}

async function buildUpcomingReleases(userId: string, progress: { done: number; total: number }, force: boolean) {
  const shows = await prisma.show.findMany({ where: { userId }, select: { id: true, name: true, overview: true, posterURL: true, status: true, completed: true, tmdbId: true, tvmazeId: true } });
  progress.total = shows.length;
  const linkedTmdbIds = new Set(shows.flatMap(show => (show.tmdbId ? [show.tmdbId] : [])));
  // The earliest calendar day that is still "today" somewhere; pages drop what is before the viewer's own today.
  const cutoff = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await checkForUpdates(force ? 2 * 60_000 : 30 * 60_000);
  const outcomes = await mapLimit(shows, 8, async show => { try { return await upcomingOutcome(show, linkedTmdbIds, cutoff); } finally { progress.done++; } });
  return assembleUpcoming(outcomes, new Date().toISOString());
}

const buildProgress = new Map<string, { done: number; total: number }>();
const lastForcedRefresh = new Map<string, number>();
function upcomingFor(userId: string, force = false) {
  const load = () => {
    const progress = { done: 0, total: 0 };
    buildProgress.set(userId, progress);
    return buildUpcomingReleases(userId, progress, force);
  };
  return force ? upcomingCache.refresh(userId, load) : upcomingCache.get(userId, load);
}

/** How long a request waits for a first (cold) build before answering "building" with progress. */
const BUILD_WAIT_MS = 12_000;
/**
 * The user's TVMaze schedule. Cached per user (stale-while-revalidate). `refresh` rebuilds now (at most every 30
 * seconds) and re-checks TVMaze's updates feed; a cold build that takes longer than a few seconds answers
 * `{ status: 'building' }` so pages never hang, and finishes in the background.
 */
export async function getUpcomingReleases(userId: string, options: { refresh?: boolean } = {}): Promise<UpcomingResponse | { status: 'building'; progress: { done: number; total: number } }> {
  const force = !!options.refresh && Date.now() - (lastForcedRefresh.get(userId) || 0) > 30_000;
  if (force) lastForcedRefresh.set(userId, Date.now());
  const pending = upcomingFor(userId, force);
  pending.catch(() => { /* reported to the waiting request, or retried on the next one */ });
  let timer: NodeJS.Timeout | undefined;
  const waited = await Promise.race([pending, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), BUILD_WAIT_MS); })]).finally(() => clearTimeout(timer));
  if (waited) return waited;
  const previous = upcomingCache.peek(userId);
  if (previous) return previous; // a slow forced refresh: keep showing the last schedule
  return { status: 'building', progress: { ...(buildProgress.get(userId) || { done: 0, total: 0 }) } };
}

/** The library changed (show added, removed or re-linked): the next request gets the current list and rebuilds it. */
export function invalidateUpcoming(userId: string) {
  upcomingCache.delete(userId);
}

let warmup: { state: 'idle' | 'running' | 'done' | 'failed'; startedAt?: string; finishedAt?: string; catalogs?: number; users?: number } = { state: 'idle' };
/**
 * Fill the caches in the background after the server starts, so the first visitor after a deploy does not wait for
 * hundreds of TMDB requests and rate-limited TVMaze lookups. Read-only; failures are logged and ignored.
 */
export async function warmCaches() {
  if (warmup.state === 'running') return;
  warmup = { state: 'running', startedAt: new Date().toISOString() };
  try {
    const linked = await prisma.show.findMany({ where: { tmdbId: { not: null } }, select: { name: true, tmdbId: true }, distinct: ['tmdbId'] });
    // Upcoming no longer reads TMDB catalogs, so both warm in parallel (TVMaze is rate-limited on its own).
    const catalogs = mapLimit(linked, 6, show => catalogFor(show).catch(() => null));
    const users = await prisma.show.findMany({ select: { userId: true }, distinct: ['userId'] });
    for (const { userId } of users) await upcomingFor(userId).catch(() => null);
    await catalogs;
    warmup = { ...warmup, state: 'done', finishedAt: new Date().toISOString(), catalogs: catalogCache.size, users: users.length };
  } catch {
    warmup = { ...warmup, state: 'failed', finishedAt: new Date().toISOString() };
  }
  console.log(`Cache warm-up ${warmup.state}: ${warmup.catalogs ?? 0} catalogs, ${warmup.users ?? 0} users`);
}

/** Public, non-sensitive health: whether TMDB authentication works and whether caches are warm. No user data. */
const tmdbHealthCache = new SWRCache<{ status: 'ok' | 'auth_failed' | 'not_configured' | 'unavailable'; httpStatus: number | null; checkedAt: string }>({ freshMs: 5 * 60_000, staleMs: 5 * 60_000 });
export async function getHealth() {
  const tmdbHealth = await tmdbHealthCache.get('tmdb', async () => {
    try { await tmdb.ping(); return { status: 'ok' as const, httpStatus: 200, checkedAt: new Date().toISOString() }; }
    catch (error) {
      const failure = classifyMetadataFailure(error);
      const httpStatus = axios.isAxiosError(error) ? error.response?.status ?? null : null;
      const notConfigured = error instanceof Error && error.message === TMDB_AUTH_CONFIGURATION_ERROR;
      return { status: notConfigured ? 'not_configured' as const : failure === 'tmdb_auth_failed' ? 'auth_failed' as const : 'unavailable' as const, httpStatus, checkedAt: new Date().toISOString() };
    }
  });
  // Schedule match totals across libraries (counts only; no titles or user data).
  const built = upcomingCache.keys().flatMap(key => { const value = upcomingCache.peek(key); return value ? [value] : []; });
  const sum = (pick: (c: UpcomingResponse['coverage']) => number) => built.reduce((n, v) => n + pick(v.coverage), 0);
  const schedule = { source: 'TVMaze', evaluatedShows: sum(c => c.evaluatedShows), verifiedShows: sum(c => c.verifiedShows), verifiedByExternalId: sum(c => c.verifiedByExternalId), verifiedByTitle: sum(c => c.verifiedByTitle), needsReview: sum(c => c.unresolvedShows), unavailable: sum(c => c.unavailableShows), stale: built.some(v => v.stale) };
  return { tmdb: tmdbHealth, schedule, caches: { catalogs: catalogCache.size, upcomingUsers: upcomingCache.size, tvmaze: tvmazeCacheStats(), warmup } };
}

export async function getEpisodeGuide(showId: string, userId: string, season: number) {
  if (!validNumber(season, 1)) throw new EpisodeGuideError(400, 'Invalid season');
  const { catalog, episodes, watches } = await load(showId, userId);
  if (!catalog.seasons.some(s => s.number === season)) throw new EpisodeGuideError(404, 'Season not found');
  return { seasons: catalog.seasons, season, episodes: episodes.filter(e => e.season === season), watched: watches };
}

/** Move the saved checkpoint only if it is still what was read; a concurrent edit is never overwritten. */
async function moveCheckpoint(tx: Pick<typeof prisma, 'show'>, show: { id: string; seasonsWatched: number; episodesWatched: number }, to: Checkpoint) {
  await tx.show.updateMany({ where: { id: show.id, seasonsWatched: show.seasonsWatched, episodesWatched: show.episodesWatched }, data: to });
}

export async function setEpisodeWatched(showId: string, userId: string, season: number, episode: number, watched: boolean) {
  if (!validNumber(season, 1) || !validNumber(episode, 1) || typeof watched !== 'boolean') throw new EpisodeGuideError(400, 'Invalid episode update');
  const { catalog } = await load(showId, userId);
  const found = catalog.episodes.find(e => e.season === season && e.number === episode);
  if (!found) throw new EpisodeGuideError(404, 'Episode not found');
  if (watched && (!found.airDate || found.airDate > today())) throw new EpisodeGuideError(400, 'Episode has not aired');
  await prisma.$transaction(async tx => {
    // Serialize episode changes with saved-position edits for this show.
    await tx.$queryRaw`SELECT id FROM "Show" WHERE id = ${showId} AND "userId" = ${userId} FOR UPDATE`;
    const show = await tx.show.findFirst({ where: { id: showId, userId } });
    if (!show) throw new EpisodeGuideError(404, 'Show not found');
    const watches = await tx.episodeWatch.findMany({ where: { showId } });
    const existing = watches.find(w => w.season === season && w.episode === episode);
    const merged = mergeShowEpisodes(show, catalog, watches, today()).episodes.find(e => e.season === season && e.number === episode);
    if (watched) {
      if (existing || merged?.watched) return;
      const forward = checkpointAfterWatch(show, catalog, [...watches, { season, episode }], today());
      await tx.episodeWatch.create({ data: { showId, season, episode, ...(forward ? {
        checkpointBeforeSeason: show.seasonsWatched, checkpointBeforeEpisode: show.episodesWatched,
        checkpointAfterSeason: forward.seasonsWatched, checkpointAfterEpisode: forward.episodesWatched,
      } : {}) } });
      if (forward) await tx.show.update({ where: { id: showId }, data: forward });
    } else {
      if (!existing) {
        if (merged?.watched) throw new EpisodeGuideError(409, 'This episode is covered by the saved position. Use Edit progress to correct it.');
        return;
      }
      const canUndo = existing.checkpointBeforeSeason !== null && existing.checkpointBeforeEpisode !== null &&
        show.seasonsWatched === existing.checkpointAfterSeason && show.episodesWatched === existing.checkpointAfterEpisode;
      if (canUndo) await tx.show.update({ where: { id: showId }, data: { seasonsWatched: existing.checkpointBeforeSeason!, episodesWatched: existing.checkpointBeforeEpisode! } });
      else if (merged?.watchSource === 'both') {
        // The individual record can be removed, but the independent saved position still covers it.
        // Older undo links are no longer safe after removing an episode under that position.
        await tx.episodeWatch.updateMany({ where: { showId }, data: { checkpointBeforeSeason: null, checkpointBeforeEpisode: null, checkpointAfterSeason: null, checkpointAfterEpisode: null } });
      }
      await tx.episodeWatch.delete({ where: { id: existing.id } });
    }
  });
  return getTrackingSummary(showId, userId);
}

export async function setSeasonWatched(showId: string, userId: string, season: number) {
  if (!validNumber(season, 1)) throw new EpisodeGuideError(400, 'Invalid season');
  const { show, catalog, episodes, watches } = await load(showId, userId);
  if (!catalog.seasons.some(s => s.number === season)) throw new EpisodeGuideError(404, 'Season not found');
  const aired = episodes.filter(e => e.season === season && e.airDate && e.airDate <= today() && !e.watched);
  await prisma.$transaction(async tx => {
    await tx.episodeWatch.createMany({ data: aired.map(e => ({ showId, season, episode: e.number })), skipDuplicates: true });
    const forward = checkpointAfterWatch(show, catalog, [...watches, ...aired.map(e => ({ season, episode: e.number }))], today());
    if (forward) await moveCheckpoint(tx, show, forward);
  });
  return getTrackingSummary(showId, userId);
}

/** A rematch that needs the user's explicit acknowledgement or a fresh review; carries the preview to show again. */
export class RematchConflictError extends EpisodeGuideError {
  constructor(message: string, public preview: Awaited<ReturnType<typeof previewRematch>>) { super(409, message); }
}

/**
 * Read-only: compare a show's current TMDB match with a chosen replacement, and explain how its existing progress
 * would read against the replacement. Never changes anything.
 */
export async function previewRematch(showId: string, userId: string, tmdbId: number) {
  if (!validNumber(tmdbId, 1)) throw new EpisodeGuideError(400, 'Choose a TMDB series');
  const show = await prisma.show.findFirst({ where: { id: showId, userId } });
  if (!show) throw new EpisodeGuideError(404, 'Show not found');
  let replacement: Catalog;
  try { replacement = await catalogFor({ name: show.name, tmdbId }); }
  catch (error) {
    if (classifyMetadataFailure(error) === 'tmdb_not_found') throw new EpisodeGuideError(404, 'That TMDB series could not be found');
    throw new EpisodeGuideError(502, 'TMDB is unavailable right now; nothing was changed');
  }
  const current = show.tmdbId && show.tmdbId !== tmdbId ? await catalogFor(show).catch(() => null) : show.tmdbId === tmdbId ? replacement : null;
  const [watches, duplicate] = await Promise.all([
    prisma.episodeWatch.findMany({ where: { showId }, select: { season: true, episode: true } }),
    prisma.show.findFirst({ where: { userId, tmdbId, NOT: { id: showId } }, select: { id: true, name: true } }),
  ]);
  const unchanged = show.tmdbId === tmdbId;
  return {
    showId, unchanged, currentTmdbId: show.tmdbId,
    current: show.tmdbId ? summarizeSeries(show.tmdbId, current, 'current', show, today()) : null,
    replacement: summarizeSeries(tmdbId, replacement, 'replacement', show, today()),
    duplicate, progress: analyzeRematchProgress(show, watches, replacement, today()),
    canApply: !unchanged && !duplicate,
  };
}

/**
 * Re-link one show to a different TMDB series. Only the TMDB link and TMDB-derived title, poster and overview change
 * (plus the TVMaze link, which belonged to the old series). Saved position, individual records, personal status and
 * favorite are untouched; progress that does not map is kept and needs review, never converted.
 */
export async function applyRematch(showId: string, userId: string, tmdbId: number, expectedCurrentTmdbId: number | null, acknowledgeProgress: boolean) {
  const preview = await previewRematch(showId, userId, tmdbId);
  if (preview.unchanged) return { preview, summary: await getTrackingSummary(showId, userId) };
  if (preview.duplicate) throw new RematchConflictError(`"${preview.duplicate.name}" in your library is already linked to this TMDB series.`, preview);
  if (preview.currentTmdbId !== expectedCurrentTmdbId) throw new RematchConflictError('This show changed since you reviewed it. Review the change again.', preview);
  if (preview.progress.needsAcknowledgement && !acknowledgeProgress) throw new RematchConflictError('Some saved progress does not map onto the selected series. Confirm that you want to keep it for review.', preview);
  const r = preview.replacement;
  try {
    const result = await prisma.show.updateMany({
      where: { id: showId, userId, tmdbId: expectedCurrentTmdbId },
      data: { tmdbId, tvmazeId: null, name: r.name, posterURL: r.posterURL, overview: r.overview },
    });
    if (result.count !== 1) throw new RematchConflictError('This show changed since you reviewed it. Review the change again.', preview);
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'P2002') throw new RematchConflictError('Another show in your library is already linked to this TMDB series.', preview);
    throw error;
  }
  return { preview, summary: await getTrackingSummary(showId, userId) };
}

export async function importLegacyProgress(showId: string, userId: string) {
  if (!await prisma.show.findFirst({ where: { id: showId, userId }, select: { id: true } })) throw new EpisodeGuideError(404, 'Show not found');
  throw new EpisodeGuideError(409, 'Saved counters do not prove individual episodes were watched. Edit the saved position instead.');
}
