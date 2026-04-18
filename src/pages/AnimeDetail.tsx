import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, Play } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

type Anime = {
  id: string; title_romaji: string; title_en: string | null; title_jp: string | null;
  cover_url: string | null; year: number | null; synopsis: string | null;
};
type Season = { id: string; season_number: number; episode_count: number };
type Episode = { id: string; episode_number: number; processing_status: string };

export default function AnimeDetail() {
  const { animeId } = useParams();
  const navigate = useNavigate();
  const [anime, setAnime] = useState<Anime | null>(null);
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [episodesBySeason, setEpisodesBySeason] = useState<Record<string, Episode[]>>({});

  useEffect(() => {
    if (!animeId) return;
    (async () => {
      const { data: a } = await supabase.from("anime").select("*").eq("id", animeId).maybeSingle();
      setAnime(a as Anime);
      const { data: s } = await supabase.from("seasons").select("id,season_number,episode_count").eq("anime_id", animeId).order("season_number");
      setSeasons((s ?? []) as Season[]);
      const map: Record<string, Episode[]> = {};
      for (const season of s ?? []) {
        const { data: eps } = await supabase
          .from("episodes")
          .select("id,episode_number,processing_status")
          .eq("season_id", season.id)
          .order("episode_number");
        map[season.id] = (eps ?? []) as Episode[];
      }
      setEpisodesBySeason(map);
    })();
  }, [animeId]);

  return (
    <div className="max-w-2xl mx-auto pb-10">
      <div className="relative">
        <div className="h-44 gradient-hero" />
        {anime?.cover_url && (
          <img src={anime.cover_url} alt="" className="absolute inset-0 h-44 w-full object-cover opacity-30" />
        )}
        <Button
          variant="ghost" size="icon"
          className="absolute top-4 left-4 bg-card/70 backdrop-blur"
          onClick={() => navigate(-1)}
        ><ChevronLeft className="h-5 w-5" /></Button>
      </div>

      <div className="px-5 -mt-16 relative">
        <div className="flex gap-4 mb-6">
          <div className="w-24 h-36 rounded-xl overflow-hidden bg-muted shadow-card flex-shrink-0">
            {anime?.cover_url && <img src={anime.cover_url} alt={anime.title_romaji} className="w-full h-full object-cover" />}
          </div>
          <div className="flex-1 pt-12">
            <h1 className="text-xl font-bold leading-tight">{anime?.title_en ?? anime?.title_romaji}</h1>
            {anime?.title_jp && <div className="font-jp text-sm text-muted-foreground">{anime.title_jp}</div>}
            <div className="text-xs text-muted-foreground mt-1">{anime?.year ?? "—"}</div>
          </div>
        </div>

        {anime?.synopsis && (
          <p className="text-sm text-muted-foreground mb-6 line-clamp-4">{anime.synopsis}</p>
        )}

        {seasons.map((season) => (
          <div key={season.id} className="mb-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Season {season.season_number}
            </h2>
            <div className="grid gap-2">
              {(episodesBySeason[season.id] ?? []).map((ep) => (
                <Card
                  key={ep.id}
                  className="p-3 gradient-card border-border/50 flex items-center justify-between cursor-pointer hover:border-primary/40 transition"
                  onClick={() => navigate(`/episode/${ep.id}`)}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-muted grid place-items-center text-sm font-semibold">
                      {ep.episode_number}
                    </div>
                    <div>
                      <div className="font-medium text-sm">Episode {ep.episode_number}</div>
                      <StatusBadge status={ep.processing_status} />
                    </div>
                  </div>
                  <Play className="h-4 w-4 text-muted-foreground" />
                </Card>
              ))}
              {(episodesBySeason[season.id] ?? []).length === 0 && (
                <div className="text-sm text-muted-foreground">No episodes listed.</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    not_processed: { label: "Not processed", cls: "bg-muted text-muted-foreground" },
    processing: { label: "Processing…", cls: "bg-warning/20 text-warning" },
    ready: { label: "Ready", cls: "bg-success/20 text-success" },
    failed: { label: "Failed", cls: "bg-destructive/20 text-destructive" },
  };
  const v = map[status] ?? map.not_processed;
  return <Badge className={`text-[10px] mt-0.5 ${v.cls} border-0`} variant="secondary">{v.label}</Badge>;
}
