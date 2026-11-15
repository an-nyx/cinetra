/** Explicit enrollment only: absent or malformed configuration disables every automatic writer. */
import { createHash } from 'node:crypto';
export type ScopedTarget = { showId: string; tmdbId: number; tvmazeId: number; initial?: { updatedAt: string; status: string | null; completed: boolean; completedMonitorFrom: string | null; seasonsWatched: number; episodesWatched: number; historySha256: string; released: number; watched: number; unwatched: string[] } };
export type StatusScope = { userId: string; targets: ScopedTarget[]; excludedShowIds: string[] };
export function statusScope(): StatusScope | null {
  try {
    const s = JSON.parse(process.env.TV_STATUS_RECONCILIATION_SCOPE || 'null');
    if (!s || typeof s.userId !== 'string' || !s.userId || !Array.isArray(s.targets) || !s.targets.length || s.targets.length > 1000 || !Array.isArray(s.excludedShowIds)) return null;
    if (new Set(s.excludedShowIds).size !== s.excludedShowIds.length || s.excludedShowIds.some((id: unknown) => typeof id !== 'string')) return null;
    if (s.targets.some((t: ScopedTarget) => !t || typeof t.showId !== 'string' || !t.showId || !Number.isInteger(t.tmdbId) || t.tmdbId <= 0 || !Number.isInteger(t.tvmazeId) || t.tvmazeId <= 0 || s.excludedShowIds.includes(t.showId))) return null;
    if (new Set(s.targets.map((t: ScopedTarget) => t.showId)).size !== s.targets.length || new Set(s.targets.map((t: ScopedTarget) => t.tmdbId)).size !== s.targets.length || new Set(s.targets.map((t: ScopedTarget) => t.tvmazeId)).size !== s.targets.length) return null;
    // Production enrollment is the exact approved manifest, never an arbitrary global scope.
    if (process.env.NODE_ENV === 'production' && createHash('sha256').update(stableJSON(s)).digest('hex') !== 'dd5eb0b86b08968ac10b3fba7f46e1ad061f6a77b6b0f025924f04f0fe404032') return null;
    return s;
  } catch { return null; }
}
export function scopedTarget(show: { id: string; userId: string; tmdbId: number | null; tvmazeId: number | null }): ScopedTarget | null {
  const scope = statusScope();
  if (!scope || scope.userId !== show.userId || scope.excludedShowIds.includes(show.id)) return null;
  const target = scope.targets.find(t => t.showId === show.id && t.tmdbId === show.tmdbId);
  return target && (!show.tvmazeId || show.tvmazeId === target.tvmazeId) ? target : null;
}
export function stableJSON(value: unknown): string {
  const canonical = (v: any): any => v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return JSON.stringify(canonical(value));
}
export const scopeDigest = () => statusScope() ? createHash('sha256').update(stableJSON(statusScope())).digest('hex') : null;
export const historyDigest = (watches: { id: string }[], unwatches: { id: string }[]) => createHash('sha256').update(stableJSON({ watches: [...watches].sort((a,b) => a.id.localeCompare(b.id)), unwatches: [...unwatches].sort((a,b) => a.id.localeCompare(b.id)) })).digest('hex');
