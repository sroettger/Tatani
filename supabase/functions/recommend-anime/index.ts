// Recommend anime via Lovable AI based on JLPT level + exclusions
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ANILIST_URL = "https://graphql.anilist.co";

const ANILIST_LOOKUP = `
query ($search: String) {
  Page(page: 1, perPage: 1) {
    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
      id
      idMal
      title { romaji english native }
      coverImage { large }
      seasonYear
      episodes
      description(asHtml: false)
    }
  }
}`;

type Suggestion = { title: string; reason: string };

const LEVEL_GUIDE: Record<string, string> = {
  N5: "Absolute beginner. Need anime with very simple, slow, everyday Japanese (slice-of-life for kids/families, e.g. Shirokuma Cafe, Chi's Sweet Home, Yotsuba-style).",
  N4: "Beginner. Simple slice-of-life, school comedies with clear daily-life vocabulary (e.g. Nichijou, Flying Witch, Non Non Biyori).",
  N3: "Intermediate. Standard slice-of-life, romance, light shounen with everyday speech (e.g. Toradora, Your Lie in April, Barakamon, K-On).",
  N2: "Upper-intermediate. Most mainstream anime, including drama, action, slightly technical themes (e.g. Spy x Family, Haikyuu, Erased).",
  N1: "Advanced. Complex dialogue, dense vocabulary, period pieces, politics, philosophy (e.g. Monogatari, Legend of the Galactic Heroes, Mushishi, Psycho-Pass).",
  none: "Unknown level — assume beginner-friendly slice-of-life with simple Japanese.",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: claims, error: claimsErr } = await supa.auth.getClaims(authHeader.replace("Bearer ", ""));
    if (claimsErr || !claims?.claims) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const userId = claims.claims.sub as string;

    // Get profile + library
    const [{ data: profile }, { data: libRows }] = await Promise.all([
      supa.from("profiles").select("jlpt_level").eq("user_id", userId).maybeSingle(),
      supa.from("user_anime").select("anime:anime_id(title_romaji,title_en,title_jp)").eq("user_id", userId),
    ]);
    const level = (profile?.jlpt_level ?? "none") as string;
    const ownedTitles = (libRows ?? [])
      .map((r: any) => [r.anime?.title_en, r.anime?.title_romaji, r.anime?.title_jp].filter(Boolean))
      .flat();

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      return new Response(JSON.stringify({ error: "AI not configured" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const guide = LEVEL_GUIDE[level] ?? LEVEL_GUIDE.none;
    // Group library titles by anime (en/romaji/jp variants per row)
    const libraryByAnime = (libRows ?? []).map((r: any) => {
      const a = r.anime ?? {};
      return [a.title_en, a.title_romaji, a.title_jp].filter(Boolean);
    });
    const primaryTitles = libraryByAnime.map((t) => t[0]).filter(Boolean);

    const librarySection = primaryTitles.length
      ? `The user's current library (use these as the PRIMARY signal for taste — genre, tone, themes, era, studios):
${primaryTitles.map((t) => `- ${t}`).join("\n")}`
      : `The user has no anime in their library yet — recommend broadly appealing, level-appropriate starter anime.`;

    const exclusionSection = libraryByAnime.length
      ? `Do NOT recommend any of these (already owned), nor direct sequels/prequels/spinoffs of them:
${libraryByAnime.map((titles) => `- ${titles.join(" / ")}`).join("\n")}`
      : "";

    const prompt = `Recommend 8 anime to a Japanese learner at JLPT ${level}.
Level guidance: ${guide}

${librarySection}

${exclusionSection}

Recommendation rules:
- Base picks on what the library reveals about the user's taste (genres, tone, themes, art style, era). If the library is mixed, cover the main threads.
- Stay appropriate in linguistic difficulty for JLPT ${level}.
- Prefer well-known anime easy to find on AniList (use the most common English or romaji title).
- Vary picks: don't recommend 8 near-identical shows.

For each pick, the "reason" must explicitly reference which library anime (or pattern across the library) inspired it AND note why it fits the user's level.

Return ONLY JSON in this exact shape: {"suggestions":[{"title":"...","reason":"one short sentence connecting it to their library and level"}]}.`;

    const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "You are an expert in anime and Japanese language learning. Reply with valid JSON only." },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (aiResp.status === 429) {
      return new Response(JSON.stringify({ error: "Rate limit, try again shortly." }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (aiResp.status === 402) {
      return new Response(JSON.stringify({ error: "AI credits exhausted." }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!aiResp.ok) {
      const t = await aiResp.text();
      console.error("ai error", aiResp.status, t);
      return new Response(JSON.stringify({ error: "AI error" }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const aiData = await aiResp.json();
    const content = aiData?.choices?.[0]?.message?.content ?? "{}";
    let parsed: { suggestions?: Suggestion[] } = {};
    try { parsed = JSON.parse(content); } catch { parsed = {}; }
    const suggestions = (parsed.suggestions ?? []).slice(0, 8);

    // Lookup AniList for each title to enrich with cover/ids
    const ownedSet = new Set(ownedTitles.map((t: string) => t.toLowerCase()));
    const enriched = await Promise.all(
      suggestions.map(async (s) => {
        try {
          const r = await fetch(ANILIST_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ query: ANILIST_LOOKUP, variables: { search: s.title } }),
          });
          const j = await r.json();
          const m = j?.data?.Page?.media?.[0];
          if (!m) return null;
          const titles = [m.title?.english, m.title?.romaji, m.title?.native].filter(Boolean);
          if (titles.some((t: string) => ownedSet.has(t.toLowerCase()))) return null;
          return {
            anilist_id: m.id,
            mal_id: m.idMal,
            title_romaji: m.title?.romaji ?? m.title?.english ?? s.title,
            title_en: m.title?.english ?? null,
            title_jp: m.title?.native ?? null,
            cover_url: m.coverImage?.large ?? null,
            year: m.seasonYear ?? null,
            episode_count: m.episodes ?? 0,
            synopsis: m.description?.replace(/<[^>]+>/g, "") ?? null,
            reason: s.reason,
          };
        } catch (e) {
          console.error("anilist lookup failed", s.title, e);
          return null;
        }
      }),
    );

    const results = enriched.filter(Boolean);
    return new Response(JSON.stringify({ results, level }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "unknown" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
