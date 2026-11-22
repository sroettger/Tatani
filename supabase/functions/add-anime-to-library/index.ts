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

const MAX_EPISODES = 1000;
const EPISODE_UPSERT_BATCH = 250;
const ANILIST_TIMEOUT_MS = 2500;
const JIKAN_TIMEOUT_MS = 4000;
const MAX_JIKAN_PAGES = 10;

const edgeRuntime = (
  globalThis as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }
).EdgeRuntime;

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

    const [{ data: prof }, { data: existing }] = await Promise.all([
      admin
        .from("profiles")
        .select("learning_language")
        .eq("user_id", userId)
        .maybeSingle(),
      admin
        .from("anime")
        .select("id, episode_count, mal_id")
        .eq("anilist_id", anilistId)
        .maybeSingle(),
    ]);

    const learningLanguage = langInfo(
      typeof body?.learning_language === "string" && body.learning_language.trim()
        ? body.learning_language
        : prof?.learning_language,
    ).code;

    const clientEpCount = Math.max(0, Math.floor(Number(r.episode_count) || 0));
    const existingCatalogCount = existing?.episode_count ?? 0;
    const shouldFetchCanonical =
      !existing?.id ||
      existingCatalogCount <= 0 ||
      clientEpCount === 0 ||
      clientEpCount > existingCatalogCount;

    // Fetch canonical AniList metadata when inserting new shared catalog rows or checking newly aired episodes.
    let canonical: AniListMedia | null = null;
    if (shouldFetchCanonical) {
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
          signal: AbortSignal.timeout(ANILIST_TIMEOUT_MS),
        });
        if (ar.status === 404 && !existing?.id) {
          return jsonResponse({ error: "Anime not found on AniList" }, 404);
        }
        if (ar.ok) {
          const ad = (await ar.json()) as { data?: { Media?: AniListMedia | null } };
          canonical = ad?.data?.Media ?? null;
        }
      } catch (err) {
        console.warn("AniList canonical metadata lookup timed out or failed", err);
      }
    }

    const aired =
      typeof canonical?.nextAiringEpisode?.episode === "number" && canonical.nextAiringEpisode.episode > 1
        ? canonical.nextAiringEpisode.episode - 1
        : 0;
    const canonicalEpCount =
      canonical?.episodes ?? (aired > 0 ? aired : canonical?.format === "MOVIE" ? 1 : 0);
    const resolvedEpCount =
      canonicalEpCount > 0 ? canonicalEpCount : Math.max(clientEpCount, existingCatalogCount, 0);

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
        episode_count: Math.max(resolvedEpCount, 1),
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
        .insert({ anime_id: animeId, season_number: 1, episode_count: Math.max(resolvedEpCount, 1) })
        .select("id, episode_count")
        .single();
      if (seasonInsErr || !createdSeason) {
        return jsonResponse({ error: seasonInsErr?.message ?? "season insert failed" }, 500);
      }
      season = createdSeason;
    }

    // Check existing episodes so ongoing shows append newly aired episodes and untitled episodes can be enriched
    const { data: existingEps } = await admin
      .from("episodes")
      .select("episode_number, title_en, title_jp")
      .eq("season_id", season.id)
      .limit(MAX_EPISODES);

    const existingEpNums = new Set<number>();
    const titledEpNums = new Set<number>();
    for (const e of (existingEps ?? []) as Array<{
      episode_number: number;
      title_en: string | null;
      title_jp: string | null;
    }>) {
      existingEpNums.add(e.episode_number);
      if ((e.title_en && e.title_en.trim()) || (e.title_jp && e.title_jp.trim())) {
        titledEpNums.add(e.episode_number);
      }
    }

    const prefetchedTitles: Record<number, { en: string | null; jp: string | null }> = {};
    let prefetchedMaxEp = 0;
    let startJikanPage = 1;
    let hasMoreJikanPages = true;

    // Only block on Jikan page 1 when neither AniList nor the DB knows how many episodes exist at all
    const knownCountBeforeJikan = Math.max(resolvedEpCount, existingCatalogCount, season.episode_count ?? 0, existingEpNums.size);
    if (knownCountBeforeJikan === 0 && effectiveMalId) {
      try {
        const jr = await fetch(`https://api.jikan.moe/v4/anime/${effectiveMalId}/episodes?page=1`, {
          headers: { "User-Agent": "Tatani/2.0", Accept: "application/json" },
          signal: AbortSignal.timeout(ANILIST_TIMEOUT_MS),
        });
        if (jr.ok) {
          const jd = (await jr.json()) as JikanEpisodesPayload;
          const totalItems = Number(jd?.pagination?.items?.total) || 0;
          if (totalItems > prefetchedMaxEp) prefetchedMaxEp = totalItems;
          for (const e of jd?.data ?? []) {
            if (typeof e?.mal_id === "number" && e.mal_id > 0) {
              if (e.mal_id > prefetchedMaxEp) prefetchedMaxEp = e.mal_id;
              prefetchedTitles[e.mal_id] = { en: e.title ?? null, jp: e.title_japanese ?? null };
              if (e.title || e.title_japanese) titledEpNums.add(e.mal_id);
            }
          }
          startJikanPage = 2;
          hasMoreJikanPages = Boolean(jd?.pagination?.has_next_page);
        }
      } catch (err) {
        console.warn("Initial Jikan episode count probe timed out or failed", err);
      }
    }

    const finalCatalogTotal = Math.max(
      resolvedEpCount,
      prefetchedMaxEp,
      existingCatalogCount,
      season.episode_count ?? 0,
      1,
    );
    const finalEpCount = Math.min(finalCatalogTotal, MAX_EPISODES);

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
        title_en: prefetchedTitles[num]?.en ?? null,
        title_jp: prefetchedTitles[num]?.jp ?? null,
      });
    }

    for (let i = 0; i < missingEps.length; i += EPISODE_UPSERT_BATCH) {
      const chunk = missingEps.slice(i, i + EPISODE_UPSERT_BATCH);
      const { error: epInsErr } = await admin
        .from("episodes")
        .upsert(chunk, { onConflict: "season_id,episode_number", ignoreDuplicates: true });
      if (epInsErr) {
        return jsonResponse({ error: epInsErr.message }, 500);
      }
    }

    const catalogUpdates: PromiseLike<unknown>[] = [];
    if (existingCatalogCount < finalCatalogTotal) {
      catalogUpdates.push(admin.from("anime").update({ episode_count: finalCatalogTotal }).eq("id", animeId));
    }
    if ((season.episode_count ?? 0) < finalCatalogTotal) {
      catalogUpdates.push(admin.from("seasons").update({ episode_count: finalCatalogTotal }).eq("id", season.id));
    }
    if (catalogUpdates.length > 0) {
      await Promise.all(catalogUpdates);
    }

    // Link to user library immediately so UI never waits on slow Jikan pagination
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

    // Enrich missing episode titles (and any newly discovered Jikan episodes) asynchronously in background
    const needsTitleEnrichment =
      Boolean(effectiveMalId) &&
      hasMoreJikanPages &&
      (titledEpNums.size < finalEpCount || startJikanPage === 2);

    if (needsTitleEnrichment && effectiveMalId && edgeRuntime?.waitUntil) {
      const seasonId = season.id;
      const malId = effectiveMalId;
      const bgTask = (async () => {
        try {
          let targetMaxEp = finalEpCount;
          let maxPages = Math.max(startJikanPage, Math.min(MAX_JIKAN_PAGES, Math.ceil(targetMaxEp / 100)));
          for (let p = startJikanPage; p <= maxPages; p++) {
            const jr = await fetch(`https://api.jikan.moe/v4/anime/${malId}/episodes?page=${p}`, {
              headers: { "User-Agent": "Tatani/2.0", Accept: "application/json" },
              signal: AbortSignal.timeout(JIKAN_TIMEOUT_MS),
            });
            if (!jr.ok) break;
            const jd = (await jr.json()) as JikanEpisodesPayload;
            const totalItems = Number(jd?.pagination?.items?.total) || 0;
            if (totalItems > targetMaxEp) {
              targetMaxEp = Math.min(totalItems, MAX_EPISODES);
              maxPages = Math.min(MAX_JIKAN_PAGES, Math.ceil(targetMaxEp / 100));
            }

            const titleUpdates: Array<{
              season_id: string;
              episode_number: number;
              title_en: string | null;
              title_jp: string | null;
            }> = [];

            for (const e of jd?.data ?? []) {
              if (typeof e?.mal_id !== "number" || e.mal_id <= 0 || e.mal_id > MAX_EPISODES) continue;
              if (e.mal_id > targetMaxEp) {
                targetMaxEp = e.mal_id;
              }
              const enTitle = e.title?.trim() || null;
              const jpTitle = e.title_japanese?.trim() || null;
              if ((enTitle || jpTitle) && !titledEpNums.has(e.mal_id)) {
                titledEpNums.add(e.mal_id);
                titleUpdates.push({
                  season_id: seasonId,
                  episode_number: e.mal_id,
                  title_en: enTitle,
                  title_jp: jpTitle,
                });
              }
            }

            if (titleUpdates.length > 0) {
              await admin
                .from("episodes")
                .upsert(titleUpdates, { onConflict: "season_id,episode_number" });
            }

            if (!jd?.pagination?.has_next_page) break;
            if (p < maxPages) {
              await new Promise((res) => setTimeout(res, 450));
            }
          }

          if (targetMaxEp > finalEpCount) {
            const extraEps: Array<{
              season_id: string;
              episode_number: number;
              title_en: string | null;
              title_jp: string | null;
            }> = [];
            for (let num = finalEpCount + 1; num <= targetMaxEp; num++) {
              if (!titledEpNums.has(num) && !existingEpNums.has(num)) {
                extraEps.push({
                  season_id: seasonId,
                  episode_number: num,
                  title_en: null,
                  title_jp: null,
                });
              }
            }
            for (let i = 0; i < extraEps.length; i += EPISODE_UPSERT_BATCH) {
              await admin
                .from("episodes")
                .upsert(extraEps.slice(i, i + EPISODE_UPSERT_BATCH), {
                  onConflict: "season_id,episode_number",
                  ignoreDuplicates: true,
                });
            }
            await Promise.all([
              admin.from("anime").update({ episode_count: targetMaxEp }).eq("id", animeId),
              admin.from("seasons").update({ episode_count: targetMaxEp }).eq("id", seasonId),
            ]);
          }
        } catch (err) {
          console.warn("Background Jikan episode title enrichment failed", err);
        }
      })();
      edgeRuntime.waitUntil(bgTask);
    }

    return jsonResponse({
      anime_id: animeId,
      link_id: link?.id ?? null,
      episode_count: finalEpCount,
    });
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});
