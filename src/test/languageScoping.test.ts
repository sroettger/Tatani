import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Guardrail: every read/write against a language-scoped table must also
 * constrain `learning_language`, otherwise data leaks between the languages
 * a user is learning (e.g. a German anime showing up in the Japanese library).
 * Likewise, every `episode_vocab_cache` query across `src/` must filter on `language`.
 */
const SCOPED_TABLES = [
  "user_anime",
  "user_word_state",
  "study_chunks",
  "study_sessions",
  "quiz_results",
  "episode_summaries",
  "user_language_progress",
];

/** Call sites that legitimately don't need the filter, with a reason. */
const ALLOWLIST: Record<string, string> = {
  // Chunk / session rows are looked up by their own primary key, which is
  // already unique across languages.
  "byId": "lookup by primary key",
};

const ROOTS = ["src", "supabase/functions"];
const EXT = /\.(ts|tsx)$/;

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "test") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (EXT.test(entry)) out.push(full);
  }
  return out;
};

type CallSite = { file: string; line: number; table: string; chain: string };

/** Extract each `.from("<table>")` chain up to the end of the statement. */
const callSites = (file: string, tables: readonly string[] = SCOPED_TABLES): CallSite[] => {
  const src = readFileSync(file, "utf8");
  const sites: CallSite[] = [];
  const re = /\.from\(\s*["'`](\w+)["'`]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const table = m[1];
    if (!tables.includes(table)) continue;
    const rest = src.slice(m.index, m.index + 1200);
    const end = rest.indexOf(";");
    const chain = end === -1 ? rest : rest.slice(0, end);
    sites.push({
      file,
      line: src.slice(0, m.index).split("\n").length,
      table,
      chain,
    });
  }
  return sites;
};

const scopesLanguage = (chain: string) =>
  chain.includes("learning_language") ||
  // scoped by a primary key that is already language-unique
  /\.eq\(\s*["'`]id["'`]/.test(chain) ||
  /\.eq\(\s*["'`](chunk_id|session_id)["'`]/.test(chain) ||
  /\.in\(\s*["'`]id["'`]/.test(chain) ||
  Object.keys(ALLOWLIST).some((k) => chain.includes(`/* lint:${k} */`));

describe("language scoping guardrail", () => {
  const sites = ROOTS.flatMap((r) => walk(r)).flatMap((f) => callSites(f, SCOPED_TABLES));
  const vocabCacheSites = walk("src").flatMap((f) => callSites(f, ["episode_vocab_cache"]));

  it("finds the language-scoped query call sites", () => {
    expect(sites.length).toBeGreaterThan(10);
    expect(vocabCacheSites.length).toBeGreaterThan(0);
  });

  it("every language-scoped query filters on learning_language", () => {
    const offenders = sites
      .filter((s) => !scopesLanguage(s.chain))
      .map((s) => `${s.file}:${s.line} -> ${s.table}`);
    expect(offenders).toEqual([]);
  });

  it("every episode_vocab_cache query in src/ filters on language", () => {
    const offenders = vocabCacheSites
      .filter((s) => !/\.eq\(\s*["'`]language["'`]/.test(s.chain))
      .map((s) => `${s.file}:${s.line} -> ${s.table}`);
    expect(offenders).toEqual([]);
  });
});
