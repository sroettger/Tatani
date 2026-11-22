// Recommend anime via Gemini API based on JLPT/CEFR level + library exclusions
import {
  corsHeaders,
  createAdminClient,
  jsonResponse,
  requireAuthUser,
} from "../_shared/auth.ts";
import { callAiChatCompletions, DEFAULT_AI_MODEL, getAiApiKey } from "../_shared/ai.ts";
import { getUserLanguages, uiLanguageName } from "../_shared/languages.ts";

const ANILIST_URL = "https://graphql.anilist.co";
const ANILIST_ALIAS_BATCH_SIZE = 8;

type Suggestion = { title: string; reason: string };

type LibraryAnimeJoin = {
  anime?: {
    title_romaji?: string | null;
    title_en?: string | null;
    title_jp?: string | null;
  } | null;
};

type AniListExternalLink = {
  site?: string | null;
  url?: string | null;
  language?: string | null;
};

type AniListMediaNode = {
  id: number;
  idMal?: number | null;
  title?: { romaji?: string | null; english?: string | null; native?: string | null } | null;
  coverImage?: { large?: string | null } | null;
  seasonYear?: number | null;
  episodes?: number | null;
  description?: string | null;
  externalLinks?: AniListExternalLink[] | null;
};

type RecommendedAnimeItem = {
  anilist_id: number;
  mal_id: number | null;
  title_romaji: string;
  title_en: string | null;
  title_jp: string | null;
  cover_url: string | null;
  year: number | null;
  episode_count: number;
  synopsis: string | null;
  streaming: string[];
  reason: string;
};

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

function extractStreaming(links: AniListExternalLink[] | null | undefined): string[] {
  const out = new Set<string>();
  for (const l of links ?? []) {
    const site = (l?.site ?? "").toLowerCase();
    if (site.includes("crunchyroll")) out.add("crunchyroll");
    if (site.includes("netflix")) out.add("netflix");
  }
  return Array.from(out);
}

/**
 * Batch up to 8 AniList title searches into a single GraphQL request using parameterized aliases
 * (`q0: Page(...)`, `q1: Page(...)`, ...), keeping 16 suggestions to at most 2 HTTP POSTs.
 */
async function batchLookupAniList(batch: Suggestion[]): Promise<Array<AniListMediaNode | null>> {
  if (batch.length === 0) return [];
  const varDefs = batch.map((_, idx) => `$s${idx}: String`).join(", ");
  const fields = batch
    .map(
      (_, idx) => `
    q${idx}: Page(page: 1, perPage: 1) {
      media(search: $s${idx}, type: ANIME, sort: SEARCH_MATCH) {
        id
        idMal
        title { romaji english native }
        coverImage { large }
        seasonYear
        episodes
        description(asHtml: false)
        externalLinks { site url language }
      }
    }`,
    )
    .join("\n");
  const query = `query (${varDefs}) {\n${fields}\n}`;
  const variables: Record<string, string> = {};
  batch.forEach((s, idx) => {
    variables[`s${idx}`] = s.title;
  });

  try {
    const r = await fetch(ANILIST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "Tatani/2.0",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!r.ok) {
      const errBody = await r.text();
      console.error("AniList batched lookup failed:", r.status, errBody.slice(0, 200));
      return batch.map(() => null);
    }
    const json = (await r.json()) as {
      data?: Record<string, { media?: AniListMediaNode[] } | undefined>;
    };
    return batch.map((_, idx) => json?.data?.[`q${idx}`]?.media?.[0] ?? null);
  } catch (e) {
    console.error("AniList batched lookup exception:", e);
    return batch.map(() => null);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const auth = await requireAuthUser(req);
    if (auth instanceof Response) return auth;
    const { userId } = auth;

    let streamingFilters: string[] = [];
    let requestedLang: string | undefined;
    try {
      const body = (await req.json()) as {
        streaming_filters?: unknown;
        learning_language?: unknown;
      };
      if (Array.isArray(body?.streaming_filters)) {
        streamingFilters = body.streaming_filters
          .filter((s: unknown): s is string => typeof s === "string")
          .map((s) => s.toLowerCase());
      }
      if (typeof body?.learning_language === "string") {
        requestedLang = body.learning_language;
      }
    } catch {
      /* optional body */
    }

    const admin = createAdminClient();
    const { learning, uiLanguage, level } = await getUserLanguages(admin, userId, requestedLang);
    const [{ data: profile }, { data: libRows }] = await Promise.all([
      admin.from("profiles").select("country").eq("user_id", userId).maybeSingle(),
      admin
        .from("user_anime")
        .select("anime:anime_id(title_romaji,title_en,title_jp)")
        .eq("user_id", userId)
        .eq("learning_language", learning.code),
    ]);
    const nativeLang = uiLanguageName(uiLanguage);
    const country = (profile?.country ?? null) as string | null;

    const typedLibRows = (libRows ?? []) as LibraryAnimeJoin[];
    const libraryByAnime = typedLibRows.map((r) => {
      const a = r.anime;
      return [a?.title_en, a?.title_romaji, a?.title_jp].filter(
        (t): t is string => typeof t === "string" && t.length > 0,
      );
    });
    const ownedTitles = libraryByAnime.flat();

    let aiApiKey: string;
    try {
      aiApiKey = getAiApiKey(req);
    } catch {
      return jsonResponse({ error: "AI not configured (set GEMINI_API_KEY)" }, 500);
    }

    const guide = LEVEL_GUIDE[level] ?? LEVEL_GUIDE.none;
    const scaleLabel = learning.scale === "jlpt" ? "JLPT" : "CEFR";
    const primaryTitles = libraryByAnime.map((t) => t[0]).filter((t): t is string => Boolean(t));

    const librarySection = primaryTitles.length
      ? `The user's current library (use these as the PRIMARY signal for taste — genre, tone, themes, era, studios):
${primaryTitles.map((t) => `- ${t}`).join("\n")}`
      : `The user has no anime in their library yet — recommend broadly appealing, level-appropriate starter anime.`;

    const exclusionSection = libraryByAnime.length
      ? `Do NOT recommend any of these (already owned), nor direct sequels/prequels/spinoffs of them:
${libraryByAnime.map((titles) => `- ${titles.join(" / ")}`).join("\n")}`
      : "";

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

    const aiResp = await callAiChatCompletions(
      {
        model: DEFAULT_AI_MODEL,
        messages: [
          {
            role: "system",
            content: `You are an expert in anime and ${learning.name} language learning. Reply with valid JSON only.`,
          },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
      },
      aiApiKey,
    );

    if (aiResp.status === 429) {
      return jsonResponse({ error: "Rate limit, try again shortly." }, 429);
    }
    if (aiResp.status === 402) {
      return jsonResponse({ error: "AI quota exhausted." }, 402);
    }
    if (!aiResp.ok) {
      const t = await aiResp.text();
      console.error("ai error", aiResp.status, t);
      return jsonResponse({ error: "AI error" }, 502);
    }
    const aiData = (await aiResp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = aiData?.choices?.[0]?.message?.content ?? "{}";
    let parsed: { suggestions?: unknown } = {};
    try {
      parsed = JSON.parse(content) as { suggestions?: unknown };
    } catch {
      parsed = {};
    }
    const suggestions: Suggestion[] = Array.isArray(parsed.suggestions)
      ? parsed.suggestions
          .filter(
            (s): s is Suggestion =>
              Boolean(s) &&
              typeof s === "object" &&
              typeof (s as Suggestion).title === "string" &&
              (s as Suggestion).title.trim().length > 0,
          )
          .map((s) => ({ title: s.title.trim(), reason: typeof s.reason === "string" ? s.reason : "" }))
          .slice(0, wantCount)
      : [];

    // Batch AniList lookups into at most 2 GraphQL alias requests instead of 16 parallel POSTs.
    const suggestionChunks: Suggestion[][] = [];
    for (let i = 0; i < suggestions.length; i += ANILIST_ALIAS_BATCH_SIZE) {
      suggestionChunks.push(suggestions.slice(i, i + ANILIST_ALIAS_BATCH_SIZE));
    }
    const chunkNodes = await Promise.all(suggestionChunks.map((chunk) => batchLookupAniList(chunk)));
    const mediaNodes = chunkNodes.flat();

    const ownedSet = new Set(ownedTitles.map((t) => t.toLowerCase()));
    const seenAnilistIds = new Set<number>();
    let results: RecommendedAnimeItem[] = [];

    for (let i = 0; i < suggestions.length; i++) {
      const s = suggestions[i];
      const m = mediaNodes[i];
      if (!m || typeof m.id !== "number") continue;
      if (seenAnilistIds.has(m.id)) continue;
      const candidateTitles = [m.title?.english, m.title?.romaji, m.title?.native].filter(
        (t): t is string => typeof t === "string" && t.length > 0,
      );
      if (candidateTitles.some((t) => ownedSet.has(t.toLowerCase()))) continue;
      seenAnilistIds.add(m.id);
      results.push({
        anilist_id: m.id,
        mal_id: m.idMal ?? null,
        title_romaji: m.title?.romaji ?? m.title?.english ?? s.title,
        title_en: m.title?.english ?? null,
        title_jp: m.title?.native ?? null,
        cover_url: m.coverImage?.large ?? null,
        year: m.seasonYear ?? null,
        episode_count: m.episodes ?? 0,
        synopsis: m.description?.replace(/<[^>]+>/g, "") ?? null,
        streaming: extractStreaming(m.externalLinks),
        reason: s.reason,
      });
    }

    if (streamingFilters.length) {
      results = results.filter((r) => streamingFilters.some((f) => r.streaming.includes(f)));
    }
    results = results.slice(0, 8);

    return jsonResponse({ results, level, country });
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});
