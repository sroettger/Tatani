// Auto-fetch subtitles for an episode across multiple providers.
// Jimaku (Japanese) + OpenSubtitles / SubDL / Podnapisi (all languages).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getUserLanguages, langInfo } from "../_shared/languages.ts";
import { providersFor } from "./providers.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(
      SUPABASE_URL,
      Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: claims, error: claimsErr } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
    if (claimsErr || !claims?.claims) return json({ error: "Unauthorized" }, 401);
    const userId = claims.claims.sub as string;

    const { episode_id, language } = await req.json();
    if (!episode_id) return json({ error: "episode_id required" }, 400);

    const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { learning: profileLearning } = await getUserLanguages(supabase, userId);
    // Optional override, mainly for testing a specific subtitle language.
    const learning = typeof language === "string" && language ? langInfo(language) : profileLearning;


    const { data: ep, error } = await supabase
      .from("episodes")
      .select("id, episode_number, season_id, seasons(season_number, anime(title_romaji, title_en, title_jp, anilist_id, mal_id))")
      .eq("id", episode_id)
      .maybeSingle();
    if (error || !ep) return json({ error: "episode not found" }, 404);

    type NestedAnime = {
      title_romaji?: string | null;
      title_en?: string | null;
      title_jp?: string | null;
      anilist_id?: number | null;
      mal_id?: number | null;
    };
    type NestedSeason = { season_number?: number | null; anime?: NestedAnime | null };
    const seasonObj = (ep as { seasons?: NestedSeason | null }).seasons;
    const animeRow = seasonObj?.anime;
    const ctx = {
      lang: learning.subtitleLang,
      titleRomaji: animeRow?.title_romaji ?? "",
      titleEn: animeRow?.title_en ?? "",
      titleJp: animeRow?.title_jp ?? "",
      anilistId: animeRow?.anilist_id ?? null,
      malId: animeRow?.mal_id ?? null,
      season: seasonObj?.season_number ?? 1,
      episode: (ep as { episode_number?: number | null }).episode_number ?? 1,
    };

    const attempts: { provider: string; result: string }[] = [];
    for (const provider of providersFor(learning.subtitleLang)) {
      try {
        const hit = await provider.run(ctx);
        if (hit) {
          console.log(`subtitles found via ${provider.name} for episode ${episode_id}`);
          return json({
            found: true,
            filename: hit.filename,
            content: hit.content,
            provider: hit.provider,
            language: learning.code,
            attempts,
          });
        }
        attempts.push({ provider: provider.name, result: "no_match" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "error";
        console.warn(`provider ${provider.name} failed: ${msg}`);
        attempts.push({ provider: provider.name, result: msg });
      }
    }

    return json({ found: false, reason: "no_match", language: learning.code, attempts });
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});
