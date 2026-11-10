import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const messages = {
  en: { home: "Home", shows: "Shows", upcoming: "Upcoming", movies: "Movies", navigation: "Main navigation", language: "Language", account: "Account", accountMenu: "Account menu", logout: "Log out", theme: "Toggle theme", light: "Light", dark: "Dark", system: "System" },
  fr: { home: "Accueil", shows: "Séries", upcoming: "À venir", movies: "Films", navigation: "Navigation principale", language: "Langue", account: "Compte", accountMenu: "Menu du compte", logout: "Se déconnecter", theme: "Changer le thème", light: "Clair", dark: "Sombre", system: "Système" },
  ar: { home: "الرئيسية", shows: "المسلسلات", upcoming: "قريبًا", movies: "الأفلام", navigation: "التنقل الرئيسي", language: "اللغة", account: "الحساب", accountMenu: "قائمة الحساب", logout: "تسجيل الخروج", theme: "تغيير المظهر", light: "فاتح", dark: "داكن", system: "النظام" },
} as const;
export type Language = keyof typeof messages;
type Key = keyof typeof messages.en;
const Context = createContext<{ language: Language; setLanguage: (language: Language) => void; t: (key: Key) => string } | null>(null);
const valid = (value: string | null): value is Language => value === "en" || value === "fr" || value === "ar";
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(() => {
    try { const saved = localStorage.getItem("cinetra-language"); return valid(saved) ? saved : "en"; } catch { return "en"; }
  });
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
    try { localStorage.setItem("cinetra-language", language); } catch { /* Storage may be unavailable. */ }
  }, [language]);
  return <Context.Provider value={{ language, setLanguage, t: (key) => messages[language][key] ?? messages.en[key] }}>{children}</Context.Provider>;
}
export function useLanguage() {
  const context = useContext(Context);
  if (!context) throw new Error("LanguageProvider is missing");
  return context;
}

import phrases from "./phrases.json";
export function phrase(language: Language, text: string): string {
  const translated = (phrases as Record<string, string[]>)[text];
  return language === "en" || !translated ? text : translated[language === "fr" ? 0 : 1];
}
export function T({ children }: { children: string }) {
  const { language } = useLanguage();
  return <>{phrase(language, children)}</>;
}
