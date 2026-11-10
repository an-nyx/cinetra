import type { Language } from "@/i18n";
const isolate = (text: string) => `\u2068${text}\u2069`;
export function openTitle(language: Language, title: string) {
  return language === 'ar' ? `فتح ${isolate(title)}` : language === 'fr' ? `Ouvrir ${isolate(title)}` : `Open ${title}`;
}
export function favoriteTitle(language: Language, title: string, favorite: boolean) {
  if (language === 'ar') return favorite ? `إزالة ${isolate(title)} من المفضلة` : `إضافة ${isolate(title)} إلى المفضلة`;
  if (language === 'fr') return favorite ? `Retirer ${isolate(title)} des favoris` : `Ajouter ${isolate(title)} aux favoris`;
  return `${favorite ? 'Remove' : 'Add'} ${title} ${favorite ? 'from' : 'to'} favorites`;
}
