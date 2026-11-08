import axios from 'axios';
import { prisma } from '../database/prisma';
import { TMDBApiService } from './tmdb/tmdb-api.service';

const tmdb = new TMDBApiService();
const today = () => new Date().toISOString().slice(0, 10);
type Episode = { season: number; number: number; name: string; airDate: string | null; airTimestamp: string | null; runtime: number | null; watchedAt: Date | null };
type Catalog = { seasons: { number: number; episodeCount: number }[]; episodes: Omit<Episode, 'watchedAt'>[]; source: 'TMDB' | 'TVMaze' };
const catalogCache = new Map<string, { until: number; value: Promise<Catalog> }>();

export class EpisodeGuideError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const validNumber = (value: unknown, minimum: number) => typeof value === 'number' && Number.isInteger(value) && value >= minimum;

async function catalogFor(show: { name: string; tmdbId: number | null; tvmazeId: number | null }): Promise<Catalog> {
  const key = `${show.tmdbId || ''}:${show.tvmazeId || ''}:${show.name}`;
  const cached = catalogCache.get(key);
  if (cached && cached.until > Date.now()) return cached.value;
  const value = (async (): Promise<Catalog> => {
    if (show.tmdbId && process.env.API_AUTHORIZATION && !process.env.API_AUTHORIZATION.includes('<')) {
      const details = await tmdb.getShow(show.tmdbId);
      const seasons = details.seasons.filter(s => s.season_number > 0).map(s => ({ number: s.season_number, episodeCount: s.episode_count }));
      const pages = await Promise.all(seasons.map(s => tmdb.getSeason(show.tmdbId!, s.number)));
      return { source: 'TMDB', seasons, episodes: pages.flatMap((page, i) => page.episodes.map(e => ({ season: seasons[i].number, number: e.episode_number, name: e.name, airDate: e.air_date || null, airTimestamp: null, runtime: e.runtime || null }))) };
    }
    // TVMaze's public episode endpoint provides a real guide when TMDB is not configured.
    let tvmazeId = show.tvmazeId;
    if (!tvmazeId) {
      const search = await axios.get<Array<{ show: { id: number; name: string } }>>('https://api.tvmaze.com/search/shows', { params: { q: show.name }, timeout: 10000 });
      const match = search.data.find(item => item.show.name.localeCompare(show.name, undefined, { sensitivity: 'base' }) === 0);
      if (!match) throw new EpisodeGuideError(404, 'No exact episode guide match found for this show');
      tvmazeId = match.show.id;
    }
    const response = await axios.get<Array<{ season: number; number: number; name: string; airdate: string | null; airstamp: string | null; runtime: number | null }>>(`https://api.tvmaze.com/shows/${tvmazeId}/episodes`, { timeout: 10000 });
    const episodes = response.data.filter(e => e.season > 0 && e.number > 0).map(e => ({ season: e.season, number: e.number, name: e.name, airDate: e.airdate || null, airTimestamp: e.airstamp || null, runtime: e.runtime || null }));
    const seasons = [...new Set(episodes.map(e => e.season))].sort((a, b) => a - b).map(number => ({ number, episodeCount: episodes.filter(e => e.season === number).length }));
    return { source: 'TVMaze', seasons, episodes };
  })().catch(error => { catalogCache.delete(key); throw error; });
  catalogCache.set(key, { until: Date.now() + 15 * 60_000, value });
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
  const { show, catalog, episodes, watches } = await load(showId, userId);
  const released = episodes.filter(e => e.airDate && e.airDate <= today());
  const remaining = released.filter(e => !e.watchedAt);
  const upcoming = episodes.filter(e => e.airDate && e.airDate > today()).sort((a, b) => a.airDate!.localeCompare(b.airDate!));
  const last = [...episodes].filter(e => e.watchedAt).sort((a, b) => b.watchedAt!.getTime() - a.watchedAt!.getTime())[0] || null;
  const next = remaining[0] || null;
  const watched = released.length - remaining.length;
  return {
    showId, name: show.name, posterURL: show.posterURL, status: show.status || (show.completed ? 'completed' : watches.length ? 'watching' : 'planned'), source: catalog.source,
    watchedCount: watched, releasedCount: released.length, remainingCount: remaining.length,
    progressPercent: released.length ? Math.round(watched / released.length * 100) : 0,
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
  for (let index = 0; index < shows.length; index += 4) {
    results.push(...await Promise.all(shows.slice(index, index + 4).map(fetchOne)));
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
  const { show, catalog, episodes, watches } = await load(showId, userId);
  if (watches.length) throw new EpisodeGuideError(409, 'Individual episodes have already been tracked');
  const fullSeasons = catalog.seasons.slice(0, show.seasonsWatched).map(s => s.number);
  const nextSeason = catalog.seasons[show.seasonsWatched]?.number;
  const importable = episodes.filter(e => e.airDate && e.airDate <= today() &&
    (fullSeasons.includes(e.season) || e.season === nextSeason && e.number <= show.episodesWatched));
  await prisma.episodeWatch.createMany({ data: importable.map(e => ({ showId, season: e.season, episode: e.number })), skipDuplicates: true });
  return getTrackingSummary(showId, userId);
}
