import { phrase, type Language } from "./index";
import type { CelebrationLevel } from "../lib/celebration";

/** Banner wording for each milestone. The episode level is a silent check (the tapped control already says "watched"). */
export function celebrationTitle(language: Language, level: Exclude<CelebrationLevel, "episode">) {
  return phrase(language, level === "series" ? "Series completed!" : level === "caught_up" ? "All caught up!" : "Season completed!");
}

export function celebrationSeason(language: Language, season: number) {
  return language === "fr" ? `Saison ${season}` : language === "ar" ? `الموسم ${season}` : `Season ${season}`;
}
