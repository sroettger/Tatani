// Adds an anime (and season 1 + episodes) to the shared catalog and links it to the user's library.
import {
  corsHeaders,
  createAdminClient,
  jsonResponse,
  requireAuthUser,
} from "../_shared/auth.ts";
import { langInfo } from "../_shared/languages.ts";

type AniListMedia = {
  id?: number;
  idMal?: number | null;
  format?: string | null;
  status?: string | null;
  episodes?: number | null;
  seasonYear?: number | null;
  description?: string | null;
  title?: { romaji?: string | null; english?: string | null; native?: string | null } | null;
  coverImage?: { large?: string | null } | null;
  nextAiringEpisode?: { episode?: number | null } | null;
};

type JikanEpisodeItem = {
  mal_id?: number;
  title?: string | null;
  title_japanese?: string | null;
};

type JikanEpisodesPayload = {
  pagination?: { has_next_page?: boolean; items?: { total?: number } };
  data?: JikanEpisodeItem[];
};

const ANILIST_CANONICAL_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    idMal
    format
    status
    episodes
    seasonYear
    description(asHtml: false)
    title { romaji english native }
    coverImage { large }
    nextAiringEpisode { episode }
  }
}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const auth = await requireAuthUser(req);
    if (auth instanceof Response) return auth;
    const { userId } = auth;

    const body = (await req.json()) as {
      learning_language?: unknown;
      anime?: {
        anilist_id?: unknown;
        mal_id?: unknown;
        title_romaji?: unknown;
        title_en?: unknown;
        title_jp?: unknown;
        cover_url?: unknown;
        year?: unknown;
        episode_count?: unknown;
        synopsis?: unknown;
      };
    };

    const r = body?.anime;
    const anilistId = Number(r?.anilist_id);
    if (!Number.isInteger(anilistId) || anilistId <= 0 || typeof r?.title_romaji !== "string" || !r.title_romaji.trim()) {
      return jsonResponse({ error: "anime payload required" }, 400);
    }

    const admin = createAdminClient();

    const { data: prof } = await admin
      .from("profiles")
      .select("learning_language")
      .eq("user_id", userId)
      .maybeSingle();
    const learningLanguage = langInfo(
      typeof body?.learning_language === "string" && body.learning_language.trim()
        ? body.learning_language
        : prof?.learning_language,
    ).code;

    const { data: existing } = await admin
      .from("anime")
      .select("id, episode_count, mal_id")
      .eq("anilist_id", anilistId)
      .maybeSingle();

    // Fetch canonical AniList metadata when inserting new shared catalog rows or checking aired episodes.
    let canonical: AniListMedia | null = null;
    try {
      const ar = await fetch("https://graphql.anilist.co", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "Tatani/2.0",
        },
        body: JSON.stringify({
          query: ANILIST_CANONICAL_QUERY,
          variables: { id: anilistId },
        }),
      });
      if (ar.status === 404 && !existing?.id) {
        return jsonResponse({ error: "Anime not found on AniList" }, 404);
      }
      if (ar.ok) {
        const ad = (await ar.json()) as { data?: { Media?: AniListMedia | null } };
        canonical = ad?.data?.Media ?? null;
      }
    } catch (err) {
      console.warn("AniList canonical metadata lookup failed", err);
    }

    const aired =
      typeof canonical?.nextAiringEpisode?.episode === "number" && canonical.nextAiringEpisode.episode > 1
        ? canonical.nextAiringEpisode.episode - 1
        : 0;
    const canonicalEpCount =
      canonical?.episodes ?? (aired > 0 ? aired : canonical?.format === "MOVIE" ? 1 : 0);
    const clientEpCount = Number(r.episode_count) || 0;
    const resolvedEpCount = canonicalEpCount > 0 ? canonicalEpCount : Math.max(clientEpCount, 0);

    let animeId: string;
    let effectiveMalId: number | null =
      canonical?.idMal ?? (typeof r.mal_id === "number" ? r.mal_id : null);

    if (existing?.id) {
      animeId = existing.id;
      effectiveMalId = existing.mal_id ?? effectiveMalId;
    } else {
      const canonicalSynopsis = canonical?.description
        ? canonical.description.replace(/<[^>]+>/g, "")
        : typeof r.synopsis === "string"
          ? r.synopsis.replace(/<[^>]+>/g, "")
          : null;
      const insertPayload = {
        anilist_id: anilistId,
        mal_id: effectiveMalId,
        title_romaji:
          canonical?.title?.romaji ??
          canonical?.title?.english ??
          r.title_romaji.trim().slice(0, 300),
        title_en: canonical ? (canonical.title?.english ?? null) : (typeof r.title_en === "string" ? r.title_en : null),
        title_jp: canonical ? (canonical.title?.native ?? null) : (typeof r.title_jp === "string" ? r.title_jp : null),
        cover_url: canonical ? (canonical.coverImage?.large ?? null) : (typeof r.cover_url === "string" ? r.cover_url : null),
        year: canonical ? (canonical.seasonYear ?? null) : (typeof r.year === "number" ? r.year : null),
        season_count: 1,
        episode_count: resolvedEpCount,
        synopsis: canonicalSynopsis,
      };
      let { data: ins, error } = await admin.from("anime").insert(insertPayload).select("id").single();
      if (error && effectiveMalId !== null && error.message?.includes("mal_id")) {
        // Split-cour AniList entries can share a MAL ID; retry without unique mal_id collision
        const retry = await admin.from("anime").insert({ ...insertPayload, mal_id: null }).select("id").single();
        ins = retry.data;
        error = retry.error;
      }
      if (error || !ins) {
        return jsonResponse({ error: error?.message ?? "insert failed" }, 500);
      }
      animeId = ins.id;
    }

    // Ensure Season 1 exists
    const seasonLookup = await admin
      .from("seasons")
      .select("id, episode_count")
      .eq("anime_id", animeId)
      .eq("season_number", 1)
      .maybeSingle();
    if (seasonLookup.error) {
      return jsonResponse({ error: seasonLookup.error.message }, 500);
    }
    let season = seasonLookup.data;
    if (!season) {
      const { data: createdSeason, error: seasonInsErr } = await admin
        .from("seasons")
        .insert({ anime_id: animeId, season_number: 1, episode_count: resolvedEpCount })
        .select("id, episode_count")
        .single();
      if (seasonInsErr || !createdSeason) {
        return jsonResponse({ error: seasonInsErr?.message ?? "season insert failed" }, 500);
      }
      season = createdSeason;
    }

    // Check existing episodes so ongoing shows can append newly aired episodes (`existingEpCount < epCount`)
    const { data: existingEps } = await admin
      .from("episodes")
      .select("episode_number")
      .eq("season_id", season.id);
    const existingEpNums = new Set((existingEps ?? []).map((e: { episode_number: number }) => e.episode_number));
    const existingEpCount = existingEpNums.size;
    const epCount = Math.min(Math.max(resolvedEpCount, existing?.episode_count ?? 0, season.episode_count ?? 0, 1), 200);

    if ((existingEpCount ?? 0) < epCount) {
      const titles: Record<number, { en: string | null; jp: string | null }> = {};
      let maxJikanEp = 0;
      if (effectiveMalId) {
        try {
          const initialPages = Math.max(1, Math.min(2, Math.ceil((epCount || 100) / 100)));
          for (let p = 1; p <= initialPages; p++) {
            const jr = await fetch(`https://api.jikan.moe/v4/anime/${effectiveMalId}/episodes?page=${p}`, {
              headers: { "User-Agent": "Tatani/2.0", Accept: "application/json" },
            });
            if (!jr.ok) break;
            const jd = (await jr.json()) as JikanEpisodesPayload;
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

      const finalCatalogTotal = Math.max(resolvedEpCount, maxJikanEp, epCount, 1);
      const finalEpCount = Math.min(finalCatalogTotal, 200);
      const missingEps: Array<{
        season_id: string;
        episode_number: number;
        title_en: string | null;
        title_jp: string | null;
      }> = [];
      for (let num = 1; num <= finalEpCount; num++) {
        if (existingEpNums.has(num)) continue;
        missingEps.push({
          season_id: season.id,
          episode_number: num,
          title_en: titles[num]?.en ?? null,
          title_jp: titles[num]?.jp ?? null,
        });
      }

      if (missingEps.length > 0) {
        const { error: epInsErr } = await admin
          .from("episodes")
          .upsert(missingEps, { onConflict: "season_id,episode_number", ignoreDuplicates: true });
        if (epInsErr) {
          return jsonResponse({ error: epInsErr.message }, 500);
        }
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
      .upsert(
        { user_id: userId, anime_id: animeId, learning_language: learningLanguage },
        { onConflict: "user_id,anime_id,learning_language" },
      )
      .select("id")
      .maybeSingle();
    if (linkErr) {
      const { error: insErr } = await admin
        .from("user_anime")
        .insert({ user_id: userId, anime_id: animeId, learning_language: learningLanguage });
      if (insErr && !insErr.message.includes("duplicate")) {
        return jsonResponse({ error: insErr.message }, 500);
      }
    }

    return jsonResponse({ anime_id: animeId, link_id: link?.id ?? null });
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});
