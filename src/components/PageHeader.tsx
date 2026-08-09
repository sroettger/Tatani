import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

export function PageHeader({
  title, subtitle, icon, className,
}: { title: string; subtitle?: string; icon?: React.ReactNode; className?: string }) {
  const { t } = useI18n();
  return (
    <header className={cn("px-5 pt-8 pb-4 animate-fade-in", className)}>
      <div className="flex items-center gap-2 text-primary mb-2">
        {icon ?? <Sparkles className="h-4 w-4" />}
        <span className="text-xs uppercase tracking-widest font-semibold">{subtitle ?? t("home.tagline")}</span>
      </div>
      <h1 className="text-3xl font-bold text-balance leading-tight">{title}</h1>
    </header>
  );
}
