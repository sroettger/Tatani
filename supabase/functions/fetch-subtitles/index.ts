// Auto-fetch subtitles for an episode across multiple providers.
// Jimaku / Kitsunekko Mirror (Japanese) + OpenSubtitles / SubDL / Podnapisi (all languages).
import {
  corsHeaders,
  createAdminClient,
  jsonResponse,
  requireAuthUser,
} from "../_shared/auth.ts";
import { getUserLanguages, langInfo } from "../_shared/languages.ts";
import { providersFor } from "./providers.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const auth = await requireAuthUser(req);
    if (auth instanceof Response) return auth;
    const { userId } = auth;

    const { episode_id, language } = (await req.json()) as {
      episode_id?: unknown;
      language?: unknown;
    };
    if (typeof episode_id !== "string" || !episode_id.trim()) {
      return jsonResponse({ error: "episode_id required" }, 400);
    }

    const supabase = createAdminClient();
    const { learning: profileLearning } = await getUserLanguages(supabase, userId);
    const learning = typeof language === "string" && language ? langInfo(language) : profileLearning;

    const { data: ep, error } = await supabase
      .from("episodes")
      .select("id, episode_number, season_id, seasons(season_number, anime(title_romaji, title_en, title_jp, anilist_id, mal_id))")
      .eq("id", episode_id)
      .maybeSingle();
    if (error || !ep) return jsonResponse({ error: "episode not found" }, 404);

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
          return jsonResponse({
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

    return jsonResponse({ found: false, reason: "no_match", language: learning.code, attempts });
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});
