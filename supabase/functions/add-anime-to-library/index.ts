// Adds an anime (and season 1 + episodes) to the shared catalog and links it to the user's library.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: claims, error: claimsErr } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
    if (claimsErr || !claims?.claims) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const userId = claims.claims.sub as string;

    const body = await req.json();
    const r = body?.anime;
    if (!r?.anilist_id || !r?.title_romaji) {
      return new Response(JSON.stringify({ error: "anime payload required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const admin = createClient(SUPABASE_URL, SERVICE);

    const { data: prof } = await admin.from("profiles").select("learning_language").eq("user_id", userId).maybeSingle();
    const learningLanguage: string = body?.learning_language ?? prof?.learning_language ?? "ja";

    // Upsert anime by anilist_id
    let animeId: string;
    const { data: existing } = await admin.from("anime").select("id").eq("anilist_id", r.anilist_id).maybeSingle();
    if (existing?.id) {
      animeId = existing.id;
    } else {
      const { data: ins, error } = await admin.from("anime").insert({
        anilist_id: r.anilist_id,
        mal_id: r.mal_id ?? null,
        title_romaji: r.title_romaji,
        title_en: r.title_en ?? null,
        title_jp: r.title_jp ?? null,
        cover_url: r.cover_url ?? null,
        year: r.year ?? null,
        season_count: 1,
        episode_count: r.episode_count ?? 0,
        synopsis: r.synopsis ?? null,
      }).select("id").single();
      if (error || !ins) {
        return new Response(JSON.stringify({ error: error?.message ?? "insert failed" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      animeId = ins.id;

      // Season 1 + episodes
      const { data: season } = await admin.from("seasons").insert({ anime_id: animeId, season_number: 1, episode_count: r.episode_count ?? 0 }).select("id").single();
      const epCount = Math.min(r.episode_count ?? 0, 200);
      if (season && epCount > 0) {
        // Try to fetch per-episode titles from Jikan (MAL) — paginated, 100 per page
        const titles: Record<number, { en: string | null; jp: string | null }> = {};
        if (r.mal_id) {
          try {
            const pages = Math.ceil(epCount / 100);
            for (let p = 1; p <= pages; p++) {
              const jr = await fetch(`https://api.jikan.moe/v4/anime/${r.mal_id}/episodes?page=${p}`);
              if (!jr.ok) break;
              const jd = await jr.json();
              for (const e of jd?.data ?? []) {
                if (typeof e?.mal_id === "number") {
                  titles[e.mal_id] = { en: e.title ?? null, jp: e.title_japanese ?? null };
                }
              }
              // Jikan rate limit: ~3 req/s
              if (p < pages) await new Promise(res => setTimeout(res, 400));
            }
          } catch (err) {
            console.warn("Jikan episode title fetch failed", err);
          }
        }
        const eps = Array.from({ length: epCount }, (_, i) => ({
          season_id: season.id,
          episode_number: i + 1,
          title_en: titles[i + 1]?.en ?? null,
          title_jp: titles[i + 1]?.jp ?? null,
        }));
        await admin.from("episodes").insert(eps);
      }
    }

    // Link to user library (idempotent)
    const { data: link, error: linkErr } = await admin
      .from("user_anime")
      .upsert({ user_id: userId, anime_id: animeId, learning_language: learningLanguage }, { onConflict: "user_id,anime_id,learning_language" })
      .select("id")
      .maybeSingle();
    if (linkErr) {
      // Fall back: insert if upsert hit a missing unique constraint
      const { error: insErr } = await admin.from("user_anime").insert({ user_id: userId, anime_id: animeId, learning_language: learningLanguage });
      if (insErr && !insErr.message.includes("duplicate")) {
        return new Response(JSON.stringify({ error: insErr.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    return new Response(JSON.stringify({ anime_id: animeId, link_id: link?.id ?? null }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "unknown" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
