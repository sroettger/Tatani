import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Guardrail: every AI-facing edge function must resolve the learner's
 * languages instead of hardcoding Japanese, and must tell the model which
 * language to explain in.
 */
const AI_FUNCTIONS = ["episode-summary", "episode-discuss", "tutor-chat", "recommend-anime"];

const read = async (fn: string) => await Deno.readTextFile(`supabase/functions/${fn}/index.ts`);

Deno.test("AI functions resolve the learner's languages", async () => {
  for (const fn of AI_FUNCTIONS) {
    const src = await read(fn);
    assert(
      src.includes("getUserLanguages") || src.includes("langInfo"),
      `${fn} does not resolve the learning language`,
    );
    assert(
      src.includes("uiLanguageName") || src.includes("uiLanguage"),
      `${fn} does not resolve the UI language`,
    );
  }
});

Deno.test("AI functions do not hardcode Japanese in prompts", async () => {
  for (const fn of AI_FUNCTIONS) {
    const src = await read(fn);
    // Prompt text must reference the resolved language, not a literal.
    // JLPT level descriptions (N5..N1) are Japanese-only by definition.
    const promptish = src.split("\n").filter((l) =>
      /Japanese|日本語/.test(l) && !/^\s*(\/\/|\*)/.test(l) && !/^\s*N[1-5]:/.test(l)
    );
    for (const line of promptish) {
      assert(
        line.includes("learning.name") ||
          line.includes("learning.native") ||
          line.includes("uiLanguageName") ||
          line.includes("langInfo") ||
          line.includes("LANGUAGES"),
        `${fn} hardcodes a language in: ${line.trim()}`,
      );
    }
  }
});

Deno.test("user-scoped edge function queries filter by learning_language", async () => {
  const SCOPED = [
    "user_anime",
    "user_word_state",
    "study_chunks",
    "study_sessions",
    "quiz_results",
    "episode_summaries",
  ];
  for await (const dir of Deno.readDir("supabase/functions")) {
    if (!dir.isDirectory || dir.name.startsWith("_")) continue;
    let src: string;
    try {
      src = await Deno.readTextFile(`supabase/functions/${dir.name}/index.ts`);
    } catch {
      continue;
    }
    const re = /\.from\(\s*["'`](\w+)["'`]\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      if (!SCOPED.includes(m[1])) continue;
      const rest = src.slice(m.index, m.index + 1200);
      const end = rest.indexOf(";");
      const chain = end === -1 ? rest : rest.slice(0, end);
      assert(
        chain.includes("learning_language") || /\.eq\(\s*["'`]id["'`]/.test(chain),
        `${dir.name} queries ${m[1]} without scoping learning_language`,
      );
    }
  }
});
