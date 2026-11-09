import type { MovieDetails } from './tmdb/tmdb-api.service';

export type MovieRelease = { tmdbId: number; title: string; overview: string; posterURL: string | null; collectionId: number; collectionName: string; date: string | null; market: string | null; releaseType: string | null; inLibrary: boolean };
const validDay = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const typeNames: Record<number, string> = { 2: 'Limited theatrical', 3: 'Theatrical', 4: 'Digital', 5: 'Physical', 6: 'TV' };

/** TMDB collection membership is not proof of a direct sequel. Reject released, unverifiable and mismatched entries. */
export function classifyMovie(details: MovieDetails, collection: { id: number; name: string }, saved: ReadonlySet<number>, today: string, region?: string): MovieRelease | null {
  if (details.belongs_to_collection?.id !== collection.id || !details.title || !['Planned', 'In Production', 'Post Production', 'Rumored'].includes(details.status || '')) return null;
  // A global release in the past means it is no longer an upcoming film, even if a regional release is later.
  if (validDay(details.release_date) && details.release_date < today) return null;
  const dates = (details.release_dates?.results || []).flatMap(r => (r.release_dates || []).flatMap(d => {
    const day = d.release_date?.slice(0, 10);
    return validDay(day) && typeNames[d.type] && /^[A-Z]{2}$/.test(r.iso_3166_1) ? [{ day, market: r.iso_3166_1, type: d.type }] : [];
  })).sort((a, b) => a.day.localeCompare(b.day) || a.type - b.type);
  // Exclude a film already released in any market, including if TMDB's primary date is missing.
  if (dates.some(d => d.day < today)) return null;
  const regional = region ? dates.filter(d => d.market === region) : [];
  const selected = (regional.length ? regional : dates)[0];
  // Rumored titles are not presented with a confirmed date.
  const dated = details.status !== 'Rumored' && selected;
  return { tmdbId: details.id, title: details.title, overview: details.overview || '', posterURL: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null,
    collectionId: collection.id, collectionName: collection.name, date: dated ? dated.day : null, market: dated ? dated.market : null, releaseType: dated ? typeNames[dated.type] : null, inLibrary: saved.has(details.id) };
}
