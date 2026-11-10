import { Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useLanguage } from "@/i18n";
export function LanguageToggle() {
  const { language, setLanguage, t } = useLanguage();
  return <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="icon" aria-label={t("language")}><Globe className="size-5" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">{([ ["en", "English"], ["fr", "Français"], ["ar", "العربية"] ] as const).map(([code, label]) => <DropdownMenuItem key={code} lang={code} dir={code === "ar" ? "rtl" : "ltr"} onSelect={() => setLanguage(code)} aria-current={language === code ? "true" : undefined}>{label}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>;
}
