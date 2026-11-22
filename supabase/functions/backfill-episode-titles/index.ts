// Backfills episode titles from Jikan (MAL) for anime where they're missing.
// Admin-only.
import {
  corsHeaders,
  createAdminClient,
  jsonResponse,
  requireAuthUser,
} from "../_shared/auth.ts";

type JikanEpisode = {
  mal_id?: number;
  title?: string | null;
  title_japanese?: string | null;
};

type JikanResponse = {
  pagination?: { has_next_page?: boolean };
  data?: JikanEpisode[];
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const auth = await requireAuthUser(req);
    if (auth instanceof Response) return auth;

    const admin = createAdminClient();

    // Enforce admin role check
    const { data: adminRole, error: roleErr } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", auth.userId)
      .eq("role", "admin")
      .maybeSingle();
    if (roleErr || !adminRole) {
      return jsonResponse({ error: "Forbidden — admin only" }, 403);
    }

    // Find anime with missing episode titles
    const { data: anime } = await admin
      .from("anime")
      .select("id, title_romaji, mal_id")
      .not("mal_id", "is", null);

    let updated = 0;
    const summary: Array<{ anime: string; updated: number; skipped?: string }> = [];

    for (const a of anime ?? []) {
      const { data: seasons } = await admin.from("seasons").select("id").eq("anime_id", a.id);
      const seasonIds = (seasons ?? []).map((s: { id: string }) => s.id);
      if (seasonIds.length === 0) continue;

      const { data: missingEps } = await admin
        .from("episodes")
        .select("id, season_id, episode_number")
        .in("season_id", seasonIds)
        .is("title_en", null)
        .is("title_jp", null);
      if (!missingEps || missingEps.length === 0) continue;

      const maxEp = Math.max(...missingEps.map((e: { episode_number: number }) => e.episode_number));
      const titles: Record<number, { en: string | null; jp: string | null }> = {};
      const pages = Math.ceil(maxEp / 100);
      try {
        for (let p = 1; p <= pages; p++) {
          const jr = await fetch(`https://api.jikan.moe/v4/anime/${a.mal_id}/episodes?page=${p}`, {
            headers: { "User-Agent": "Tatani/2.0", Accept: "application/json" },
          });
          if (!jr.ok) break;
          const jd = (await jr.json()) as JikanResponse;
          for (const e of jd.data ?? []) {
            if (typeof e?.mal_id === "number") {
              titles[e.mal_id] = { en: e.title ?? null, jp: e.title_japanese ?? null };
            }
          }
          if (!jd.pagination?.has_next_page) break;
          if (p < pages) await new Promise((res) => setTimeout(res, 400));
        }
      } catch (err) {
        summary.push({ anime: a.title_romaji, updated: 0, skipped: String(err) });
        continue;
      }

      const batchRows = missingEps
        .map((ep: { id: string; season_id: string; episode_number: number }) => {
          const t = titles[ep.episode_number];
          if (!t || (!t.en && !t.jp)) return null;
          return {
            id: ep.id,
            season_id: ep.season_id,
            episode_number: ep.episode_number,
            title_en: t.en,
            title_jp: t.jp,
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null);

      let count = 0;
      const CHUNK_SIZE = 200;
      for (let i = 0; i < batchRows.length; i += CHUNK_SIZE) {
        const chunk = batchRows.slice(i, i + CHUNK_SIZE);
        const { error: upsertErr } = await admin.from("episodes").upsert(chunk, { onConflict: "id" });
        if (!upsertErr) {
          count += chunk.length;
        } else {
          console.error(`Batch episode title update failed for ${a.title_romaji}:`, upsertErr.message);
        }
      }

      updated += count;
      summary.push({ anime: a.title_romaji, updated: count });
    }

    return jsonResponse({ total_updated: updated, summary });
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});
