/** Local, credential-scoped snapshots survive server restarts; never store the credential itself. */
const prefix = "cinetra:upcoming:v1:";
async function cacheKey(kind: "tv" | "movies") {
  const token = localStorage.getItem("Authorization");
  if (!token || !globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  if (localStorage.getItem("Authorization") !== token) return null;
  return `${prefix}${kind}:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
export async function readUpcomingCache<T>(kind: "tv" | "movies"): Promise<T | null> {
  try {
    const token = localStorage.getItem("Authorization");
    const key = await cacheKey(kind);
    if (!key || localStorage.getItem("Authorization") !== token) return null;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (value?.status !== "ready" || !Array.isArray(value.releases) || typeof value.generatedAt !== "string" || (kind === "tv" && (value.source !== "TVMaze" || !Array.isArray(value.returningTba) || !Array.isArray(value.needsReview) || !value.coverage))) return null;
    return value as T;
  } catch { return null; }
}
export async function writeUpcomingCache(kind: "tv" | "movies", value: unknown) {
  try { const token = localStorage.getItem("Authorization"); const key = await cacheKey(kind); if (key && localStorage.getItem("Authorization") === token) localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage is optional. */ }
}
export function clearUpcomingCache() {
  try { for (let i = localStorage.length - 1; i >= 0; i--) { const key = localStorage.key(i); if (key?.startsWith(prefix)) localStorage.removeItem(key); } } catch { /* Storage is optional. */ }
}
