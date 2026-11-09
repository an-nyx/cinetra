/**
 * Stale-while-revalidate cache.
 *
 * - Fresh entries are returned immediately.
 * - Stale entries (past freshMs, within staleMs) are returned immediately and refreshed once in the background.
 * - Missing or expired entries are loaded; concurrent callers share one in-flight load.
 * - A failed background refresh keeps the stale value and retries after retryMs; a failed first load is not cached.
 */
type Entry<V> = { value?: V; hasValue: boolean; freshUntil: number; staleUntil: number; pending?: Promise<V> };

export class SWRCache<V> {
  private entries = new Map<string, Entry<V>>();
  constructor(private readonly options: { freshMs: number; staleMs: number; retryMs?: number; maxEntries?: number; now?: () => number }) {}

  private now() { return (this.options.now || Date.now)(); }

  get(key: string, load: () => Promise<V>): Promise<V> {
    const entry = this.entries.get(key);
    const now = this.now();
    if (entry?.hasValue && now < entry.staleUntil) {
      if (now >= entry.freshUntil) this.refresh(key, load).catch(() => { /* stale value stays available */ });
      return Promise.resolve(entry.value as V);
    }
    return this.refresh(key, load);
  }

  /** Start (or join) a load for this key. */
  refresh(key: string, load: () => Promise<V>): Promise<V> {
    const existing = this.entries.get(key);
    if (existing?.pending) return existing.pending;
    const entry: Entry<V> = existing || { hasValue: false, freshUntil: 0, staleUntil: 0 };
    const pending = load().then(value => {
      const now = this.now();
      if (this.entries.get(key) === entry) {
        this.entries.set(key, { value, hasValue: true, freshUntil: now + this.options.freshMs, staleUntil: now + this.options.staleMs });
        this.trim();
      }
      return value;
    }, error => {
      const current = this.entries.get(key);
      if (current !== entry) throw error;
      if (current?.hasValue) { current.pending = undefined; current.freshUntil = this.now() + (this.options.retryMs ?? 60_000); }
      else this.entries.delete(key);
      throw error;
    });
    entry.pending = pending;
    this.entries.set(key, entry);
    return pending;
  }

  delete(key: string) { this.entries.delete(key); }
  /** Mark as stale: the next get returns the current value at once and refreshes it in the background. */
  expire(key: string) { const entry = this.entries.get(key); if (entry) entry.freshUntil = 0; }
  get size() { return [...this.entries.values()].filter(e => e.hasValue).length; }

  private trim() {
    const max = this.options.maxEntries ?? 5000;
    while (this.entries.size > max) this.entries.delete(this.entries.keys().next().value!);
  }
}

/** Run work over items with at most `limit` in flight. Results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index]); }
  }));
  return results;
}
