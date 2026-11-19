import { NavLink, Outlet } from "react-router-dom";
import { Home, BarChart3, Settings as SettingsIcon, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import type { StringKey } from "@/i18n/strings";

const tabs: Array<{ to: string; labelKey: StringKey; Icon: typeof Home }> = [
  { to: "/", labelKey: "nav.home", Icon: Home },
  { to: "/recommendations", labelKey: "nav.forYou", Icon: Sparkles },
  { to: "/stats", labelKey: "nav.stats", Icon: BarChart3 },
  { to: "/settings", labelKey: "nav.settings", Icon: SettingsIcon },
];

export function AppShell() {
  const { t } = useI18n();
  return (
    <div className="min-h-screen flex flex-col bg-background overflow-x-hidden">
      <main className="flex-1 pb-24 min-w-0 w-full">
        <Outlet />
      </main>
      <nav className="fixed bottom-0 inset-x-0 z-40 border-t border-border bg-card/80 backdrop-blur-xl pb-[env(safe-area-inset-bottom)]">
        <div className="max-w-2xl mx-auto grid grid-cols-4">
          {tabs.map(({ to, labelKey, Icon }) => (
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
              {t(labelKey)}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
