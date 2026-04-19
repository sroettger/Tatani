import { NavLink, Outlet } from "react-router-dom";
import { Home, BarChart3, Settings as SettingsIcon, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

const tabs = [
  { to: "/", label: "Home", Icon: Home },
  { to: "/recommendations", label: "For you", Icon: Sparkles },
  { to: "/stats", label: "Stats", Icon: BarChart3 },
  { to: "/settings", label: "Settings", Icon: SettingsIcon },
];

export function AppShell() {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <main className="flex-1 pb-24">
        <Outlet />
      </main>
      <nav className="fixed bottom-0 inset-x-0 z-40 border-t border-border bg-card/80 backdrop-blur-xl">
        <div className="max-w-2xl mx-auto grid grid-cols-4">
          {tabs.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex flex-col items-center gap-1 py-3 text-xs font-medium transition-colors",
                  isActive ? "text-primary" : "text-muted-foreground hover:text-foreground",
                )
              }
            >
              <Icon className="h-5 w-5" />
              {label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
