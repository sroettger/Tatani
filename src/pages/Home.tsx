import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Plus, ChevronRight, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { PageHeader } from "@/components/PageHeader";
import { AddAnimeDialog } from "@/components/AddAnimeDialog";

type AnimeRow = {
  id: string;
  title_romaji: string;
  title_en: string | null;
  title_jp: string | null;
  cover_url: string | null;
  year: number | null;
  episode_count: number;
};
type LibraryEntry = { id: string; added_at: string; anime: AnimeRow; processed: number };

export default function Home() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);

  const load = async () => {
    if (!user) return;
    setLoading(true);
    const { data } = await supabase
      .from("user_anime")
      .select("id, added_at, anime:anime_id(id,title_romaji,title_en,title_jp,cover_url,year,episode_count)")
      .eq("user_id", user.id)
      .order("added_at", { ascending: false });

    const rows = (data ?? []) as any[];
    // count processed episodes per anime
    const enriched: LibraryEntry[] = await Promise.all(rows.map(async (r) => {
      const { count } = await supabase
        .from("episodes")
        .select("id, seasons!inner(anime_id)", { count: "exact", head: true })
        .eq("seasons.anime_id", r.anime.id)
        .eq("processing_status", "ready");
      return { ...r, processed: count ?? 0 };
    }));
    setLibrary(enriched);
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [user]);

  return (
    <div className="max-w-2xl mx-auto">
      <PageHeader
        title={`Welcome back${profile?.display_name ? `, ${profile.display_name.split(" ")[0]}` : ""}`}
        subtitle={profile?.jlpt_level && profile.jlpt_level !== "none" ? `Level ${profile.jlpt_level}` : "Anime Trainer"}
        icon={<Sparkles className="h-4 w-4" />}
      />

      <div className="px-5 mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Your anime</h2>
        <Button size="sm" className="gradient-primary text-primary-foreground" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4" /> Add
        </Button>
      </div>

      <div className="px-5 grid gap-3">
        {loading && <div className="text-muted-foreground text-sm">Loading…</div>}
        {!loading && library.length === 0 && (
          <Card className="p-8 text-center gradient-card border-border/50">
            <div className="text-4xl mb-2">🎬</div>
            <h3 className="font-semibold mb-1">No anime yet</h3>
            <p className="text-sm text-muted-foreground mb-4">Add your first anime to get started.</p>
            <Button onClick={() => setAddOpen(true)} className="gradient-primary text-primary-foreground">
              <Plus className="h-4 w-4" /> Add anime
            </Button>
          </Card>
        )}
        {library.map((entry) => {
          const total = entry.anime.episode_count || 0;
          const pct = total > 0 ? Math.round((entry.processed / total) * 100) : 0;
          return (
            <Card
              key={entry.id}
              className="p-3 gradient-card border-border/50 cursor-pointer hover:border-primary/40 transition-all shadow-card"
              onClick={() => navigate(`/anime/${entry.anime.id}`)}
            >
              <div className="flex gap-3">
                <div className="w-16 h-24 rounded-lg overflow-hidden bg-muted flex-shrink-0">
                  {entry.anime.cover_url ? (
                    <img src={entry.anime.cover_url} alt={entry.anime.title_romaji} className="w-full h-full object-cover" loading="lazy" />
                  ) : <div className="w-full h-full grid place-items-center text-muted-foreground text-xs">No cover</div>}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold truncate">{entry.anime.title_en ?? entry.anime.title_romaji}</div>
                  {entry.anime.title_jp && <div className="font-jp text-xs text-muted-foreground truncate">{entry.anime.title_jp}</div>}
                  <div className="text-xs text-muted-foreground mt-1">
                    {entry.processed} / {total || "?"} episodes ready
                  </div>
                  <Progress value={pct} className="h-1.5 mt-2" />
                </div>
                <ChevronRight className="h-5 w-5 text-muted-foreground self-center" />
              </div>
            </Card>
          );
        })}
      </div>

      <AddAnimeDialog open={addOpen} onOpenChange={setAddOpen} onAdded={load} />
    </div>
  );
}
