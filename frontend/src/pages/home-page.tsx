import { useState } from "react";
import { Link, NavLink, Outlet } from "react-router";
import { LogOut, UserRound } from "lucide-react";
import MobileDock from "@/components/mobile-dock";
import { ModeToggle } from "@/components/mode-toggle";
import BrandLogo from "@/components/brand-logo";
import { Button } from "@/components/ui/button";
import { AuthService } from "@/services";
import AccountModal from "@/modals/AccountModal";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const destinations = [
  { to: "/", label: "Home" },
  { to: "/shows", label: "Shows" },
  { to: "/upcoming", label: "Upcoming" },
  { to: "/movies", label: "Movies" },
];

export default function HomePage() {
  const [accountOpen, setAccountOpen] = useState(false);
  return (
    <div className="flex min-h-svh min-w-0 flex-col">
        <header className="app-header sticky top-0 z-30 flex min-h-16 shrink-0 items-center gap-3 border-b bg-background/95 px-4 md:backdrop-blur-xl md:px-6">
          <Link to="/" aria-label="Cinetra home" className="font-semibold tracking-tight">
            <BrandLogo />
          </Link>
          <nav aria-label="Main navigation" className="desktop-nav">
            {destinations.map(({ to, label }) => (
              <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => `desktop-nav-link${isActive ? " is-active" : ""}`}>{label}</NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ModeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label="Account menu" className="rounded-full"><UserRound className="size-5" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setAccountOpen(true)}><UserRound />Account</DropdownMenuItem>
                <DropdownMenuItem onClick={() => { AuthService.logout(); window.location.assign("/login"); }}><LogOut />Log out</DropdownMenuItem>
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
