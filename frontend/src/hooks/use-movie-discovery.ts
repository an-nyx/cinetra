import { useEffect, useState } from "react";
import { MovieService } from "@/services";
import { readUpcomingCache, writeUpcomingCache } from "@/lib/upcoming-cache";
import type { MovieDiscovery } from "@/services/movie.service";
type Ready = Extract<MovieDiscovery, { status: "ready" }>;
export function useMovieDiscovery() {
  const [data, setData] = useState<Ready | null>(null);
  const [cached, setCached] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let snapshot: Ready | null = null;
    let cancelled = false; let timer: ReturnType<typeof setTimeout>; let attempts = 0;
    const load = async () => {
      try {
        const result = await MovieService.getUpcomingMovies(version > 0 && attempts === 0);
        if (cancelled) return;
        if (result.status === "ready") {
          if (snapshot && (result.providerFailures || result.refreshError)) { setData(snapshot); setCached(true); setError(true); }
          else { setData(result); setCached(false); setError(!!result.providerFailures || !!result.refreshError); }
          setLoading(false);
          if (!result.refreshing) { if (!result.providerFailures && !result.refreshError) void writeUpcomingCache("movies", result); return; }
        }
        if (++attempts < 60) timer = setTimeout(load, 5000); else { setLoading(false); setError(true); }
      } catch { if (!cancelled) { setLoading(false); setError(true); } }
    };
    readUpcomingCache<Ready>("movies").then(saved => {
      snapshot = saved;
      if (cancelled) return;
      if (snapshot) { setData(snapshot); setCached(true); setLoading(false); }
      load();
    });
    return () => { cancelled = true; clearTimeout(timer); };
  }, [version]);
  useEffect(() => {
    const update = () => setVersion(v => v + 1);
    window.addEventListener("movies-updated", update);
    return () => window.removeEventListener("movies-updated", update);
  }, []);
  return { data, cached, loading, error, retry: () => setVersion(v => v + 1) };
}
