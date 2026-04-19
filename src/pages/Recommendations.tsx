import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Sparkles, Plus, RefreshCw, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { PageHeader } from "@/components/PageHeader";
import { toast } from "sonner";

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
  reason: string;
};

export default function Recommendations() {
  const { user, profile } = useAuth();
  const [items, setItems] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState<number | null>(null);

  const load = async () => {
    if (!user) return;
    setLoading(true);
    const { data, error } = await supabase.functions.invoke("recommend-anime", { body: {} });
    setLoading(false);
    if (error) {
      toast.error("Couldn't load recommendations", { description: error.message });
      return;
    }
    if (data?.error) {
      toast.error("Couldn't load recommendations", { description: data.error });
      return;
    }
    setItems(data?.results ?? []);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [user]);

  const add = async (r: Recommendation) => {
    setAdding(r.anilist_id);
    const { data, error } = await supabase.functions.invoke("add-anime-to-library", { body: { anime: r } });
    setAdding(null);
    if (error || data?.error) {
      toast.error("Couldn't add", { description: error?.message ?? data?.error });
      return;
    }
    toast.success("Added to your library");
    setItems(prev => prev.filter(x => x.anilist_id !== r.anilist_id));
  };

  const level = profile?.jlpt_level && profile.jlpt_level !== "none" ? `Level ${profile.jlpt_level}` : "For you";

  return (
    <div className="max-w-2xl mx-auto">
      <PageHeader
        title="Recommended for you"
        subtitle={level}
        icon={<Sparkles className="h-4 w-4" />}
      />

      <div className="px-5 mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Picks based on your level</h2>
        <Button size="sm" variant="outline" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      </div>

      <div className="px-5 grid gap-3 pb-4">
        {loading && items.length === 0 && (
          <Card className="p-8 text-center gradient-card border-border/50">
            <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2 text-primary" />
            <p className="text-sm text-muted-foreground">Finding anime for your level…</p>
          </Card>
        )}
        {!loading && items.length === 0 && (
          <Card className="p-8 text-center gradient-card border-border/50">
            <div className="text-4xl mb-2">✨</div>
            <h3 className="font-semibold mb-1">No recommendations yet</h3>
            <p className="text-sm text-muted-foreground mb-4">Try refreshing to generate new picks.</p>
            <Button onClick={load} className="gradient-primary text-primary-foreground">
              <RefreshCw className="h-4 w-4" /> Generate
            </Button>
          </Card>
        )}
        {items.map((r) => (
          <Card key={r.anilist_id} className="p-3 gradient-card border-border/50 shadow-card">
            <div className="flex gap-3">
              <div className="w-16 h-24 rounded-lg overflow-hidden bg-muted flex-shrink-0">
                {r.cover_url ? (
                  <img src={r.cover_url} alt={r.title_romaji} className="w-full h-full object-cover" loading="lazy" />
                ) : <div className="w-full h-full grid place-items-center text-muted-foreground text-xs">No cover</div>}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold truncate">{r.title_en ?? r.title_romaji}</div>
                {r.title_jp && <div className="font-jp text-xs text-muted-foreground truncate">{r.title_jp}</div>}
                <div className="text-xs text-muted-foreground mt-1">
                  {r.year ?? "—"} • {r.episode_count || "?"} eps
                </div>
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
                Add to library
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
