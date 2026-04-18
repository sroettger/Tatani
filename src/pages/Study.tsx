import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { BookOpen, ChevronRight } from "lucide-react";

type RecentEpisode = {
  episode_id: string; episode_number: number; anime_id: string; anime_title: string; new_count: number;
};

export default function Study() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [episodes, setEpisodes] = useState<RecentEpisode[]>([]);

  useEffect(() => {
    (async () => {
      if (!user) return;
      // Episodes that are ready, belong to user's library
      const { data: lib } = await supabase.from("user_anime").select("anime_id, anime:anime_id(title_romaji,title_en)").eq("user_id", user.id);
      if (!lib?.length) { setEpisodes([]); return; }
      const animeIds = lib.map((l: any) => l.anime_id);
      const titleMap: Record<string, string> = {};
      lib.forEach((l: any) => titleMap[l.anime_id] = l.anime?.title_en ?? l.anime?.title_romaji ?? "");

      const { data: eps } = await supabase
        .from("episodes")
        .select("id,episode_number,seasons!inner(anime_id)")
        .in("seasons.anime_id", animeIds)
        .eq("processing_status", "ready")
        .order("updated_at", { ascending: false })
        .limit(20);

      const { data: known } = await supabase.from("user_word_state").select("word").eq("user_id", user.id).eq("state", "known");
      const knownSet = new Set((known ?? []).map((k: any) => k.word));

      const enriched: RecentEpisode[] = await Promise.all((eps ?? []).map(async (ep: any) => {
        const { data: cache } = await supabase.from("episode_vocab_cache").select("vocab").eq("episode_id", ep.id).maybeSingle();
        const v = (cache?.vocab ?? []) as any[];
        const newCount = v.filter(x => !knownSet.has(x.word)).length;
        return {
          episode_id: ep.id,
          episode_number: ep.episode_number,
          anime_id: ep.seasons.anime_id,
          anime_title: titleMap[ep.seasons.anime_id] ?? "",
          new_count: newCount,
        };
      }));
      setEpisodes(enriched.filter(e => e.new_count > 0));
    })();
  }, [user]);

  return (
    <div className="max-w-2xl mx-auto">
      <PageHeader title="Study" subtitle="Pick an episode" icon={<BookOpen className="h-4 w-4" />} />
      <div className="px-5 grid gap-3">
        {episodes.length === 0 && (
          <Card className="p-6 text-center gradient-card border-border/50">
            <p className="text-sm text-muted-foreground">Process an episode from your library to start studying.</p>
            <Button className="mt-4 gradient-primary text-primary-foreground" onClick={() => navigate("/")}>Go home</Button>
          </Card>
        )}
        {episodes.map(ep => (
          <Card
            key={ep.episode_id}
            className="p-4 gradient-card border-border/50 cursor-pointer hover:border-primary/40 transition flex items-center justify-between"
            onClick={() => navigate(`/study/${ep.episode_id}`)}
          >
            <div>
              <div className="font-medium text-sm">{ep.anime_title}</div>
              <div className="text-xs text-muted-foreground">Episode {ep.episode_number} • {ep.new_count} new words</div>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </Card>
        ))}
      </div>
    </div>
  );
}
