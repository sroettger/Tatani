#!/usr/bin/env node
// Zero-password Supabase project resolver & migration runner using the official Management API.
// Allows CI workflows to auto-create/discover the "Tatani" project, apply all SQL migrations,
// configure Auth redirect URLs, and resolve SUPABASE_URL + SUPABASE_ANON_KEY from a single
// SUPABASE_ACCESS_TOKEN secret.

import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const API_BASE = process.env.SUPABASE_API_BASE || "https://api.supabase.com/v1";

export async function apiRequest(endpoint, token, options = {}, fetchImpl = fetch) {
  const resp = await fetchImpl(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!resp.ok) {
    throw new Error(`Supabase API ${options.method || "GET"} ${endpoint} failed [${resp.status}]: ${text.slice(0, 400)}`);
  }
  return data;
}

export async function resolveOrCreateProject({
  token,
  explicitProjectId,
  autoCreate = false,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  let projectId = explicitProjectId?.trim() || "";

  if (!projectId) {
    const projects = await apiRequest("/projects", token, {}, fetchImpl);
    const active = (Array.isArray(projects) ? projects : []).filter(
      (p) => p?.id && !["REMOVED", "GOING_DOWN", "INACTIVE"].includes(String(p.status || "")),
    );
    const namedTatani = active.find((p) => String(p.name || "").toLowerCase().includes("tatani"));
    const fallbackSingle = active.length === 1 ? active[0] : null;
    const chosen = namedTatani || fallbackSingle;

    if (chosen) {
      projectId = chosen.id;
    } else if (autoCreate) {
      const orgs = await apiRequest("/organizations", token, {}, fetchImpl);
      if (!Array.isArray(orgs) || orgs.length === 0) {
        throw new Error("No Supabase organization found on this account; create an organization once at https://supabase.com/dashboard");
      }
      const dbPass = `${randomUUID().replace(/-/g, "")}Aa1!`;
      const created = await apiRequest(
        "/projects",
        token,
        {
          method: "POST",
          body: JSON.stringify({
            organization_id: orgs[0].id,
            name: "Tatani",
            region: process.env.SUPABASE_REGION || "us-east-1",
            db_pass: dbPass,
          }),
        },
        fetchImpl,
      );
      projectId = created.id;
      console.log(`Created new Supabase project 'Tatani' (${projectId}). Waiting for database readiness...`);
      for (let attempt = 0; attempt < 40; attempt++) {
        const info = await apiRequest(`/projects/${projectId}`, token, {}, fetchImpl);
        if (info?.status === "ACTIVE_HEALTHY") break;
        await sleep(5000);
      }
    } else {
      throw new Error("Could not find a 'Tatani' Supabase project; run Deploy Supabase workflow first or set SUPABASE_PROJECT_ID.");
    }
  }

  const keys = await apiRequest(`/projects/${projectId}/api-keys`, token, {}, fetchImpl);
  const keyList = Array.isArray(keys) ? keys : [];
  const anonEntry =
    keyList.find((k) => k?.name === "anon" && k?.api_key) ||
    keyList.find((k) => (k?.type === "publishable" || k?.name === "publishable") && k?.api_key);

  if (!anonEntry?.api_key) {
    throw new Error(`Could not resolve public anon/publishable key for project ${projectId}`);
  }

  return {
    projectId,
    supabaseUrl: `https://${projectId}.supabase.co`,
    supabaseAnonKey: anonEntry.api_key,
  };
}

export async function applyMigrationsViaApi({
  token,
  projectId,
  migrationsDir,
  siteUrl = "https://sroettger.github.io/Tatani/",
  redirectUrls = "https://sroettger.github.io/Tatani/**,tatani://auth-callback",
  fetchImpl = fetch,
}) {
  const runSql = async (query) =>
    await apiRequest(
      `/projects/${projectId}/database/query`,
      token,
      { method: "POST", body: JSON.stringify({ query }) },
      fetchImpl,
    );

  await runSql(`
    CREATE SCHEMA IF NOT EXISTS supabase_migrations;
    CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
      version text PRIMARY KEY,
      statements text[],
      name text
    );
  `);

  const rows = await runSql(`SELECT version FROM supabase_migrations.schema_migrations;`);
  const applied = new Set((Array.isArray(rows) ? rows : []).map((r) => String(r.version)));

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const match = /^(\d+)_?(.*)\.sql$/.exec(file);
    if (!match) continue;
    const [, version, rawName] = match;
    if (applied.has(version)) {
      console.log(`Migration ${file} already applied — skipping.`);
      continue;
    }
    console.log(`Applying migration ${file}...`);
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    await runSql(sql);
    const safeVersion = version.replace(/'/g, "''");
    const safeName = (rawName || file).replace(/'/g, "''");
    await runSql(
      `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('${safeVersion}', '${safeName}') ON CONFLICT (version) DO NOTHING;`,
    );
  }

  // Best-effort Auth redirect URL setup for GitHub Pages + Android custom scheme
  try {
    await apiRequest(
      `/projects/${projectId}/config/auth`,
      token,
      {
        method: "PATCH",
        body: JSON.stringify({
          site_url: siteUrl,
          uri_allow_list: redirectUrls,
        }),
      },
      fetchImpl,
    );
    console.log("Configured Supabase Auth Site URL and Redirect URLs.");
  } catch (err) {
    console.warn("Note: skipped automatic Auth URL patch:", err instanceof Error ? err.message : err);
  }
}

export async function repairCatalogEpisodesAndReport({
  token,
  projectId,
  fetchImpl = fetch,
}) {
  const runSql = async (query) =>
    await apiRequest(
      `/projects/${projectId}/database/query`,
      token,
      { method: "POST", body: JSON.stringify({ query }) },
      fetchImpl,
    );

  const sqlStr = (val) => (val == null ? "NULL" : `'${String(val).replace(/'/g, "''")}'`);

  const animeRows = await runSql(`
    SELECT
      a.id,
      a.anilist_id,
      a.mal_id,
      a.title_romaji,
      a.episode_count,
      (SELECT count(*)::int FROM public.seasons s WHERE s.anime_id = a.id) AS seasons_count,
      (SELECT count(*)::int FROM public.episodes e JOIN public.seasons s ON s.id = e.season_id WHERE s.anime_id = a.id) AS episodes_count,
      (SELECT count(*)::int FROM public.user_anime ua WHERE ua.anime_id = a.id) AS linked_count
    FROM public.anime a
    ORDER BY a.created_at ASC;
  `);

  for (const a of Array.isArray(animeRows) ? animeRows : []) {
    if (Number(a.episodes_count) > 0) continue;

    let resolvedCount = Number(a.episode_count) || 0;
    if (resolvedCount <= 0 && a.anilist_id) {
      try {
        const ar = await fetchImpl("https://graphql.anilist.co", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "Tatani/2.0" },
          body: JSON.stringify({
            query: `query ($id: Int) { Media(id: $id, type: ANIME) { episodes format status nextAiringEpisode { episode } } }`,
            variables: { id: Number(a.anilist_id) },
          }),
        });
        if (ar.ok) {
          const ad = await ar.json();
          const m = ad?.data?.Media;
          const aired =
            typeof m?.nextAiringEpisode?.episode === "number" && m.nextAiringEpisode.episode > 1
              ? m.nextAiringEpisode.episode - 1
              : 0;
          resolvedCount = m?.episodes ?? (aired > 0 ? aired : m?.format === "MOVIE" ? 1 : 0);
        }
      } catch (err) {
        console.warn(`AniList lookup skipped for ${a.title_romaji}:`, err instanceof Error ? err.message : err);
      }
    }

    const titles = {};
    let maxJikanEp = 0;
    if (a.mal_id) {
      try {
        const pages = Math.max(1, Math.min(2, Math.ceil((resolvedCount || 100) / 100)));
        for (let p = 1; p <= pages; p++) {
          const jr = await fetchImpl(`https://api.jikan.moe/v4/anime/${Number(a.mal_id)}/episodes?page=${p}`);
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
        }
      } catch (err) {
        console.warn(`Jikan lookup skipped for ${a.title_romaji}:`, err instanceof Error ? err.message : err);
      }
    }

    const finalCatalogTotal = Math.max(resolvedCount, maxJikanEp, 1);
    const epCount = Math.min(finalCatalogTotal, 200);

    const seasonRes = await runSql(`
      INSERT INTO public.seasons (anime_id, season_number, episode_count)
      VALUES (${sqlStr(a.id)}, 1, ${finalCatalogTotal})
      ON CONFLICT (anime_id, season_number) DO UPDATE SET episode_count = GREATEST(public.seasons.episode_count, EXCLUDED.episode_count)
      RETURNING id;
    `);
    const seasonId = Array.isArray(seasonRes) && seasonRes[0]?.id;
    if (!seasonId) continue;

    const valuesSql = Array.from({ length: epCount }, (_, i) => {
      const epNum = i + 1;
      const t = titles[epNum] || {};
      return `(${sqlStr(seasonId)}, ${epNum}, ${sqlStr(t.en ?? null)}, ${sqlStr(t.jp ?? null)})`;
    }).join(",\n      ");

    await runSql(`
      INSERT INTO public.episodes (season_id, episode_number, title_en, title_jp)
      VALUES
      ${valuesSql}
      ON CONFLICT (season_id, episode_number) DO NOTHING;

      UPDATE public.anime
      SET episode_count = GREATEST(episode_count, ${finalCatalogTotal})
      WHERE id = ${sqlStr(a.id)};
    `);

    console.log(`Backfilled ${epCount} episodes for catalog anime '${a.title_romaji}' (anilist_id=${a.anilist_id}).`);
  }

  // Non-sensitive aggregate health report (no user emails, IDs, or personal fields)
  const summaryRows = await runSql(`
    SELECT
      (SELECT count(*)::int FROM public.profiles) AS profiles_count,
      (SELECT count(*)::int FROM public.user_language_progress) AS progress_count,
      (SELECT count(*)::int FROM public.anime) AS anime_count,
      (SELECT count(*)::int FROM public.seasons) AS seasons_count,
      (SELECT count(*)::int FROM public.episodes) AS episodes_count,
      (SELECT count(*)::int FROM public.user_anime) AS user_anime_count,
      (SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('profile_lang', p.learning_language, 'library_lang', ua.learning_language)), '[]'::jsonb)
       FROM public.user_anime ua LEFT JOIN public.profiles p ON p.user_id = ua.user_id) AS lang_pairs,
      (SELECT coalesce(jsonb_agg(jsonb_build_object(
         'anilist_id', a.anilist_id,
         'title', a.title_romaji,
         'catalog_eps', a.episode_count,
         'db_seasons', (SELECT count(*)::int FROM public.seasons s WHERE s.anime_id = a.id),
         'db_episodes', (SELECT count(*)::int FROM public.episodes e JOIN public.seasons s ON s.id = e.season_id WHERE s.anime_id = a.id),
         'links', (SELECT count(*)::int FROM public.user_anime ua WHERE ua.anime_id = a.id)
       )), '[]'::jsonb)
       FROM public.anime a) AS catalog;
  `);
  if (Array.isArray(summaryRows) && summaryRows[0]) {
    console.log("Catalog health summary:", JSON.stringify(summaryRows[0]));
  }

  // Verify RLS visibility as ROLE authenticated for the user_anime owner (read-only, zero PII)
  try {
    const rlsCheck = await runSql(`
      CREATE OR REPLACE FUNCTION pg_temp.verify_auth_rls()
      RETURNS jsonb
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_uid uuid;
        v_out jsonb;
      BEGIN
        SELECT user_id INTO v_uid FROM public.user_anime LIMIT 1;
        IF v_uid IS NULL THEN
          RETURN jsonb_build_object('note', 'no_user_anime');
        END IF;
        PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
        EXECUTE 'SET LOCAL ROLE authenticated';
        SELECT jsonb_build_object(
          'rls_profiles', (SELECT count(*)::int FROM public.profiles WHERE user_id = auth.uid()),
          'rls_progress', (SELECT count(*)::int FROM public.user_language_progress WHERE user_id = auth.uid() AND learning_language = 'ja'),
          'rls_words', (SELECT count(*)::int FROM public.user_word_state WHERE user_id = auth.uid() AND learning_language = 'ja'),
          'rls_chunks', (SELECT count(*)::int FROM public.study_chunks WHERE user_id = auth.uid() AND learning_language = 'ja'),
          'rls_user_anime', (SELECT count(*)::int FROM public.user_anime WHERE user_id = auth.uid() AND learning_language = 'ja'),
          'rls_anime', (SELECT count(*)::int FROM public.anime),
          'rls_seasons', (SELECT count(*)::int FROM public.seasons),
          'rls_episodes', (SELECT count(*)::int FROM public.episodes e JOIN public.seasons s ON s.id = e.season_id)
        ) INTO v_out;
        EXECUTE 'RESET ROLE';
        RETURN v_out;
      END;
      $$;
      SELECT pg_temp.verify_auth_rls() AS rls_result;
    `);
    console.log("Authenticated RLS check:", JSON.stringify(rlsCheck));
  } catch (err) {
    console.warn("Authenticated RLS check failed:", err instanceof Error ? err.message : err);
  }
}

async function main() {
  const mode = process.argv[2] || "--resolve";
  const token = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  const explicitProjectId = process.env.SUPABASE_PROJECT_ID?.trim();
  const explicitUrl = process.env.SUPABASE_URL?.trim();
  const explicitAnonKey = process.env.SUPABASE_ANON_KEY?.trim();

  if (mode === "--resolve" && explicitUrl && explicitAnonKey) {
    writeOutputs({
      configured: "true",
      project_id: explicitProjectId || "",
      supabase_url: explicitUrl,
      supabase_anon_key: explicitAnonKey,
    });
    return;
  }

  if (!token) {
    console.log("SUPABASE_ACCESS_TOKEN not set; skipping automatic Supabase resolution.");
    writeOutputs({
      configured: "false",
      project_id: explicitProjectId || "",
      supabase_url: explicitUrl || "https://placeholder.supabase.co",
      supabase_anon_key: explicitAnonKey || "public-anon-placeholder-key",
    });
    return;
  }

  const resolved = await resolveOrCreateProject({
    token,
    explicitProjectId,
    autoCreate: mode === "--provision",
  });

  if (mode === "--provision") {
    const migrationsDir = path.resolve(process.cwd(), "supabase/migrations");
    await applyMigrationsViaApi({
      token,
      projectId: resolved.projectId,
      migrationsDir,
    });
    await repairCatalogEpisodesAndReport({
      token,
      projectId: resolved.projectId,
    });
  }

  writeOutputs({
    configured: "true",
    project_id: resolved.projectId,
    supabase_url: explicitUrl || resolved.supabaseUrl,
    supabase_anon_key: explicitAnonKey || resolved.supabaseAnonKey,
  });
}

function writeOutputs(values) {
  const outPath = process.env.GITHUB_OUTPUT;
  if (!outPath) {
    console.log(JSON.stringify({ ...values, supabase_anon_key: values.supabase_anon_key ? "[set]" : "" }));
    return;
  }
  const lines = Object.entries(values)
    .map(([k, v]) => `${k}=${String(v).replace(/[\r\n]/g, "")}`)
    .join("\n");
  appendFileSync(outPath, `${lines}\n`, "utf8");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
