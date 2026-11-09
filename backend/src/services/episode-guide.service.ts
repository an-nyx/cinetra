import { prisma } from '../database/prisma';
import { TMDBApiService } from './tmdb/tmdb-api.service';

const tmdb = new TMDBApiService();
const today = () => new Date().toISOString().slice(0, 10);
type Episode = { season: number; number: number; name: string; airDate: string | null; airTimestamp: string | null; runtime: number | null; watchedAt: Date | null; episodeType?: string | null };
type Catalog = { seasons: { number: number; episodeCount: number }[]; episodes: Omit<Episode, 'watchedAt'>[]; source: 'TMDB'; broadcastStatus: string | null; inProduction: boolean | null; nextEpisodeAnnounced: boolean };
const catalogCache = new Map<string, { until: number; value: Promise<Catalog> }>();

export class EpisodeGuideError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const validNumber = (value: unknown, minimum: number) => typeof value === 'number' && Number.isInteger(value) && value >= minimum;

export function normalizeLegacyPosition(seasonsWatched: number, episodesWatched: number, catalog: Catalog | null, now = today()) {
  if (!catalog) return { season: seasonsWatched, episode: episodesWatched, complete: false, needsReview: false, known: false, progressCount: null as number | null };
  const regular = catalog.episodes.filter(e => e.season > 0 && e.number > 0 && (!e.airDate || e.airDate <= now));
  const seasonNumbers = [...new Set(catalog.seasons.map(s => s.number))].sort((a, b) => a - b);
  if (seasonsWatched < 0 || episodesWatched < 0) return { season: seasonsWatched, episode: episodesWatched, complete: false, needsReview: true, known: true, progressCount: null };
  if (!episodesWatched) return { season: Math.max(1, seasonsWatched), episode: 1, complete: seasonsWatched > 1, needsReview: false, known: true, progressCount: regular.filter(e => e.season < seasonsWatched).length };
  const selected = seasonNumbers.includes(seasonsWatched) ? seasonsWatched : undefined;
  if (!selected) return { season: seasonsWatched, episode: episodesWatched, complete: false, needsReview: true, known: true, progressCount: null };
  const count = regular.filter(e => e.season === selected).length;
  if (episodesWatched > count) return { season: selected, episode: episodesWatched, complete: false, needsReview: true, known: true, progressCount: null };
  const done = episodesWatched === count && count > 0;
  const following = seasonNumbers.find(n => n > selected);
  return { season: done && following ? following : selected, episode: done && following ? 1 : episodesWatched + 1, complete: done, needsReview: false, known: true, progressCount: regular.filter(e => e.season < selected).length + episodesWatched };
}

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
  const episodes: Episode[] = catalog.episodes.map(e => ({ ...e, watchedAt: watchMap.get(`${e.season}:${e.number}`) || null }));
  return { show, catalog, episodes, watches };
}

export async function getTrackingSummary(showId: string, userId: string) {
  const show = await prisma.show.findFirst({ where: { id: showId, userId } });
  if (!show) throw new EpisodeGuideError(404, 'Show not found');
  const watches = await prisma.episodeWatch.findMany({ where: { showId }, select: { season: true, episode: true, watchedAt: true } });
  let catalog: Catalog | null = null;
  try { catalog = await catalogFor(show); } catch { /* Saved positions remain available without a provider. */ }
  const watchMap = new Map(watches.map(w => [`${w.season}:${w.episode}`, w.watchedAt]));
  const episodes: Episode[] = (catalog?.episodes || []).map(e => ({ ...e, watchedAt: watchMap.get(`${e.season}:${e.number}`) || null }));
  episodes.sort((a, b) => a.season - b.season || a.number - b.number);
  const released = episodes.filter(e => e.airDate && e.airDate <= today());
  const remaining = released.filter(e => !e.watchedAt);
  const upcoming = episodes.filter(e => e.airDate && e.airDate > today()).sort((a, b) => a.airDate!.localeCompare(b.airDate!));
  const last = [...episodes].filter(e => e.watchedAt).sort((a, b) => b.watchedAt!.getTime() - a.watchedAt!.getTime())[0] || null;
  const hasSavedPosition = show.seasonsWatched > 0 || show.episodesWatched > 0;
  const legacy = hasSavedPosition ? normalizeLegacyPosition(show.seasonsWatched, show.episodesWatched, catalog) : null;
  const next = hasSavedPosition ? (legacy && !legacy.needsReview ? episodes.find(e => e.season === legacy.season && e.number === legacy.episode && e.airDate && e.airDate <= today()) || null : null) : remaining[0] || null;
  const watched = released.length - remaining.length;
  const regular = episodes.filter(e => e.season > 0 && e.number > 0);
  const metadataComplete = !!catalog && catalog.seasons.every(s => regular.filter(e => e.season === s.number).length === s.episodeCount && regular.filter(e => e.season === s.number).every(e => !!e.airDate));
  const finalSeason = catalog?.seasons.map(s => s.number).sort((a,b)=>a-b).at(-1) || null;
  const seasonCountsKnown = !!catalog && catalog.seasons.every(s => regular.filter(e => e.season === s.number).length === s.episodeCount);
  const legacyCoversFinal = !!legacy && !legacy.needsReview && !!finalSeason && seasonCountsKnown &&
    (show.episodesWatched === 0 ? show.seasonsWatched - 1 >= finalSeason : show.seasonsWatched > finalSeason || show.seasonsWatched === finalSeason && show.episodesWatched >= (catalog!.seasons.find(s=>s.number===finalSeason)?.episodeCount || Number.MAX_SAFE_INTEGER));
  const allTracked = regular.length > 0 && regular.every(e => e.watchedAt && e.airDate && e.airDate <= today());
  const broadcastStatus = catalog?.broadcastStatus === 'Ended' ? 'ended' : catalog?.broadcastStatus === 'Returning Series' ? 'returning' : catalog?.broadcastStatus === 'In Production' ? 'in_production' : catalog?.broadcastStatus === 'Planned' ? 'planned' : 'unknown';
  const finalityConfirmed = broadcastStatus === 'ended' && catalog?.inProduction === false && !catalog.nextEpisodeAnnounced && metadataComplete && regular.every(e => !!e.airDate && e.airDate <= today());
  const fullyWatched = finalityConfirmed && ((legacyCoversFinal && hasSavedPosition) || allTracked);
  const releasedMetadataComplete = regular.every(e => !!e.airDate);
  const progressCount = hasSavedPosition ? legacy?.progressCount : watched;
  const caughtUp = !fullyWatched && releasedMetadataComplete && released.length > 0 && progressCount !== null && progressCount !== undefined && progressCount >= released.length && remaining.length === 0;
  const viewingState = !catalog || !episodes.length ? 'unknown' : fullyWatched ? 'fully_watched' : caughtUp ? 'caught_up' : hasSavedPosition || watches.length ? 'in_progress' : 'not_started';
  const percent = fullyWatched ? 100 : released.length && releasedMetadataComplete && progressCount !== null && progressCount !== undefined ? Math.min(99, Math.round(Math.min(progressCount, released.length) / released.length * 100)) : null;
  return {
    showId, name: show.name, posterURL: show.posterURL, status: show.status || (show.completed ? 'completed' : null), source: catalog?.source || null,
    guideAvailable: !!catalog && episodes.length > 0, legacyPosition: hasSavedPosition ? { fullSeasons: show.seasonsWatched, episodesInNextSeason: show.episodesWatched, normalizedSeason: legacy?.season, normalizedEpisode: legacy?.episode, needsReview: legacy?.needsReview || false } : null,
    watchedCount: watched, releasedCount: released.length, remainingCount: remaining.length,
    progressPercent: percent, broadcastStatus, viewingState, completionEligible: fullyWatched, finalSeason, finalityConfirmed,
    lastEpisode: last, nextEpisode: next, upcomingEpisode: upcoming[0] || null,
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

export async function getUpcomingReleases(userId: string) {
  const shows = await prisma.show.findMany({ where: { userId }, select: { id: true, name: true, posterURL: true, status: true } });
  const dateOnlyFloor = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const fetchOne = async (show: typeof shows[number]) => {
    try {
      const { episodes } = await load(show.id, userId);
      const releases = episodes.filter(e => e.airDate && (e.airTimestamp ? new Date(e.airTimestamp).getTime() > Date.now() : e.airDate >= dateOnlyFloor)).map(e => ({
        showId: show.id, showName: show.name, posterURL: show.posterURL, showStatus: show.status,
        season: e.season, number: e.number, name: e.name, airDate: e.airDate!, airTimestamp: e.airTimestamp, seasonPremiere: e.number === 1,
      }));
      return { releases, failed: false };
    } catch { return { releases: [], failed: true }; }
  };
  const results: Awaited<ReturnType<typeof fetchOne>>[] = [];
  for (let index = 0; index < shows.length; index += 16) {
    results.push(...await Promise.all(shows.slice(index, index + 16).map(fetchOne)));
  }
  const unique = new Map(results.flatMap(result => result.releases).map(e => [`${e.showId}:${e.season}:${e.number}`, e]));
  const releaseTime = (e: { airTimestamp: string | null; airDate: string }) => Date.parse(e.airTimestamp || `${e.airDate}T00:00:00Z`);
  return { releases: [...unique.values()].sort((a, b) => releaseTime(a) - releaseTime(b) || a.showName.localeCompare(b.showName)), failedShows: results.filter(result => result.failed).length };
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
  if (watched && (!found.airDate || found.airDate > today())) throw new EpisodeGuideError(400, 'Episode has not aired');
  if (watched) await prisma.episodeWatch.upsert({ where: { showId_season_episode: { showId, season, episode } }, create: { showId, season, episode }, update: {} });
  else await prisma.episodeWatch.deleteMany({ where: { showId, season, episode } });
  return getTrackingSummary(showId, userId);
}

export async function setSeasonWatched(showId: string, userId: string, season: number) {
  if (!validNumber(season, 1)) throw new EpisodeGuideError(400, 'Invalid season');
  const { catalog, episodes } = await load(showId, userId);
  if (!catalog.seasons.some(s => s.number === season)) throw new EpisodeGuideError(404, 'Season not found');
  const aired = episodes.filter(e => e.season === season && e.airDate && e.airDate <= today());
  await prisma.episodeWatch.createMany({ data: aired.map(e => ({ showId, season, episode: e.number })), skipDuplicates: true });
  return getTrackingSummary(showId, userId);
}

export async function importLegacyProgress(showId: string, userId: string) {
  if (!await prisma.show.findFirst({ where: { id: showId, userId }, select: { id: true } })) throw new EpisodeGuideError(404, 'Show not found');
  throw new EpisodeGuideError(409, 'Saved counters do not prove individual episodes were watched. Edit the saved position instead.');
}
