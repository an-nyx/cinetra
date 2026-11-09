import { useCallback, useEffect, useRef, useState } from "react";
import { ApiService, ShowService } from "@/services";
import type { UpcomingSchedule } from "@/services/show.service";

/** How long pages keep asking while a first (cold) schedule is built on the server, and how often. */
const BUILD_RETRY_MS = 5_000;
const BUILD_MAX_ATTEMPTS = 30;

/**
 * The TVMaze schedule for Home and Upcoming. Both read the same response (cached by ApiService), so the two pages
 * always agree. While the server is still building a cold schedule it reports progress, and this hook asks again a
 * bounded number of times. No background polling otherwise.
 */
export function useUpcomingSchedule() {
  const [schedule, setSchedule] = useState<UpcomingSchedule | null>(null);
  const [building, setBuilding] = useState<{ done: number; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const run = useRef(0);

  const load = useCallback(async (refresh = false) => {
    const current = ++run.current;
    if (refresh) { setRefreshing(true); ApiService.clearCache(); }
    try {
      for (let attempt = 0; attempt < BUILD_MAX_ATTEMPTS; attempt++) {
        const data = await ShowService.getUpcomingReleases({ refresh: refresh && attempt === 0, bypassCache: attempt > 0 });
        if (current !== run.current) return;
        if (data.status === "ready") { setSchedule(data); setBuilding(null); setError(""); return; }
        setBuilding(data.progress);
        await new Promise(resolve => setTimeout(resolve, BUILD_RETRY_MS));
        if (current !== run.current) return;
      }
      setError("The schedule is taking longer than usual to prepare. Try again in a minute.");
    } catch {
      if (current === run.current) setError("Upcoming releases could not be loaded. Please try again.");
    } finally {
      if (current === run.current) { setLoading(false); setRefreshing(false); }
    }
  }, []);

  useEffect(() => {
    load();
    const onChange = () => load();
    window.addEventListener("tracking-updated", onChange);
    window.addEventListener("online", onChange);
    return () => { run.current++; window.removeEventListener("tracking-updated", onChange); window.removeEventListener("online", onChange); };
  }, [load]);

  return { schedule, building, loading, refreshing, error, refresh: () => load(true) };
}

/** The current time, refreshed every minute and when the page becomes visible again (day boundaries stay right). */
export function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = window.setInterval(() => setNow(new Date()), 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") setNow(new Date()); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(tick); document.removeEventListener("visibilitychange", onVisible); };
  }, []);
  return now;
}
