import type { Language } from "@/i18n";
import { episodeCode, eventEpisodeLine, relativeDay, type ReleaseEvent } from "../lib/upcoming-calendar.ts";

export const localeFor = (language: Language) => language === "fr" ? "fr-FR" : language === "ar" ? "ar" : "en-US";
export function calendarRelative(language: Language, day: string, now: Date) {
  const value = relativeDay(day, now);
  if (!value || language === "en") return value;
  return value === "Today" ? language === "fr" ? "Aujourd’hui" : "اليوم" : language === "fr" ? "Demain" : "غدًا";
}
export function localizedEpisodeLine(language: Language, event: ReleaseEvent) {
  if (language === "en") return eventEpisodeLine(event);
  const episodes = event.episodes;
  const premiere = (season: number) => season === 1 ? language === "fr" ? "Première de la série" : "بداية المسلسل" : language === "fr" ? `Début de la saison ${season}` : `بداية الموسم ${season}`;
  if (episodes.length === 1) {
    const e = episodes[0];
    const code = `\u2066${episodeCode(e.season, e.number)}\u2069`;
    return e.seasonPremiere ? `${code} · ${premiere(e.season)}` : code;
  }
  const seasons = [...new Set(episodes.map(e => e.season))];
  if (seasons.length > 1) return language === "fr" ? `Saisons ${seasons.join(", ")} · ${episodes.length} épisodes` : `المواسم ${seasons.join("، ")} · عدد الحلقات: ${episodes.length}`;
  const numbers = episodes.map(e => e.number);
  const consecutive = numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1);
  const range = consecutive ? `${numbers[0]}–${numbers[numbers.length - 1]}` : numbers.join(", ");
  const prefix = event.premiere ? premiere(seasons[0]) : language === "fr" ? `Saison ${seasons[0]}` : `الموسم ${seasons[0]}`;
  return language === "fr" ? `${prefix} · Épisodes ${range}` : `${prefix} · الحلقات ${range}`;
}
export function episodeCount(language: Language, count: number) {
  return language === "ar" ? `عدد الحلقات: ${count}` : language === "fr" ? `${count} épisode${count > 1 ? "s" : ""}` : `${count} episode${count === 1 ? "" : "s"}`;
}

export function calendarCount(language: Language, kind: "episode" | "show" | "premiere", count: number) {
  if (language === "ar") return `${{ episode: "الحلقات", show: "المسلسلات", premiere: "بدايات المواسم" }[kind]}: ${count}`;
  if (language === "fr") return `${count} ${{ episode: count > 1 ? "épisodes" : "épisode", show: count > 1 ? "séries" : "série", premiere: count > 1 ? "débuts de saison" : "début de saison" }[kind]}`;
  return `${count} ${kind}${count === 1 ? "" : "s"}`;
}

export function localizedShortDay(language: Language, day: string, now: Date) {
  const relative = calendarRelative(language, day, now);
  if (relative) return relative;
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date).toLocaleDateString(localeFor(language), { weekday: "short", month: "short", day: "numeric" });
}
