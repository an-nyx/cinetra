import { useSyncExternalStore } from "react";

/**
 * Celebration Animations preference. Same device-local architecture as the Progress Poster preference (localStorage,
 * like the theme and language; no account setting). Default ON: anything other than the exact value "off" — including
 * no saved value or unavailable storage — means celebrations are shown.
 */
export const CELEBRATION_STORAGE_KEY = "cinetra-celebrations";
const listeners = new Set<() => void>();
// Keeps the in-session choice when storage throws (e.g. a locked-down private window); readable storage always wins.
let sessionValue = true;

export function getCelebrationPreference(): boolean {
  try {
    const saved = localStorage.getItem(CELEBRATION_STORAGE_KEY);
    if (saved !== null) return saved !== "off";
  } catch { /* storage unavailable */ }
  return sessionValue;
}

export function setCelebrationPreference(enabled: boolean): void {
  sessionValue = enabled;
  try { localStorage.setItem(CELEBRATION_STORAGE_KEY, enabled ? "on" : "off"); } catch { /* storage unavailable */ }
  listeners.forEach(listener => listener());
}

export function subscribeCelebrationPreference(listener: () => void): () => void {
  listeners.add(listener);
  // Other tabs and windows of the same browser follow the change immediately.
  const onStorage = (event: StorageEvent) => { if (event.key === CELEBRATION_STORAGE_KEY || event.key === null) listener(); };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function useCelebrationPreference(): boolean {
  return useSyncExternalStore(subscribeCelebrationPreference, getCelebrationPreference, () => true);
}
