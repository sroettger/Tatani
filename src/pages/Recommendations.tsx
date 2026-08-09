import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Sparkles, Plus, RefreshCw, Loader2, Tv } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { PageHeader } from "@/components/PageHeader";
import { toast } from "sonner";
import { Link } from "react-router-dom";
import { useI18n } from "@/i18n";
import { formatLevel } from "@/lib/languages";

type Recommendation = {
  anilist_id: number;
  mal_id: number | null;
  title_romaji: string;
  title_en: string | null;
  title_jp: string | null;
  cover_url: string | null;
  year: number | null;
  episode_count: number;
  synopsis: string | null;
  streaming: string[];
  reason: string;
};

type Platform = "crunchyroll" | "netflix";

export default function Recommendations() {
  const { user, profile, progress } = useAuth();
  const { t } = useI18n();
  const [items, setItems] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState<number | null>(null);
  const [filters, setFilters] = useState<Set<Platform>>(new Set());

  const country = (profile as any)?.country as string | null | undefined;
  const netflixLabel = country ? t("rec.netflixWithCountry", { country }) : t("rec.netflix");

  const load = async (overrideFilters?: Set<Platform>) => {
    if (!user) return;
    const f = overrideFilters ?? filters;
    setLoading(true);
    const { data, error } = await supabase.functions.invoke("recommend-anime", {
      body: { streaming_filters: Array.from(f) },
    });
    setLoading(false);
    if (error) {
      toast.error(t("rec.loadFailed"), { description: error.message });
      return;
    }
    if (data?.error) {
      toast.error(t("rec.loadFailed"), { description: data.error });
      return;
    }
    setItems(data?.results ?? []);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [user]);

  const toggleFilter = (p: Platform) => {
    const next = new Set(filters);
    if (next.has(p)) next.delete(p); else next.add(p);
    setFilters(next);
    load(next);
  };

  const add = async (r: Recommendation) => {
    setAdding(r.anilist_id);
    const { data, error } = await supabase.functions.invoke("add-anime-to-library", { body: { anime: r } });
    setAdding(null);
    if (error || data?.error) {
      toast.error(t("rec.addFailed"), { description: error?.message ?? data?.error });
      return;
    }
    toast.success(t("rec.added"));
    setItems(prev => prev.filter(x => x.anilist_id !== r.anilist_id));
  };

  const level = progress?.level && progress.level !== "none" ? t("rec.levelLabel", { level: formatLevel(progress.level) }) : t("rec.title");

  return (
    <div className="max-w-2xl mx-auto">
      <PageHeader
        title={t("rec.title")}
        subtitle={level}
        icon={<Sparkles className="h-4 w-4" />}
      />

      <div className="px-5 mb-3 flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t("rec.picksTitle")}</h2>
        <Button size="sm" variant="outline" onClick={() => load()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {t("rec.refresh")}
        </Button>
      </div>

      <div className="px-5 mb-4 flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
          <Tv className="h-3.5 w-3.5" /> {t("rec.streaming")}
        </span>
        <Button
          size="sm"
          variant={filters.has("crunchyroll") ? "default" : "outline"}
          onClick={() => toggleFilter("crunchyroll")}
          disabled={loading}
          className="h-7 px-2 text-xs"
        >
          Crunchyroll
        </Button>
        <Button
          size="sm"
          variant={filters.has("netflix") ? "default" : "outline"}
          onClick={() => toggleFilter("netflix")}
          disabled={loading}
          className="h-7 px-2 text-xs"
        >
          {netflixLabel}
        </Button>
        {!country && (
          <Link to="/settings" className="text-[11px] text-muted-foreground underline ml-1">
            {t("rec.setCountry")}
          </Link>
        )}
      </div>
      {filters.has("netflix") && (
        <p className="px-5 -mt-2 mb-3 text-[11px] text-muted-foreground">
          {t("rec.netflixNote")}
        </p>
      )}

      <div className="px-5 grid gap-3 pb-4">
        {loading && items.length === 0 && (
          <Card className="p-8 text-center gradient-card border-border/50">
            <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2 text-primary" />
            <p className="text-sm text-muted-foreground">{t("rec.findingTitle")}</p>
          </Card>
        )}
        {!loading && items.length === 0 && (
          <Card className="p-8 text-center gradient-card border-border/50">
            <div className="text-4xl mb-2">✨</div>
            <h3 className="font-semibold mb-1">{t("rec.noneTitle")}</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {filters.size ? t("rec.noneFilterBody") : t("rec.noneBody")}
            </p>
            <Button onClick={() => load()} className="gradient-primary text-primary-foreground">
              <RefreshCw className="h-4 w-4" /> {t("rec.generate")}
            </Button>
          </Card>
        )}
        {items.map((r) => (
          <Card key={r.anilist_id} className="p-3 gradient-card border-border/50 shadow-card">
            <div className="flex gap-3">
              <div className="w-16 h-24 rounded-lg overflow-hidden bg-muted flex-shrink-0">
                {r.cover_url ? (
                  <img src={r.cover_url} alt={r.title_romaji} className="w-full h-full object-cover" loading="lazy" />
                ) : <div className="w-full h-full grid place-items-center text-muted-foreground text-xs">{t("home.noCover")}</div>}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold truncate">{r.title_en ?? r.title_romaji}</div>
                {r.title_jp && <div className="font-jp text-xs text-muted-foreground truncate">{r.title_jp}</div>}
                <div className="text-xs text-muted-foreground mt-1">
                  {r.year ?? "—"} • {r.episode_count || "?"} eps
                </div>
                {r.streaming?.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {r.streaming.includes("crunchyroll") && (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Crunchyroll</Badge>
                    )}
                    {r.streaming.includes("netflix") && (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Netflix</Badge>
                    )}
                  </div>
                )}
                <p className="text-xs text-foreground/80 mt-2 line-clamp-3">{r.reason}</p>
              </div>
            </div>
            <div className="mt-3 flex justify-end">
              <Button
                size="sm"
                onClick={() => add(r)}
                disabled={adding === r.anilist_id}
                className="gradient-primary text-primary-foreground"
              >
                {adding === r.anilist_id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {t("rec.addToLibrary")}
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
