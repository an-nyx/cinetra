import type { MovieInfoResponse } from './tmdb/tmdb-api.service';

export function movieInfo(info: MovieInfoResponse) {
  const trailer = info.videos?.results?.find(video => video.site === 'YouTube' && video.type === 'Trailer' && video.official === true && typeof video.key === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(video.key));
  return {
    year: /^\d{4}-\d{2}-\d{2}$/.test(info.release_date || '') ? info.release_date!.slice(0, 4) : null,
    runtime: typeof info.runtime === 'number' && Number.isInteger(info.runtime) && info.runtime > 0 ? info.runtime : null,
    genres: (info.genres || []).map(genre => genre.name).filter(name => typeof name === 'string' && name.trim()),
    trailerUrl: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null,
  };
}
