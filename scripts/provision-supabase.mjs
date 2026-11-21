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
