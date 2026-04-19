// Backfills episode titles from Jikan (MAL) for anime where they're missing.
// Admin-only.
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
    const { data: claims } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
    const userId = claims?.claims?.sub as string | undefined;
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const admin = createClient(SUPABASE_URL, SERVICE);

    // Find anime with missing episode titles
    const { data: anime } = await admin.from("anime").select("id, title_romaji, mal_id").not("mal_id", "is", null);
    let updated = 0;
    const summary: Array<{ anime: string; updated: number; skipped?: string }> = [];

    for (const a of anime ?? []) {
      const { data: seasons } = await admin.from("seasons").select("id").eq("anime_id", a.id);
      const seasonIds = (seasons ?? []).map(s => s.id);
      if (seasonIds.length === 0) continue;
      const { data: missingEps } = await admin
        .from("episodes")
        .select("id, episode_number")
        .in("season_id", seasonIds)
        .is("title_en", null)
        .is("title_jp", null);
      if (!missingEps || missingEps.length === 0) continue;

      const maxEp = Math.max(...missingEps.map(e => e.episode_number));
      const titles: Record<number, { en: string | null; jp: string | null }> = {};
      const pages = Math.ceil(maxEp / 100);
      let fetched = 0;
      try {
        for (let p = 1; p <= pages; p++) {
          const jr = await fetch(`https://api.jikan.moe/v4/anime/${a.mal_id}/episodes?page=${p}`);
          if (!jr.ok) break;
          const jd = await jr.json();
          for (const e of jd?.data ?? []) {
            if (typeof e?.mal_id === "number") {
              titles[e.mal_id] = { en: e.title ?? null, jp: e.title_japanese ?? null };
              fetched++;
            }
          }
          await new Promise(res => setTimeout(res, 400));
        }
      } catch (err) {
        summary.push({ anime: a.title_romaji, updated: 0, skipped: String(err) });
        continue;
      }

      let count = 0;
      for (const ep of missingEps) {
        const t = titles[ep.episode_number];
        if (!t || (!t.en && !t.jp)) continue;
        const { error } = await admin.from("episodes").update({ title_en: t.en, title_jp: t.jp }).eq("id", ep.id);
        if (!error) count++;
      }
      updated += count;
      summary.push({ anime: a.title_romaji, updated: count });
    }

    return new Response(JSON.stringify({ total_updated: updated, summary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "unknown" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
