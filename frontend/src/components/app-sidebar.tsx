import * as React from "react";
import BrandLogo from "@/components/brand-logo";
import { useState, useEffect } from "react";
import { UserService } from "@/services";

import { NavMain } from "@/components/nav-main";
import { NavUser } from "@/components/nav-user";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { CalendarDays, Film, House, Tv } from "lucide-react";

const navData = {
  navMain: [
    { title: "Home", url: "/", icon: House },
    {
      title: "Shows",
      url: "/shows",
      icon: Tv,
    },
    { title: "Upcoming", url: "/upcoming", icon: CalendarDays },
    {
      title: "Movies",
      url: "/movies",
      icon: Film,
    },
  ],
};

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const [user, setUser] = useState({
    name: "Loading...",
    email: "",
    avatar: "/avatars/shadcn.jpg",
  });

  useEffect(() => {
    const fetchUserInfo = async () => {
      try {
        const userData = await UserService.getCurrentUser();
        setUser({
          name: userData.username || "User",
          email: userData.email || "",
          avatar: "/avatars/shadcn.jpg",
        });
      } catch (error) {
        console.error("Error fetching user info:", error);
        // Keep default values if fetch fails
        setUser({
          name: "User",
          email: "",
          avatar: "/avatars/shadcn.jpg",
        });
      }
    };

    fetchUserInfo();
  }, []);

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              className="data-[slot=sidebar-menu-button]:!p-1.5"
            >
              <a href="/" aria-label="Cinetra home">
                <BrandLogo size={24} wordmark={false} />
                <span className="text-base font-semibold">Cinetra<span className="text-primary">.</span></span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navData.navMain} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
    </Sidebar>
  );
}
