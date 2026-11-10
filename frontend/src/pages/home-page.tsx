import { useState } from "react";
import { Link, NavLink, Outlet } from "react-router";
import { LogOut, UserRound } from "lucide-react";
import MobileDock from "@/components/mobile-dock";
import { LanguageToggle } from "@/components/language-toggle";
import { useLanguage } from "@/i18n";
import { ModeToggle } from "@/components/mode-toggle";
import BrandLogo from "@/components/brand-logo";
import { Button } from "@/components/ui/button";
import { AuthService } from "@/services";
import AccountModal from "@/modals/AccountModal";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const destinations = [
  { to: "/", label: "home" },
  { to: "/shows", label: "shows" },
  { to: "/upcoming", label: "upcoming" },
  { to: "/movies", label: "movies" },
] as const;

export default function HomePage() {
  const { t } = useLanguage();
  const [accountOpen, setAccountOpen] = useState(false);
  return (
    <div className="flex min-h-svh min-w-0 flex-col">
        <header className="app-header sticky top-0 z-30 flex min-h-16 shrink-0 items-center gap-3 border-b bg-background/95 px-4 md:backdrop-blur-xl md:px-6">
          <Link to="/" aria-label="Cinetra home" className="font-semibold tracking-tight">
            <BrandLogo />
          </Link>
          <nav aria-label={t("navigation")} className="desktop-nav">
            {destinations.map(({ to, label }) => (
              <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => `desktop-nav-link${isActive ? " is-active" : ""}`}>{t(label)}</NavLink>
            ))}
          </nav>
          <div className="ms-auto flex items-center gap-2">
            <LanguageToggle />
            <ModeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label={t("accountMenu")} className="rounded-full"><UserRound className="size-5" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setAccountOpen(true)}><UserRound />{t("account")}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => { AuthService.logout(); window.location.assign("/login"); }}><LogOut />{t("logout")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main id="main-content" className="app-content flex flex-1 flex-col"><Outlet /></main>
        <MobileDock />
        <AccountModal open={accountOpen} onOpenChange={setAccountOpen} />
    </div>
  );
}
