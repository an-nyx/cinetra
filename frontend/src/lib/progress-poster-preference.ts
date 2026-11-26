import { useSyncExternalStore } from "react";

/**
 * Progress Poster display preference. Stored on this device only (like the theme and language), because Cinetra has no
 * account-level appearance settings. Default OFF: anything other than the exact value "on" — including no saved value or
 * unavailable storage — means the original poster. Reads are synchronous, so the effect never flashes on load.
 */
export const PROGRESS_POSTER_STORAGE_KEY = "cinetra-progress-poster";
const listeners = new Set<() => void>();
// Keeps the in-session choice when storage throws (e.g. a locked-down private window); readable storage always wins.
let sessionValue = false;

export function getProgressPosterPreference(): boolean {
  try {
    const saved = localStorage.getItem(PROGRESS_POSTER_STORAGE_KEY);
    if (saved !== null) return saved === "on";
  } catch { /* storage unavailable */ }
  return sessionValue;
}

export function setProgressPosterPreference(enabled: boolean): void {
  sessionValue = enabled;
  try { localStorage.setItem(PROGRESS_POSTER_STORAGE_KEY, enabled ? "on" : "off"); } catch { /* storage unavailable */ }
  listeners.forEach(listener => listener());
}

export function subscribeProgressPosterPreference(listener: () => void): () => void {
  listeners.add(listener);
  // Other tabs and windows of the same browser follow the change immediately.
  const onStorage = (event: StorageEvent) => { if (event.key === PROGRESS_POSTER_STORAGE_KEY || event.key === null) listener(); };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function useProgressPosterPreference(): boolean {
  return useSyncExternalStore(subscribeProgressPosterPreference, getProgressPosterPreference, () => false);
}
