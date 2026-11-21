// Recommend anime via Gemini API based on JLPT/CEFR level + library exclusions
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callAiChatCompletions, getAiApiKey } from "../_shared/ai.ts";
import { getUserLanguages, uiLanguageName } from "../_shared/languages.ts";

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
      externalLinks { site url language }
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
  A1: "Absolute beginner. Very simple, slow, everyday dialogue (slice-of-life for kids/families).",
  A2: "Beginner. Simple slice-of-life, school comedies with clear daily-life vocabulary.",
  B1: "Intermediate. Standard slice-of-life, romance, light shounen with everyday speech.",
  B2: "Upper-intermediate. Most mainstream anime, including drama, action, slightly technical themes.",
  C1: "Advanced. Complex dialogue, dense vocabulary, period pieces, politics, philosophy.",
  C2: "Near-native. Complex, literary, or highly idiomatic dialogue.",
  none: "Unknown level — assume beginner-friendly slice-of-life with simple dialogue.",
};

// Map AniList externalLinks into normalized streaming platform tags.
// AniList's externalLinks doesn't expose a reliable country code, so Netflix
// regional availability is best-effort (presence of a Netflix link only).
function extractStreaming(links: Array<{ site?: string; url?: string; language?: string }> | null | undefined) {
  const out = new Set<string>();
  for (const l of links ?? []) {
    const site = (l?.site ?? "").toLowerCase();
    if (site.includes("crunchyroll")) out.add("crunchyroll");
    if (site.includes("netflix")) out.add("netflix");
  }
  return Array.from(out);
}

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

    // Optional body: { streaming_filters: ["crunchyroll","netflix"] }
    let streamingFilters: string[] = [];
    try {
      const body = await req.json();
      if (Array.isArray(body?.streaming_filters)) {
        streamingFilters = body.streaming_filters
          .filter((s: unknown) => typeof s === "string")
          .map((s: string) => s.toLowerCase());
      }
    } catch { /* no body */ }

    // Get profile + library
    const { learning, uiLanguage, level } = await getUserLanguages(supa, userId);
    const [{ data: profile }, { data: libRows }] = await Promise.all([
      supa.from("profiles").select("country").eq("user_id", userId).maybeSingle(),
      supa
        .from("user_anime")
        .select("anime:anime_id(title_romaji,title_en,title_jp)")
        .eq("user_id", userId)
        .eq("learning_language", learning.code),
    ]);
    const nativeLang = uiLanguageName(uiLanguage);
    const country = (profile?.country ?? null) as string | null;
    const ownedTitles = (libRows ?? [])
      .map((r: any) => [r.anime?.title_en, r.anime?.title_romaji, r.anime?.title_jp].filter(Boolean))
      .flat();

    let aiApiKey: string;
    try {
      aiApiKey = getAiApiKey();
    } catch {
      return new Response(JSON.stringify({ error: "AI not configured (set GEMINI_API_KEY)" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const guide = LEVEL_GUIDE[level] ?? LEVEL_GUIDE.none;
    const scaleLabel = learning.scale === "jlpt" ? "JLPT" : "CEFR";
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

    // Ask for more candidates when filtering, since some won't match the platform.
    const wantCount = streamingFilters.length ? 16 : 8;

    const prompt = `Recommend ${wantCount} anime (dubbed or subtitled in ${learning.name}, or originally in ${learning.name}) to a ${learning.name} learner at ${scaleLabel} ${level}.
Level guidance: ${guide}

${librarySection}

${exclusionSection}

Recommendation rules:
- Base picks on what the library reveals about the user's taste (genres, tone, themes, art style, era). If the library is mixed, cover the main threads.
- Stay appropriate in linguistic difficulty for ${scaleLabel} ${level}.
- Prefer well-known anime easy to find on AniList (use the most common English or romaji title).
- Vary picks: don't recommend ${wantCount} near-identical shows.

For each pick, the "reason" must explicitly reference which library anime (or pattern across the library) inspired it AND note why it fits the user's level.

Write every "reason" in ${nativeLang}.

Return ONLY JSON in this exact shape: {"suggestions":[{"title":"...","reason":"one short sentence connecting it to their library and level"}]}.`;

    const aiResp = await callAiChatCompletions({
      model: "gemini-2.5-flash",
      messages: [
        { role: "system", content: `You are an expert in anime and ${learning.name} language learning. Reply with valid JSON only.` },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
    }, aiApiKey);

    if (aiResp.status === 429) {
      return new Response(JSON.stringify({ error: "Rate limit, try again shortly." }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (aiResp.status === 402) {
      return new Response(JSON.stringify({ error: "AI quota exhausted." }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
    const suggestions = (parsed.suggestions ?? []).slice(0, wantCount);

    // Lookup AniList for each title to enrich with cover/ids/streaming
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
          const streaming = extractStreaming(m.externalLinks);
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
            streaming,
            reason: s.reason,
          };
        } catch (e) {
          console.error("anilist lookup failed", s.title, e);
          return null;
        }
      }),
    );

    let results = enriched.filter(Boolean) as Array<{ streaming: string[] }>;
    if (streamingFilters.length) {
      results = results.filter((r) => streamingFilters.some((f) => r.streaming.includes(f)));
    }
    // Cap final results so UI stays manageable
    results = results.slice(0, 8);

    return new Response(JSON.stringify({ results, level, country }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "unknown" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
