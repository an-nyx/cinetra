import { prisma } from '../database/prisma';
import axios from 'axios';
import { TMDBApiService } from './tmdb/tmdb-api.service';
import { calculateLegacyCoverage, calculateTrackingProgress, episodeKey, mergeEpisodeWatchState, type EpisodeCatalog, type EpisodeMetadata } from './legacy-progress.model';
import { getVerifiedTVMazeSchedule } from './tvmaze/upcoming-schedule.service';
import { isReturningWithoutDate, mergeUpcomingItems, type UpcomingItem } from './upcoming-schedule.model';

const tmdb = new TMDBApiService();
const today = () => new Date().toISOString().slice(0, 10);
type Episode = EpisodeMetadata & { name: string; airTimestamp: string | null; runtime: number | null; watchedAt: Date | null; episodeType?: string | null; watched: boolean; watchSource: 'explicit' | 'legacy' | 'both' | null };
type Catalog = Omit<EpisodeCatalog, 'episodes'> & { episodes: (EpisodeMetadata & { name: string; airTimestamp: string | null; runtime: number | null; episodeType?: string | null })[]; source: 'TMDB'; broadcastStatus: string | null; inProduction: boolean | null; nextEpisodeAnnounced: boolean };
const catalogCache = new Map<string, { until: number; value: Promise<Catalog> }>();
const upcomingCache = new Map<string, { until: number; value: Promise<Awaited<ReturnType<typeof buildUpcomingReleases>>> }>();

export class EpisodeGuideError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const validNumber = (value: unknown, minimum: number) => typeof value === 'number' && Number.isInteger(value) && value >= minimum;

async function catalogFor(show: { name: string; tmdbId: number | null }): Promise<Catalog> {
  if (!show.tmdbId) throw new EpisodeGuideError(404, 'TMDB match required to load episode metadata');
  const tmdbId = show.tmdbId;
  const key = `tmdb:${tmdbId}`;
  const cached = catalogCache.get(key);
  if (cached && cached.until > Date.now()) return cached.value;
  const value = (async (): Promise<Catalog> => {
    const details = await tmdb.getShow(tmdbId);
    const seasons = (details.seasons || []).filter(s => s.season_number > 0).map(s => ({ number: s.season_number, episodeCount: s.episode_count }));
    const pages = await Promise.all(seasons.map(s => tmdb.getSeason(tmdbId, s.number)));
    return { source: 'TMDB', seasons, broadcastStatus: details.status || null, inProduction: typeof details.in_production === 'boolean' ? details.in_production : null, nextEpisodeAnnounced: !!details.next_episode_to_air, episodes: pages.flatMap((page, i) => (page.episodes || []).filter(e => e.episode_number > 0).map(e => ({ season: seasons[i].number, number: e.episode_number, name: e.name, airDate: e.air_date || null, airTimestamp: null, runtime: e.runtime || null, episodeType: e.episode_type || null }))) };
  })().catch(error => { if (!(error instanceof EpisodeGuideError && error.status === 404)) catalogCache.delete(key); throw error; });
  catalogCache.set(key, { until: Date.now() + 60 * 60_000, value });
  return value;
}

async function load(showId: string, userId: string) {
  const show = await prisma.show.findFirst({ where: { id: showId, userId } });
  if (!show) throw new EpisodeGuideError(404, 'Show not found');
  const [catalog, watches] = await Promise.all([catalogFor(show), prisma.episodeWatch.findMany({ where: { showId }, select: { season: true, episode: true, watchedAt: true } })]);
  const watchMap = new Map(watches.map(w => [`${w.season}:${w.episode}`, w.watchedAt]));
  const hasSavedPosition = show.seasonsWatched > 0 || show.episodesWatched > 0;
  const legacy = calculateLegacyCoverage(show.seasonsWatched, show.episodesWatched, catalog, today());
  const episodes = mergeEpisodeWatchState(catalog.episodes.map(e => ({ ...e, watchedAt: watchMap.get(episodeKey(e.season, e.number)) || null })), watches, hasSavedPosition ? legacy : { ...legacy, covered: new Set<string>() });
  return { show, catalog, episodes, watches, legacy: hasSavedPosition ? legacy : { ...legacy, covered: new Set<string>() } };
}

export async function getTrackingSummary(showId: string, userId: string) {
  const show = await prisma.show.findFirst({ where: { id: showId, userId } });
  if (!show) throw new EpisodeGuideError(404, 'Show not found');
  const watches = await prisma.episodeWatch.findMany({ where: { showId }, select: { season: true, episode: true, watchedAt: true } });
  let catalog: Catalog | null = null;
  let metadataError: string | null = null;
  try { catalog = await catalogFor(show); } catch (error) { metadataError = error instanceof Error ? error.message : 'TMDB metadata unavailable'; /* Saved positions remain available without a provider. */ }
  const watchMap = new Map(watches.map(w => [`${w.season}:${w.episode}`, w.watchedAt]));
  const hasSavedPosition = show.seasonsWatched > 0 || show.episodesWatched > 0;
  const legacy = calculateLegacyCoverage(show.seasonsWatched, show.episodesWatched, catalog, today());
  const episodes = mergeEpisodeWatchState((catalog?.episodes || []).map(e => ({ ...e, watchedAt: watchMap.get(episodeKey(e.season, e.number)) || null })), watches, hasSavedPosition ? legacy : { ...legacy, covered: new Set<string>() });
  episodes.sort((a, b) => a.season - b.season || a.number - b.number);
  const upcoming = episodes.filter(e => e.airDate && e.airDate > today()).sort((a, b) => a.airDate!.localeCompare(b.airDate!));
  const last = [...episodes].filter(e => e.watchedAt).sort((a, b) => b.watchedAt!.getTime() - a.watchedAt!.getTime())[0] || null;
  const broadcastStatus = catalog?.broadcastStatus === 'Ended' ? 'ended' : catalog?.broadcastStatus === 'Returning Series' ? 'returning' : catalog?.broadcastStatus === 'In Production' ? 'in_production' : catalog?.broadcastStatus === 'Planned' ? 'planned' : 'unknown';
  const progress = calculateTrackingProgress(episodes, catalog, legacy.needsReview, broadcastStatus, catalog?.inProduction ?? null, !!catalog?.nextEpisodeAnnounced);
  const { releasedEpisodes: released, remainingEpisodes: remaining, finalSeason, finalityConfirmed, fullyWatched } = progress;
  const viewingState = progress.viewingState === 'unknown' && !hasSavedPosition && !watches.length && catalog?.episodes.length ? 'not_started' : progress.viewingState;
  const percent = progress.progressPercent;
  const watched = released.length - remaining.length;
  const manualCompleted = show.status === 'completed' || (!show.status && show.completed);
  const statusProgressNote = manualCompleted && !fullyWatched
    ? metadataError || !catalog ? 'Your personal status is Completed. TMDB episode data is unavailable, so completion cannot be verified.'
      : remaining.length ? `Your personal status is Completed, but ${remaining.length} released episode${remaining.length === 1 ? '' : 's'} are not confirmed as watched. Your status has not been changed.`
        : 'Your personal status is Completed, but available metadata does not verify completion. Your status has not been changed.'
    : null;
  const legacyInferredCount = episodes.filter(e => e.watchSource === 'legacy' || e.watchSource === 'both').length;
  return {
    showId, name: show.name, posterURL: show.posterURL, status: show.status || (show.completed ? 'completed' : null), source: catalog?.source || null,
    guideAvailable: !!catalog && episodes.length > 0, countDataAvailable: progress.metadataComplete, legacyPosition: hasSavedPosition ? { fullSeasons: show.seasonsWatched, episodesInNextSeason: show.episodesWatched, normalizedSeason: legacy.normalizedSeason, normalizedEpisode: legacy.normalizedEpisode, needsReview: legacy.needsReview } : null,
    watchedCount: watched, explicitWatchedCount: watches.length, legacyInferredCount, releasedCount: released.length, remainingCount: remaining.length,
    progressPercent: percent, broadcastStatus, viewingState, completionEligible: fullyWatched, finalSeason, finalityConfirmed, metadataError, statusProgressNote,
    lastEpisode: last, nextEpisode: progress.metadataComplete && !legacy.needsReview ? remaining[0] || null : null, upcomingEpisode: upcoming[0] || null,
    newEpisodes: remaining.filter(e => !!last && e.airDate! > last.watchedAt!.toISOString().slice(0, 10)).length,
    recentHistory: [...watches].sort((a, b) => b.watchedAt.getTime() - a.watchedAt.getTime()).slice(0, 5),
  };
}

export async function getLibraryTracking(userId: string) {
  const shows = await prisma.show.findMany({ where: { userId }, select: { id: true } });
  return Promise.all(shows.map(async show => {
    try { return { ...(await getTrackingSummary(show.id, userId)), error: null }; }
    catch (error) { return { showId: show.id, error: error instanceof Error ? error.message : 'Episode guide unavailable' }; }
  }));
}

async function buildUpcomingReleases(userId: string) {
  const shows = await prisma.show.findMany({ where: { userId }, select: { id: true, name: true, overview: true, posterURL: true, status: true, tmdbId: true, tvmazeId: true } });
  const todayDate = today();
  const fetchOne = async (show: typeof shows[number]) => {
    let details: Awaited<ReturnType<TMDBApiService['getShow']>> | null = null;
    let tmdbFailed = false;
    let tmdbErrorType: string | null = null;
    let tvmazeEntries = 0;
    let tmdbSeasonFailures = 0;
    let scheduleMetadataIncomplete = false;
    const canonical = new Map<string, { name: string; airDate: string | null }>();
    const releases = new Map<string, UpcomingItem>();
    try {
      if (!show.tmdbId) throw new EpisodeGuideError(404, 'TMDB match required for broadcast metadata');
      details = await tmdb.getShow(show.tmdbId);
      const next = details.next_episode_to_air;
      const seasons = (details.seasons || []).filter(season => season.season_number > 0 && season.episode_count > 0);
      const currentSeason = next?.season_number || details.last_episode_to_air?.season_number || seasons[seasons.length - 1]?.season_number;
      const candidateSeasons = new Set<number>();
      if (currentSeason) candidateSeasons.add(currentSeason);
      for (const season of seasons) {
        if (season.season_number >= (currentSeason || 1) && season.air_date && season.air_date >= todayDate) candidateSeasons.add(season.season_number);
      }
      const seasonNumbers = [...candidateSeasons].sort((a, b) => a - b).slice(0, 4);
      const pages = await Promise.all(seasonNumbers.map(async season => {
        try { return { season, data: await tmdb.getSeason(show.tmdbId!, season) }; }
        catch { tmdbSeasonFailures++; return { season, data: null }; }
      }));
      scheduleMetadataIncomplete = pages.some(page => {
        const expected = seasons.find(season => season.season_number === page.season)?.episode_count;
        const regular = (page.data?.episodes || []).filter(episode => episode.episode_number > 0);
        return !page.data || regular.length < (expected || 0) || regular.some(episode => !episode.air_date);
      });
      for (const page of pages) for (const episode of page.data?.episodes || []) {
        if (episode.episode_number > 0) canonical.set(`${page.season}:${episode.episode_number}`, { name: episode.name || '', airDate: episode.air_date || null });
        if (episode.episode_number > 0 && episode.air_date && episode.air_date >= todayDate) {
          const key = `${page.season}:${episode.episode_number}`;
          releases.set(key, {
            showId: show.id, showName: show.name, posterURL: show.posterURL, showStatus: show.status,
            season: page.season, number: episode.episode_number, name: episode.name || '', airDate: episode.air_date,
            airTimestamp: null, seasonPremiere: episode.episode_number === 1, scheduleSource: 'TMDB', scheduleConflict: false,
          });
        }
      }
      if (next && next.season_number > 0 && next.episode_number > 0 && next.air_date >= todayDate) {
        const key = `${next.season_number}:${next.episode_number}`;
        if (!releases.has(key)) releases.set(key, {
          showId: show.id, showName: show.name, posterURL: show.posterURL, showStatus: show.status,
          season: next.season_number, number: next.episode_number, name: next.name || '', airDate: next.air_date,
          airTimestamp: null, seasonPremiere: next.episode_number === 1, scheduleSource: 'TMDB', scheduleConflict: false,
        });
      }
    } catch (error) {
      tmdbFailed = true;
      tmdbErrorType = axios.isAxiosError(error) ? (error.response?.status ? `http_${error.response.status}` : 'network_or_timeout') : error instanceof EpisodeGuideError ? `catalog_${error.status}` : 'configuration_or_unknown';
    }

    let tvmazeVerified = false;
    let tvmazeAmbiguous = false;
    // TVMaze is schedule-only. Identity must be corroborated by the canonical
    // TMDB title/year/overview, or by the stored library title and overview when
    // TMDB is unavailable. No TVMaze IDs or tracking metadata are persisted.
    if (show.tmdbId && (tmdbFailed || tmdbSeasonFailures > 0 || scheduleMetadataIncomplete || releases.size < 2)) {
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
          seasonPremiere: mapped ? episode.number === 1 : false, scheduleSource: 'TVMaze', scheduleConflict: false,
        });
      }
    }
    const broadcastStatus = details?.status || '';
    return {
      releases: [...releases.values()], failed: tmdbFailed && releases.size === 0,
      tmdbResponded: !!details, tmdbFailed, tmdbErrorType, tmdbSeasonFailures, scheduleMetadataIncomplete, tvmazeVerified, tvmazeAmbiguous, tvmazeEntries,
      tmdbEntries: [...releases.values()].filter(release => release.scheduleSource === 'TMDB').length,
      tba: isReturningWithoutDate(broadcastStatus, releases.size > 0) ? { showId: show.id, showName: show.name, posterURL: show.posterURL, broadcastStatus } : null,
    };
  };
  const results: Awaited<ReturnType<typeof fetchOne>>[] = [];
  // Each show performs at most one details call and a small set of relevant
  // season calls. Keep the show-level concurrency low to avoid TMDB burst limits.
  for (let index = 0; index < shows.length; index += 8) {
    results.push(...await Promise.all(shows.slice(index, index + 8).map(fetchOne)));
  }
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
    tmdbResponses: results.filter(result => result.tmdbResponded).length, tmdbFailures: results.filter(result => result.tmdbFailed).length,
    tmdbSeasonFailures: results.reduce((count, result) => count + result.tmdbSeasonFailures, 0),
    incompleteTMDBSchedules: results.filter(result => result.scheduleMetadataIncomplete).length,
    tmdbFailureTypes: results.reduce((counts, result) => { if (result.tmdbErrorType) counts[result.tmdbErrorType] = (counts[result.tmdbErrorType] || 0) + 1; return counts; }, {} as Record<string, number>),
    scheduledTMDBEpisodes: results.reduce((count, result) => count + result.tmdbEntries, 0),
    scheduledTVMazeEpisodes: results.reduce((count, result) => count + result.tvmazeEntries, 0),
    tvmazeVerifiedShows: results.filter(result => result.tvmazeVerified).length,
    tvmazeAmbiguousShows: results.filter(result => result.tvmazeAmbiguous).length,
    returningWithoutDate: results.filter(result => result.tba).length,
    scheduleConflicts: mergeUpcomingItems([...unique.values()]).filter(release => release.scheduleConflict).length,
  };
}

export function getUpcomingReleases(userId: string) {
  const cached = upcomingCache.get(userId);
  if (cached && cached.until > Date.now()) return cached.value;
  const value = buildUpcomingReleases(userId).catch(error => { upcomingCache.delete(userId); throw error; });
  if (upcomingCache.size > 100) upcomingCache.delete(upcomingCache.keys().next().value!);
  upcomingCache.set(userId, { until: Date.now() + 5 * 60_000, value });
  return value;
}

export async function getEpisodeGuide(showId: string, userId: string, season: number) {
  if (!validNumber(season, 1)) throw new EpisodeGuideError(400, 'Invalid season');
  const { catalog, episodes, watches } = await load(showId, userId);
  if (!catalog.seasons.some(s => s.number === season)) throw new EpisodeGuideError(404, 'Season not found');
  return { seasons: catalog.seasons, season, episodes: episodes.filter(e => e.season === season), watched: watches };
}

export async function setEpisodeWatched(showId: string, userId: string, season: number, episode: number, watched: boolean) {
  if (!validNumber(season, 1) || !validNumber(episode, 1) || typeof watched !== 'boolean') throw new EpisodeGuideError(400, 'Invalid episode update');
  const { episodes } = await load(showId, userId);
  const found = episodes.find(e => e.season === season && e.number === episode);
  if (!found) throw new EpisodeGuideError(404, 'Episode not found');
  if (found.watchSource === 'legacy' || found.watchSource === 'both') {
    if (!watched) throw new EpisodeGuideError(409, 'This episode is covered by the saved legacy position. Use Edit Progress to change that position.');
    return getTrackingSummary(showId, userId);
  }
  if (watched && found.watched) return getTrackingSummary(showId, userId);
  if (watched && (!found.airDate || found.airDate > today())) throw new EpisodeGuideError(400, 'Episode has not aired');
  if (watched) await prisma.episodeWatch.upsert({ where: { showId_season_episode: { showId, season, episode } }, create: { showId, season, episode }, update: {} });
  else await prisma.episodeWatch.deleteMany({ where: { showId, season, episode } });
  return getTrackingSummary(showId, userId);
}

export async function setSeasonWatched(showId: string, userId: string, season: number) {
  if (!validNumber(season, 1)) throw new EpisodeGuideError(400, 'Invalid season');
  const { catalog, episodes } = await load(showId, userId);
  if (!catalog.seasons.some(s => s.number === season)) throw new EpisodeGuideError(404, 'Season not found');
  const aired = episodes.filter(e => e.season === season && e.airDate && e.airDate <= today() && !e.watched);
  await prisma.episodeWatch.createMany({ data: aired.map(e => ({ showId, season, episode: e.number })), skipDuplicates: true });
  return getTrackingSummary(showId, userId);
}

export async function importLegacyProgress(showId: string, userId: string) {
  if (!await prisma.show.findFirst({ where: { id: showId, userId }, select: { id: true } })) throw new EpisodeGuideError(404, 'Show not found');
  throw new EpisodeGuideError(409, 'Saved counters do not prove individual episodes were watched. Edit the saved position instead.');
}
