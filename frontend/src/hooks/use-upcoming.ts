import { useCallback, useEffect, useRef, useState } from "react";
import { ApiService, ShowService } from "@/services";
import { readUpcomingCache, writeUpcomingCache } from "@/lib/upcoming-cache";
import type { UpcomingSchedule } from "@/services/show.service";

const BUILD_RETRY_MS = 5_000;
const BUILD_MAX_ATTEMPTS = 60;
export function useUpcomingSchedule() {
  const [schedule, setSchedule] = useState<UpcomingSchedule | null>(null);
  const [cached, setCached] = useState(false);
  const [building, setBuilding] = useState<{ done: number; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const run = useRef(0);
  const load = useCallback(async (refresh = false) => {
    const current = ++run.current;
    if (refresh) { setRefreshing(true); setError(""); ApiService.clearCache(); }
    try {
      const snapshot = await readUpcomingCache<UpcomingSchedule>("tv");
      if (current !== run.current) return;
      if (snapshot) { setSchedule(snapshot); setCached(true); setLoading(false); }
      for (let attempt = 0; attempt < BUILD_MAX_ATTEMPTS; attempt++) {
        const data = await ShowService.getUpcomingReleases({ refresh: refresh && attempt === 0, bypassCache: true });
        if (current !== run.current) return;
        if (data.status === "ready") {
          if (snapshot && (data.stale || data.unavailable.length > 0)) {
            setSchedule(snapshot); setCached(true); setError("Some TV sources are unavailable; showing the saved schedule.");
          } else { setSchedule(data); setCached(false); setError(""); }
          setLoading(false);
          // Never replace a successful snapshot with a provider failure or a transient refresh response.
          if (!data.refreshing && !data.stale && data.unavailable.length === 0) void writeUpcomingCache("tv", data);
          if (!data.refreshing) { setBuilding(null); return; }
          setBuilding(data.progress || { done: 0, total: 0 });
        } else { setBuilding(data.progress); setLoading(false); }
        await new Promise(resolve => setTimeout(resolve, BUILD_RETRY_MS));
        if (current !== run.current) return;
      }
      setBuilding(null); setError("The TV schedule is taking longer than expected. Try again.");
    } catch { if (current === run.current) { setBuilding(null); setError("TV releases could not be refreshed. Try again."); } }
    finally { if (current === run.current) { setLoading(false); setRefreshing(false); } }
  }, []);
  useEffect(() => {
    load();
    const onChange = () => load();
    window.addEventListener("tracking-updated", onChange); window.addEventListener("online", onChange);
    return () => { run.current++; window.removeEventListener("tracking-updated", onChange); window.removeEventListener("online", onChange); };
  }, [load]);
  return { schedule, cached, building, loading, refreshing, error, refresh: () => load(true) };
}
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
