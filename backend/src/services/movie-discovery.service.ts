import { TMDBApiService, type MovieCollection, type MovieDetails } from './tmdb/tmdb-api.service';
import { classifyMovie, type MovieRelease } from './movie-discovery.model';

const tmdb = new TMDBApiService();
const ttl = 12 * 60 * 60_000;
const cache = new Map<string, { until: number; value: Promise<unknown> }>();
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const item = cache.get(key);
  if (item && item.until > Date.now()) return item.value as Promise<T>;
  const value = load().catch(e => { cache.delete(key); throw e; });
  if (cache.size >= 5000) cache.delete(cache.keys().next().value!);
  cache.set(key, { until: Date.now() + ttl, value });
  return value;
}
const details = (id: number) => cached<MovieDetails>(`m:${id}`, () => tmdb.getMovieDetails(id));
const collection = (id: number) => cached<MovieCollection>(`c:${id}`, () => tmdb.getCollection(id));
async function mapLimited<T, R>(values: T[], fn: (value: T) => Promise<R>): Promise<R[]> {
  let next = 0; const out: R[] = [];
  await Promise.all(Array.from({ length: Math.min(4, values.length) }, async () => {
    while (next < values.length) { const i = next++; out[i] = await fn(values[i]); }
  }));
  return out;
}
export async function discoverMovies(ids: Array<number | null>, today: string, region?: string, provider = { details, collection }) {
  const saved = new Set(ids.filter((id): id is number => !!id));
  let unresolved = ids.filter(id => !id).length;
  let providerFailures = 0;
  const sources = await mapLimited([...saved], async id => { try { const movie = await provider.details(id); if (movie.id !== id) throw new Error("Mismatched movie identity"); return movie; } catch { unresolved++; providerFailures++; return null; } });
  const collections = new Map<number, { id: number; name: string }>();
  let verifiedMovies = 0;
  for (const source of sources) if (source?.belongs_to_collection?.id) collections.set(source.belongs_to_collection.id, source.belongs_to_collection);
  const groups = await mapLimited([...collections.values()], async c => {
    try { const result = await provider.collection(c.id); if (result.id !== c.id || !Array.isArray(result.parts)) { unresolved++; return []; } const matchingSources = sources.filter(source => source?.belongs_to_collection?.id === c.id);
      const verified = matchingSources.filter(source => result.parts!.some(part => part.id === source!.id));
      verifiedMovies += verified.length; unresolved += matchingSources.length - verified.length;
      if (!verified.length) return []; return result.parts.filter(p => !p.release_date || p.release_date >= today).map(p => ({ id: p.id, collection: c })); }
    catch { unresolved++; providerFailures++; return []; }
  });
  const parts = new Map<number, { id: number; collection: { id: number; name: string } }>();
  for (const part of groups.flat()) if (part.id > 0 && !parts.has(part.id)) parts.set(part.id, part);
  const candidates = await mapLimited([...parts.values()], async part => {
    try { const movie = await provider.details(part.id); if (movie.id !== part.id) throw new Error("Mismatched movie identity"); return classifyMovie(movie, part.collection, saved, today, region); }
    catch { unresolved++; return null; }
  });
  const releases = candidates.filter((x): x is MovieRelease => !!x).sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || a.title.localeCompare(b.title));
  const years = Object.fromEntries(sources.flatMap(source => source?.release_date && /^\d{4}-\d{2}-\d{2}$/.test(source.release_date) ? [[source.id, source.release_date.slice(0, 4)]] : []));
  return { status: 'ready' as const, releases, years, verifiedMovies, unresolved, providerFailures, generatedAt: new Date().toISOString() };
}
