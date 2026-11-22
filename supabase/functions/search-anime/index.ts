// Search anime via AniList GraphQL API (no key required)
import {
  corsHeaders,
  jsonResponse,
  requireAuthUser,
} from "../_shared/auth.ts";

const ANILIST_URL = "https://graphql.anilist.co";

const SEARCH_QUERY = `
query ($search: String) {
  Page(page: 1, perPage: 15) {
    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
      id
      idMal
      format
      status
      title { romaji english native }
      coverImage { large }
      seasonYear
      episodes
      nextAiringEpisode { episode }
      description(asHtml: false)
    }
  }
}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const auth = await requireAuthUser(req);
    if (auth instanceof Response) return auth;

    const { query } = (await req.json()) as { query?: unknown };
    if (typeof query !== "string" || !query.trim() || query.length > 200) {
      return jsonResponse({ error: "query required (max 200 chars)" }, 400);
    }

    const r = await fetch(ANILIST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "Tatani/2.0",
      },
      body: JSON.stringify({ query: SEARCH_QUERY, variables: { search: query.trim() } }),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error("anilist error", r.status, t);
      return jsonResponse({ error: "AniList error" }, 502);
    }
    const data = (await r.json()) as { data?: { Page?: { media?: unknown[] } } };
    type AniListMediaItem = {
      id?: number;
      idMal?: number | null;
      format?: string | null;
      status?: string | null;
      title?: { romaji?: string | null; english?: string | null; native?: string | null };
      coverImage?: { large?: string | null };
      seasonYear?: number | null;
      episodes?: number | null;
      nextAiringEpisode?: { episode?: number | null } | null;
      description?: string | null;
    };
    const results = ((data?.data?.Page?.media ?? []) as AniListMediaItem[]).map((m) => {
      const airedCount =
        typeof m.nextAiringEpisode?.episode === "number" && m.nextAiringEpisode.episode > 1
          ? m.nextAiringEpisode.episode - 1
          : 0;
      const movieFallback = m.format === "MOVIE" && m.status === "FINISHED" ? 1 : 0;
      return {
        anilist_id: m.id,
        mal_id: m.idMal ?? null,
        title_romaji: m.title?.romaji ?? m.title?.english ?? "Unknown",
        title_en: m.title?.english ?? null,
        title_jp: m.title?.native ?? null,
        cover_url: m.coverImage?.large ?? null,
        year: m.seasonYear ?? null,
        episode_count: m.episodes ?? (airedCount > 0 ? airedCount : movieFallback),
        synopsis: m.description?.replace(/<[^>]+>/g, "") ?? null,
      };
    });
    return jsonResponse({ results });
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});
