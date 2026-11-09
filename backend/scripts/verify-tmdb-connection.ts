import 'dotenv/config';
import axios from 'axios';
import { TMDBApiService } from '../src/services/tmdb/tmdb-api.service';
import { TMDB_AUTH_CONFIGURATION_ERROR, resolveTMDBRequestAuth } from '../src/services/tmdb/tmdb-auth';

async function main() {
  if (!resolveTMDBRequestAuth(process.env)) throw new Error(TMDB_AUTH_CONFIGURATION_ERROR);
  const showId = Number(process.env.TMDB_VERIFY_SHOW_ID || 52814); // Halo
  if (!Number.isInteger(showId) || showId <= 0) throw new Error('TMDB_VERIFY_SHOW_ID must be a positive series ID.');
  const tmdb = new TMDBApiService();
  const details = await tmdb.getShow(showId);
  const seasons = (details.seasons || []).filter(season => season.season_number > 0);
  const seasonResults = await Promise.all(seasons.map(async season => {
    const metadata = await tmdb.getSeason(showId, season.season_number);
    const episodes = (metadata.episodes || []).filter(episode => episode.episode_number > 0);
    return { season: season.season_number, declaredEpisodes: season.episode_count, returnedRegularEpisodes: episodes.length, allAirDatesPresent: episodes.every(episode => !!episode.air_date), episodes: episodes.map(episode => ({ number: episode.episode_number, airDate: episode.air_date || null, episodeType: episode.episode_type || null })) };
  }));
  console.log(JSON.stringify({ requestStatus: 'success (TMDB returned 2xx)', showId, broadcastStatus: details.status || null, inProduction: details.in_production ?? null, nextEpisode: details.next_episode_to_air ? { season: details.next_episode_to_air.season_number, episode: details.next_episode_to_air.episode_number, airDate: details.next_episode_to_air.air_date } : null, seasons: seasonResults }, null, 2));
}

main().catch(error => {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  console.error(JSON.stringify({ requestStatus: 'failed', httpStatus: status || null, message: status ? `TMDB HTTP ${status}` : error instanceof Error ? error.message : 'TMDB request failed' }));
  process.exitCode = 1;
});
