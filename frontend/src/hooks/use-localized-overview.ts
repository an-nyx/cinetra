import { useEffect, useState } from "react";
import { useLanguage } from "@/i18n";
import { ApiService } from "@/services";
type Result = { overview: string | null; loading: boolean; unavailable: boolean };
const cache = new Map<string, { overview: string | null; expires: number }>();
class OverviewService extends ApiService {
  async load(kind: "show" | "movie", id: string, locale: string, signal: AbortSignal) {
    return (await this.get<{ overview: string | null }>(`/${kind}/${encodeURIComponent(id)}/localized-overview`, { params: { language: locale }, signal })).data.overview;
  }
}
const service = new OverviewService();
export function useLocalizedOverview(kind: "show" | "movie", id: string | null, english: string | null | undefined): Result {
  const { language } = useLanguage();
  const [state, setState] = useState<{ key: string; result: Result } | null>(null);
  const key = `${kind}:${id}:${language}`;
  useEffect(() => {
    if (!id || language === "en") return;
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) { const overview = cached.overview; setState({ key, result: { overview, loading: false, unavailable: !overview } }); return; }
    const controller = new AbortController();
    setState({ key, result: { overview: null, loading: true, unavailable: false } });
    service.load(kind, id, language === "fr" ? "fr-FR" : "ar", controller.signal).then(overview => {
      if (controller.signal.aborted) return;
      if (cache.size >= 300) cache.delete(cache.keys().next().value!);
      cache.set(key, { overview, expires: Date.now() + 5 * 60_000 }); setState({ key, result: { overview, loading: false, unavailable: !overview } });
    }).catch(() => { if (!controller.signal.aborted) setState({ key, result: { overview: null, loading: false, unavailable: true } }); });
    return () => controller.abort();
  }, [kind, id, language]);
  return language === "en" ? { overview: english || null, loading: false, unavailable: !english } : state?.key === key ? state.result : { overview: null, loading: !!id, unavailable: !id };
}
