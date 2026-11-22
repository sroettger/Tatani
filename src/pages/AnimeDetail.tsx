import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, Play } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/i18n";
import type { StringKey } from "@/i18n/strings";
import { fetchAllPages, fetchBatchedPages } from "@/lib/supabase-pagination";

type Anime = {
  id: string;
  title_romaji: string;
  title_en: string | null;
  title_jp: string | null;
  cover_url: string | null;
  year: number | null;
  synopsis: string | null;
};
type Season = { id: string; season_number: number; episode_count: number };
type Episode = {
  id: string;
  season_id: string;
  episode_number: number;
  processing_status: string;
  title_en: string | null;
  title_jp: string | null;
};

export default function AnimeDetail() {
  const { animeId } = useParams();
  const navigate = useNavigate();
  const { learningLanguage, learningLanguageInfo } = useAuth();
  const { t } = useI18n();
  const [anime, setAnime] = useState<Anime | null>(null);
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [episodesBySeason, setEpisodesBySeason] = useState<Record<string, Episode[]>>({});

  useEffect(() => {
    if (!animeId) return;
    let cancelled = false;
    (async () => {
      const [{ data: a }, { data: s }] = await Promise.all([
        supabase.from("anime").select("*").eq("id", animeId).maybeSingle(),
        supabase.from("seasons").select("id,season_number,episode_count").eq("anime_id", animeId).order("season_number"),
      ]);
      if (cancelled) return;

      const seasonList = (s ?? []) as Season[];
      setAnime((a as Anime | null) ?? null);
      setSeasons(seasonList);

      const seasonIds = seasonList.map((season) => season.id);
      const map: Record<string, Episode[]> = {};
      for (const sid of seasonIds) {
        map[sid] = [];
      }

      if (seasonIds.length > 0) {
        const { data: allEps } = await fetchAllPages<Episode>((from, to) =>
          supabase
            .from("episodes")
            .select("id,season_id,episode_number,processing_status,title_en,title_jp")
            .in("season_id", seasonIds)
            .order("season_id", { ascending: true })
            .order("episode_number", { ascending: true })
            .range(from, to),
        );
        if (cancelled) return;

        const epIds = allEps.map((ep) => ep.id);
        const cachedEpIds = new Set<string>();
        if (epIds.length > 0) {
          const { data: cachedRows } = await fetchBatchedPages<string, { episode_id: string }>(
            epIds,
            200,
            (slice, from, to) =>
              supabase
                .from("episode_vocab_cache")
                .select("episode_id")
                .in("episode_id", slice)
                .eq("language", learningLanguage)
                .order("episode_id", { ascending: true })
                .range(from, to),
          );
          for (const row of cachedRows) {
            cachedEpIds.add(row.episode_id);
          }
        }
        if (cancelled) return;

        for (const ep of allEps) {
          const effectiveStatus = cachedEpIds.has(ep.id)
            ? "ready"
            : ep.processing_status === "processing" || ep.processing_status === "failed"
              ? ep.processing_status
              : "not_processed";
          if (!map[ep.season_id]) map[ep.season_id] = [];
          map[ep.season_id].push({
            ...ep,
            processing_status: effectiveStatus,
          });
        }
      }

      setEpisodesBySeason(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [animeId, learningLanguage]);

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
            {anime?.title_jp && learningLanguageInfo.hasRuby && <div className="font-jp text-sm text-muted-foreground">{anime.title_jp}</div>}
            <div className="text-xs text-muted-foreground mt-1">{anime?.year ?? "—"}</div>
          </div>
        </div>

        {anime?.synopsis && (
          <p className="text-sm text-muted-foreground mb-6 line-clamp-4">{anime.synopsis}</p>
        )}

        {seasons.map((season) => (
          <div key={season.id} className="mb-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              {t("anime.season", { n: season.season_number })}
            </h2>
            <div className="grid gap-2">
              {(episodesBySeason[season.id] ?? []).map((ep) => (
                <Card
                  key={ep.id}
                  className="p-3 gradient-card border-border/50 flex items-center justify-between cursor-pointer hover:border-primary/40 transition"
                  onClick={() => navigate(`/episode/${ep.id}`)}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="w-10 h-10 rounded-lg bg-muted grid place-items-center text-sm font-semibold flex-shrink-0">
                      {ep.episode_number}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-sm truncate">
                        {ep.title_en ?? (learningLanguageInfo.hasRuby ? ep.title_jp : null) ?? t("anime.episodeFallback", { n: ep.episode_number })}
                      </div>
                      {ep.title_jp && learningLanguageInfo.hasRuby && (
                        <div className="font-jp text-[11px] text-muted-foreground truncate">{ep.title_jp}</div>
                      )}
                      <StatusBadge status={ep.processing_status} t={t} />
                    </div>
                  </div>
                  <Play className="h-4 w-4 text-muted-foreground" />
                </Card>
              ))}
              {(episodesBySeason[season.id] ?? []).length === 0 && (
                <div className="text-sm text-muted-foreground">{t("anime.noEpisodes")}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusBadge({ status, t }: { status: string; t: (k: StringKey, vars?: Record<string, string | number>) => string }) {
  const map: Record<string, { label: string; cls: string }> = {
    not_processed: { label: t("anime.statusNotProcessed"), cls: "bg-muted text-muted-foreground" },
    processing: { label: t("anime.statusProcessing"), cls: "bg-warning/20 text-warning" },
    ready: { label: t("anime.statusReady"), cls: "bg-success/20 text-success" },
    failed: { label: t("anime.statusFailed"), cls: "bg-destructive/20 text-destructive" },
  };
  const v = map[status] ?? map.not_processed;
  return <Badge className={`text-[10px] mt-0.5 ${v.cls} border-0`} variant="secondary">{v.label}</Badge>;
}
