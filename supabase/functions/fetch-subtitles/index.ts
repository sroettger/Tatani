// Try to auto-fetch subtitles for an episode. Only Japanese is supported via
// Jimaku today; other learning languages fall back to manual upload in the UI.
// Requires JIMAKU_API_KEY (optional). If absent or not found, returns { found: false }.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getUserLanguages } from "../_shared/languages.ts";

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
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "", { global: { headers: { Authorization: authHeader } } });
    const { data: claims, error: claimsErr } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
    if (claimsErr || !claims?.claims) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const userId = claims.claims.sub as string;

    const { episode_id } = await req.json();
    if (!episode_id) {
      return new Response(JSON.stringify({ error: "episode_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    const { learning } = await getUserLanguages(supabase, userId);

    // Jimaku only hosts Japanese subtitles. For other learning languages, the UI
    // should fall back to manual subtitle upload.
    if (learning.code !== "ja") {
      return new Response(JSON.stringify({ found: false, reason: "unsupported_language", language: learning.code }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Look up episode + anime context
    const { data: ep, error } = await supabase
      .from("episodes")
      .select("id, episode_number, season_id, seasons(season_number, anime(title_romaji, title_en, anilist_id, mal_id))")
      .eq("id", episode_id)
      .maybeSingle();
    if (error || !ep) {
      return new Response(JSON.stringify({ error: "episode not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const JIMAKU_KEY = Deno.env.get("JIMAKU_API_KEY");
    if (!JIMAKU_KEY) {
      return new Response(JSON.stringify({ found: false, reason: "no_jimaku_key" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const animeRow: any = (ep as any).seasons?.anime;
    const title = animeRow?.title_romaji || animeRow?.title_en || "";
    const anilistId = animeRow?.anilist_id;

    // Search Jimaku entries
    const searchUrl = anilistId
      ? `https://jimaku.cc/api/entries/search?anilist_id=${anilistId}`
      : `https://jimaku.cc/api/entries/search?query=${encodeURIComponent(title)}`;
    const sr = await fetch(searchUrl, { headers: { Authorization: JIMAKU_KEY } });
    if (!sr.ok) {
      return new Response(JSON.stringify({ found: false, reason: "jimaku_search_failed" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const entries = await sr.json();
    if (!Array.isArray(entries) || entries.length === 0) {
      return new Response(JSON.stringify({ found: false, reason: "no_entries" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const entryId = entries[0].id;
    const fr = await fetch(`https://jimaku.cc/api/entries/${entryId}/files`, {
      headers: { Authorization: JIMAKU_KEY },
    });
    if (!fr.ok) {
      return new Response(JSON.stringify({ found: false, reason: "jimaku_files_failed" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const files = await fr.json();
    const epNum = (ep as any).episode_number;
    const padded = String(epNum).padStart(2, "0");
    const match = files.find((f: any) =>
      typeof f.name === "string" &&
      (f.name.includes(`E${padded}`) || f.name.includes(` ${padded} `) || f.name.includes(`-${padded}`) || f.name.includes(`_${padded}`))
    ) || files[0];
    if (!match?.url) {
      return new Response(JSON.stringify({ found: false, reason: "no_file_match" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const dl = await fetch(match.url);
    const text = await dl.text();
    return new Response(JSON.stringify({ found: true, filename: match.name, content: text, language: learning.code }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "unknown" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
