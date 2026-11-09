import { prisma } from '../database/prisma';
import axios from 'axios';
import { TMDBApiService } from './tmdb/tmdb-api.service';
import { type EpisodeMetadata } from './legacy-progress.model';
import { buildTrackingSummary, catalogFromTMDB, checkpointAfterWatch, mergeShowEpisodes, type Catalog, type CatalogMeta, type Checkpoint, type MetadataFailure } from './tracking-summary.model';
import { TMDB_AUTH_CONFIGURATION_ERROR } from './tmdb/tmdb-auth';
import { getVerifiedTVMazeSchedule } from './tvmaze/upcoming-schedule.service';
import { isReturningWithoutDate, mergeUpcomingItems, needsTVMazeSupplement, type ScheduleIdentity, type UpcomingItem } from './upcoming-schedule.model';
import { chooseScheduleOnlyTMDBMatch, type ScheduleMatch } from './schedule-identity';
import { mapLimit, SWRCache } from './swr-cache';
import { analyzeRematchProgress } from './rematch.model';

const tmdb = new TMDBApiService();
const today = () => new Date().toISOString().slice(0, 10);
type Episode = EpisodeMetadata & { name: string; airTimestamp: string | null; runtime: number | null; watchedAt: Date | null; episodeType?: string | null; watched: boolean; watchSource: 'explicit' | 'legacy' | 'both' | null };
// Catalogs: fresh for 1 hour, then served stale (up to 24 hours) while one background refresh runs.
const catalogCache = new SWRCache<Catalog>({ freshMs: 60 * 60_000, staleMs: 24 * 60 * 60_000, retryMs: 5 * 60_000 });
// Upcoming per user: fresh for 5 minutes, then served stale (up to 6 hours) while it rebuilds in the background.
const upcomingCache = new SWRCache<Awaited<ReturnType<typeof buildUpcomingReleases>>>({ freshMs: 5 * 60_000, staleMs: 6 * 60 * 60_000, retryMs: 60_000, maxEntries: 200 });

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

async function buildUpcomingReleases(userId: string) {
  const shows = await prisma.show.findMany({ where: { userId }, select: { id: true, name: true, overview: true, posterURL: true, status: true, tmdbId: true, tvmazeId: true } });
  const todayDate = today();
  const linkedTmdbIds = new Set(shows.flatMap(show => (show.tmdbId ? [show.tmdbId] : [])));
  const fetchOne = async (show: typeof shows[number]) => {
    // Effective schedule identity: the stored association, else a strictly corroborated schedule-only TMDB match
    // (never stored), else TVMaze from the library title and overview. A missing association is not a provider failure.
    let tmdbId = show.tmdbId;
    let identity: ScheduleIdentity = 'linked';
    let unlinkedRejection: string | null = null;
    if (!tmdbId) {
      const match = await scheduleOnlyTMDBMatch(show, linkedTmdbIds);
      if (match.tmdbId !== null) { tmdbId = match.tmdbId; identity = 'schedule_match'; } else { unlinkedRejection = match.reason; identity = 'library_title'; }
    }
    // Show-level details as Upcoming needs them, taken from the cached catalog (no extra TMDB requests).
    let details: { name: string | null; original_name: string | null; overview: string | null; first_air_date: string | null; status: string | null; in_production: boolean | null; next_episode_to_air: CatalogMeta['nextEpisode'] } | null = null;
    let tmdbFailed = false;
    let tmdbErrorType: string | null = null;
    let tvmazeEntries = 0;
    const tmdbSeasonFailures = 0; // the catalog loads all seasons or fails as a whole
    let scheduleMetadataIncomplete = false;
    const canonical = new Map<string, { name: string; airDate: string | null }>();
    const releases = new Map<string, UpcomingItem>();
    try {
      if (!tmdbId) throw new EpisodeGuideError(404, 'No TMDB identity for schedule');
      const catalog = await catalogFor({ name: show.name, tmdbId });
      const meta = catalog.meta;
      details = { name: meta?.name ?? null, original_name: meta?.originalName ?? null, overview: meta?.overview ?? null, first_air_date: meta?.firstAirDate ?? null, status: catalog.broadcastStatus, in_production: catalog.inProduction, next_episode_to_air: meta?.nextEpisode ?? null };
      const next = meta?.nextEpisode ?? null;
      const seasons = catalog.seasons.filter(season => season.number > 0 && season.episodeCount > 0);
      const currentSeason = next?.season || meta?.lastAiredSeason || seasons[seasons.length - 1]?.number;
      const candidateSeasons = new Set<number>();
      if (currentSeason) candidateSeasons.add(currentSeason);
      for (const season of seasons) {
        const airDate = meta?.seasonAirDates[season.number];
        if (season.number >= (currentSeason || 1) && airDate && airDate >= todayDate) candidateSeasons.add(season.number);
      }
      const seasonNumbers = [...candidateSeasons].sort((a, b) => a - b).slice(0, 4);
      const episodesOf = (season: number) => catalog.episodes.filter(episode => episode.season === season && episode.number > 0);
      scheduleMetadataIncomplete = seasonNumbers.some(season => {
        const expected = seasons.find(item => item.number === season)?.episodeCount || 0;
        const regular = episodesOf(season);
        return regular.length < expected || regular.some(episode => !episode.airDate);
      });
      for (const season of seasonNumbers) for (const episode of episodesOf(season)) {
        const key = `${season}:${episode.number}`;
        canonical.set(key, { name: episode.name || '', airDate: episode.airDate });
        if (episode.airDate && episode.airDate >= todayDate) {
          releases.set(key, {
            showId: show.id, showName: show.name, posterURL: show.posterURL, showStatus: show.status,
            season, number: episode.number, name: episode.name || '', airDate: episode.airDate,
            airTimestamp: null, seasonPremiere: episode.number === 1, scheduleSource: 'TMDB', scheduleConflict: false, scheduleIdentity: identity,
          });
        }
      }
      if (next && next.season > 0 && next.number > 0 && next.airDate && next.airDate >= todayDate) {
        const key = `${next.season}:${next.number}`;
        if (!releases.has(key)) releases.set(key, {
          showId: show.id, showName: show.name, posterURL: show.posterURL, showStatus: show.status,
          season: next.season, number: next.number, name: next.name || '', airDate: next.airDate,
          airTimestamp: null, seasonPremiere: next.number === 1, scheduleSource: 'TMDB', scheduleConflict: false, scheduleIdentity: identity,
        });
      }
    } catch (error) {
      if (tmdbId) tmdbFailed = true; // no identity at all is counted separately, not as a TMDB failure
      if (tmdbId) tmdbErrorType = axios.isAxiosError(error) ? (error.response?.status ? `http_${error.response.status}` : 'network_or_timeout') : error instanceof EpisodeGuideError ? `catalog_${error.status}` : 'configuration_or_unknown';
    }

    let tvmazeVerified = false;
    let tvmazeAmbiguous = false;
    // TVMaze is schedule-only. Identity must be corroborated by the canonical
    // TMDB title/year/overview, or by the stored library title and overview when
    // TMDB is unavailable. No TVMaze IDs or tracking metadata are persisted.
    const tvmazeQueried = !tmdbId || needsTVMazeSupplement({
      tmdbResponded: !!details, tmdbFailed, tmdbSeasonFailures, scheduleMetadataIncomplete, tmdbReleaseCount: releases.size,
      broadcastStatus: details?.status, inProduction: details?.in_production, nextEpisodeAnnounced: !!details?.next_episode_to_air,
    });
    const tvmazeSkippedAsFinal = !tvmazeQueried && (tmdbFailed || tmdbSeasonFailures > 0 || scheduleMetadataIncomplete || releases.size < 2);
    if (tvmazeQueried) {
      const schedule = await getVerifiedTVMazeSchedule({
        tmdbName: details?.name, tmdbOriginalName: details?.original_name, tmdbOverview: details?.overview,
        firstAirDate: details?.first_air_date, libraryName: show.name, libraryOverview: show.overview,
      }, show.tvmazeId, todayDate);
      tvmazeVerified = schedule.identityStatus === 'verified';
      tvmazeAmbiguous = schedule.identityStatus === 'ambiguous';
      for (const episode of schedule.episodes || []) {
        const candidate = episode.season && episode.number ? canonical.get(`${episode.season}:${episode.number}`) : undefined;
        const mapped = !!candidate && !!episode.name && candidate.name.trim().toLocaleLowerCase() === episode.name.trim().toLocaleLowerCase();
        const key = mapped ? `${episode.season}:${episode.number}` : `tvmaze:${episode.airDate}:${episode.name.trim().toLocaleLowerCase()}`;
        const existing = releases.get(key);
        if (existing) {
          if (existing.scheduleSource === 'TMDB' && existing.airDate !== episode.airDate) existing.scheduleConflict = true;
          continue;
        }
        tvmazeEntries++;
        releases.set(key, {
          showId: show.id, showName: show.name, posterURL: show.posterURL, showStatus: show.status,
          season: mapped ? episode.season : null, number: mapped ? episode.number : null,
          name: mapped ? candidate!.name : episode.name, airDate: episode.airDate, airTimestamp: episode.airTimestamp,
          seasonPremiere: mapped ? episode.number === 1 : false, scheduleSource: 'TVMaze', scheduleConflict: false, scheduleIdentity: identity,
        });
      }
    }
    const broadcastStatus = details?.status || '';
    return {
      releases: [...releases.values()], failed: tmdbFailed && releases.size === 0, noTmdbAssociation: !show.tmdbId,
      unlinkedResolution: show.tmdbId ? null : identity === 'schedule_match' ? 'tmdb' as const : tvmazeVerified ? 'tvmaze' as const : 'unmatched' as const, unlinkedRejection,
      tmdbResponded: !!details, tmdbFailed, tmdbErrorType, tmdbSeasonFailures, scheduleMetadataIncomplete, tvmazeQueried, tvmazeSkippedAsFinal, tvmazeVerified, tvmazeAmbiguous, tvmazeEntries,
      tmdbEntries: [...releases.values()].filter(release => release.scheduleSource === 'TMDB').length,
      tba: isReturningWithoutDate(broadcastStatus, releases.size > 0) ? { showId: show.id, showName: show.name, posterURL: show.posterURL, broadcastStatus } : null,
    };
  };
  // Linked shows read their cached catalog; TVMaze lookups are rate-limited separately.
  const results = await mapLimit(shows, 8, fetchOne);
  const unique = new Map<string, (typeof results)[number]['releases'][number]>();
  for (const release of results.flatMap(result => result.releases)) {
    const key = release.season && release.number ? `${release.showId}:${release.season}:${release.number}` : `${release.showId}:${release.airDate}:${release.name.toLocaleLowerCase()}`;
    const existing = unique.get(key);
    if (!existing || (existing.scheduleSource !== 'TMDB' && release.scheduleSource === 'TMDB')) unique.set(key, release);
  }
  const releaseTime = (e: { airTimestamp: string | null; airDate: string }) => Date.parse(e.airTimestamp || `${e.airDate}T00:00:00Z`);
  return {
    releases: mergeUpcomingItems([...unique.values()]).sort((a, b) => releaseTime(a) - releaseTime(b) || a.showName.localeCompare(b.showName)),
    returningTba: results.flatMap(result => result.tba ? [result.tba] : []),
    failedShows: results.filter(result => result.failed).length, evaluatedShows: shows.length,
    showsWithTMDBId: shows.filter(show => !!show.tmdbId).length, showsWithoutTMDBId: shows.filter(show => !show.tmdbId).length,
    unlinkedScheduleMatches: {
      tmdb: results.filter(result => result.unlinkedResolution === 'tmdb').length,
      tvmaze: results.filter(result => result.unlinkedResolution === 'tvmaze').length,
      unmatched: results.filter(result => result.unlinkedResolution === 'unmatched').length,
    },
    unlinkedTMDBRejections: results.reduce((counts, result) => { if (result.unlinkedRejection) counts[result.unlinkedRejection] = (counts[result.unlinkedRejection] || 0) + 1; return counts; }, {} as Record<string, number>),
    tmdbResponses: results.filter(result => result.tmdbResponded).length, tmdbFailures: results.filter(result => result.tmdbFailed).length,
    tmdbSeasonFailures: results.reduce((count, result) => count + result.tmdbSeasonFailures, 0),
    incompleteTMDBSchedules: results.filter(result => result.scheduleMetadataIncomplete).length,
    tmdbFailureTypes: results.reduce((counts, result) => { if (result.tmdbErrorType) counts[result.tmdbErrorType] = (counts[result.tmdbErrorType] || 0) + 1; return counts; }, {} as Record<string, number>),
    scheduledTMDBEpisodes: results.reduce((count, result) => count + result.tmdbEntries, 0),
    scheduledTVMazeEpisodes: results.reduce((count, result) => count + result.tvmazeEntries, 0),
    tvmazeQueriedShows: results.filter(result => result.tvmazeQueried).length,
    tvmazeSkippedFinalShows: results.filter(result => result.tvmazeSkippedAsFinal).length,
    tvmazeVerifiedShows: results.filter(result => result.tvmazeVerified).length,
    tvmazeAmbiguousShows: results.filter(result => result.tvmazeAmbiguous).length,
    returningWithoutDate: results.filter(result => result.tba).length,
    scheduleConflicts: mergeUpcomingItems([...unique.values()]).filter(release => release.scheduleConflict).length,
  };
}

export function getUpcomingReleases(userId: string) {
  return upcomingCache.get(userId, () => buildUpcomingReleases(userId));
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
    await mapLimit(linked, 6, show => catalogFor(show).catch(() => null));
    const users = await prisma.show.findMany({ select: { userId: true }, distinct: ['userId'] });
    for (const { userId } of users) await getUpcomingReleases(userId).catch(() => null);
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
  return { tmdb: tmdbHealth, caches: { catalogs: catalogCache.size, upcomingUsers: upcomingCache.size, warmup } };
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

function seriesSummary(tmdbId: number, catalog: Catalog | null, fallback: { name: string; posterURL: string | null; overview: string | null }) {
  const meta = catalog?.meta;
  return {
    tmdbId, name: meta?.name || fallback.name, originalName: meta?.originalName ?? null, year: (meta?.firstAirDate || '').slice(0, 4) || null,
    overview: meta?.overview ?? fallback.overview ?? null,
    posterURL: meta?.posterPath ? `https://image.tmdb.org/t/p/w500${meta.posterPath}` : fallback.posterURL,
    seasons: catalog ? catalog.seasons.filter(s => s.number > 0).length : null,
    releasedEpisodes: catalog ? catalog.episodes.filter(e => e.season > 0 && e.number > 0 && !!e.airDate && e.airDate <= today()).length : null,
  };
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
    current: show.tmdbId ? seriesSummary(show.tmdbId, current, show) : null,
    replacement: seriesSummary(tmdbId, replacement, show),
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
