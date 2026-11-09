import { useState } from "react";
import { Link, NavLink, Outlet } from "react-router";
import { CalendarDays, Film, House, LogOut, Tv, UserRound } from "lucide-react";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { ModeToggle } from "@/components/mode-toggle";
import { Button } from "@/components/ui/button";
import { AuthService } from "@/services";
import AccountModal from "@/modals/AccountModal";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const destinations = [
  { to: "/", label: "Home", icon: House },
  { to: "/shows", label: "Shows", icon: Tv },
  { to: "/upcoming", label: "Upcoming", icon: CalendarDays },
  { to: "/movies", label: "Movies", icon: Film },
];

export default function HomePage() {
  const [accountOpen, setAccountOpen] = useState(false);
  return (
    <SidebarProvider>
      <AppSidebar variant="inset" />
      <SidebarInset className="min-w-0">
        <header className="app-header sticky top-0 z-30 flex min-h-16 shrink-0 items-center gap-3 border-b bg-background/95 px-4 md:backdrop-blur-xl md:px-6">
          <SidebarTrigger className="hidden md:flex" />
          <Link to="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
            <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground"><Film className="size-5" /></span>
            <span className="text-lg">cinetra<span className="text-primary">.</span></span>
          </Link>
          <div className="ml-auto flex items-center gap-2">
            <ModeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label="Account menu" className="rounded-full md:hidden"><UserRound className="size-5" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setAccountOpen(true)}><UserRound />Account</DropdownMenuItem>
                <DropdownMenuItem onClick={() => { AuthService.logout(); window.location.assign("/login"); }}><LogOut />Log out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main id="main-content" className="app-content flex flex-1 flex-col"><Outlet /></main>
        <nav aria-label="Main navigation" className="mobile-nav fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t bg-background/95 px-4 pt-2 md:backdrop-blur-xl md:hidden">
          {destinations.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => `flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-medium transition-colors ${isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"}`}>
              <Icon className="size-5" /><span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <AccountModal open={accountOpen} onOpenChange={setAccountOpen} />
      </SidebarInset>
    </SidebarProvider>
  );
}
