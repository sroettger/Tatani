// Try to auto-fetch JP subtitles from Jimaku for an episode.
// Requires JIMAKU_API_KEY (optional). If absent or not found, returns { found: false }.
import { corsHeaders } from "@supabase/supabase-js/cors";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const { episode_id } = await req.json();
    if (!episode_id) {
      return new Response(JSON.stringify({ error: "episode_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

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
    return new Response(JSON.stringify({ found: true, filename: match.name, content: text }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "unknown" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
