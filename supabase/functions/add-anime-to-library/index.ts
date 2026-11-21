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

    // Resolve episode count when AniList returned null/0 (e.g. currently airing series or movies)
    let resolvedEpCount = Number(r.episode_count) || 0;
    if (resolvedEpCount <= 0 && r.anilist_id) {
      try {
        const ar = await fetch("https://graphql.anilist.co", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "Tatani/2.0" },
          body: JSON.stringify({
            query: `query ($id: Int) { Media(id: $id, type: ANIME) { episodes format status nextAiringEpisode { episode } } }`,
            variables: { id: Number(r.anilist_id) },
          }),
        });
        if (ar.ok) {
          const ad = await ar.json();
          const m = ad?.data?.Media;
          const aired =
            typeof m?.nextAiringEpisode?.episode === "number" && m.nextAiringEpisode.episode > 1
              ? m.nextAiringEpisode.episode - 1
              : 0;
          resolvedEpCount = m?.episodes ?? (aired > 0 ? aired : m?.format === "MOVIE" ? 1 : 0);
        }
      } catch (err) {
        console.warn("AniList episode fallback lookup failed", err);
      }
    }

    // Upsert anime by anilist_id
    let animeId: string;
    let effectiveMalId: number | null = r.mal_id ?? null;
    const { data: existing } = await admin
      .from("anime")
      .select("id, episode_count, mal_id")
      .eq("anilist_id", r.anilist_id)
      .maybeSingle();

    if (existing?.id) {
      animeId = existing.id;
      effectiveMalId = existing.mal_id ?? effectiveMalId;
    } else {
      const insertPayload = {
        anilist_id: r.anilist_id,
        mal_id: effectiveMalId,
        title_romaji: r.title_romaji,
        title_en: r.title_en ?? null,
        title_jp: r.title_jp ?? null,
        cover_url: r.cover_url ?? null,
        year: r.year ?? null,
        season_count: 1,
        episode_count: resolvedEpCount,
        synopsis: r.synopsis ?? null,
      };
      let { data: ins, error } = await admin.from("anime").insert(insertPayload).select("id").single();
      if (error && effectiveMalId !== null && error.message?.includes("mal_id")) {
        // Split-cour AniList entries can share a MAL ID; retry without unique mal_id collision
        const retry = await admin.from("anime").insert({ ...insertPayload, mal_id: null }).select("id").single();
        ins = retry.data;
        error = retry.error;
      }
      if (error || !ins) {
        return new Response(JSON.stringify({ error: error?.message ?? "insert failed" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      animeId = ins.id;
    }

    // Always ensure Season 1 and at least 1..epCount episodes exist (repairs any 0-episode catalog rows too)
    const seasonLookup = await admin
      .from("seasons")
      .select("id, episode_count")
      .eq("anime_id", animeId)
      .eq("season_number", 1)
      .maybeSingle();
    if (seasonLookup.error) {
      return new Response(JSON.stringify({ error: seasonLookup.error.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    let season = seasonLookup.data;
    if (!season) {
      const { data: createdSeason, error: seasonInsErr } = await admin
        .from("seasons")
        .insert({ anime_id: animeId, season_number: 1, episode_count: resolvedEpCount })
        .select("id, episode_count")
        .single();
      if (seasonInsErr || !createdSeason) {
        return new Response(JSON.stringify({ error: seasonInsErr?.message ?? "season insert failed" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      season = createdSeason;
    }

    const { count: existingEpCount } = await admin
      .from("episodes")
      .select("id", { count: "exact", head: true })
      .eq("season_id", season.id);

    if ((existingEpCount ?? 0) === 0) {
      const titles: Record<number, { en: string | null; jp: string | null }> = {};
      let maxJikanEp = 0;
      if (effectiveMalId) {
        try {
          const initialPages = Math.max(1, Math.min(2, Math.ceil((resolvedEpCount || 100) / 100)));
          for (let p = 1; p <= initialPages; p++) {
            const jr = await fetch(`https://api.jikan.moe/v4/anime/${effectiveMalId}/episodes?page=${p}`);
            if (!jr.ok) break;
            const jd = await jr.json();
            const totalItems = Number(jd?.pagination?.items?.total) || 0;
            if (totalItems > maxJikanEp) maxJikanEp = totalItems;
            for (const e of jd?.data ?? []) {
              if (typeof e?.mal_id === "number") {
                if (e.mal_id > maxJikanEp) maxJikanEp = e.mal_id;
                titles[e.mal_id] = { en: e.title ?? null, jp: e.title_japanese ?? null };
              }
            }
            if (!jd?.pagination?.has_next_page) break;
            if (p < initialPages) await new Promise((res) => setTimeout(res, 400));
          }
        } catch (err) {
          console.warn("Jikan episode title fetch failed", err);
        }
      }

      const finalCatalogTotal = Math.max(resolvedEpCount, maxJikanEp, 1);
      const epCount = Math.min(finalCatalogTotal, 200);
      const eps = Array.from({ length: epCount }, (_, i) => ({
        season_id: season.id,
        episode_number: i + 1,
        title_en: titles[i + 1]?.en ?? null,
        title_jp: titles[i + 1]?.jp ?? null,
      }));
      const { error: epInsErr } = await admin
        .from("episodes")
        .upsert(eps, { onConflict: "season_id,episode_number" });
      if (epInsErr) {
        return new Response(JSON.stringify({ error: epInsErr.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if ((existing?.episode_count ?? 0) < finalCatalogTotal) {
        await admin.from("anime").update({ episode_count: finalCatalogTotal }).eq("id", animeId);
      }
      if ((season.episode_count ?? 0) < finalCatalogTotal) {
        await admin.from("seasons").update({ episode_count: finalCatalogTotal }).eq("id", season.id);
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
