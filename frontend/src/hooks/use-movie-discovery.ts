import { useEffect, useState } from "react";
import { MovieService } from "@/services";
import type { MovieDiscovery } from "@/services/movie.service";

export function useMovieDiscovery() {
  const [data, setData] = useState<Extract<MovieDiscovery, { status: "ready" }> | null>(null);
  const [error, setError] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const load = async () => {
      try {
        const result = await MovieService.getUpcomingMovies();
        if (cancelled) return;
        if (result.status === "ready") { setData(result); setError(false); }
        else if (++attempts < 60) timer = setTimeout(load, 5000);
        else setError(true);
      } catch { if (!cancelled) setError(true); }
    };
    load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [version]);
  useEffect(() => {
    const update = () => { setData(null); setVersion(v => v + 1); };
    window.addEventListener("movies-updated", update);
    return () => window.removeEventListener("movies-updated", update);
  }, []);
  return { data, error };
}
