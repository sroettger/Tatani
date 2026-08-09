import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { LANGUAGES, DEFAULT_LEARNING_LANG, langInfo, uiLanguageName, getUserLanguages } from "./languages.ts";

Deno.test("langInfo falls back to the default for unknown or missing codes", () => {
  assertEquals(langInfo("de").code, "de");
  assertEquals(langInfo("klingon").code, DEFAULT_LEARNING_LANG);
  assertEquals(langInfo(null).code, DEFAULT_LEARNING_LANG);
  assertEquals(langInfo(undefined).code, DEFAULT_LEARNING_LANG);
});

Deno.test("every language carries a full config", () => {
  for (const [code, info] of Object.entries(LANGUAGES)) {
    assertEquals(info.code, code);
    assert(info.name.length > 0, `${code} name`);
    assert(info.native.length > 0, `${code} native`);
    assert(info.levels.length >= 5, `${code} levels`);
    assert(info.subtitleLang.length > 0, `${code} subtitleLang`);
    assertEquals(info.morphological, code === "ja");
    assertEquals(info.scale, code === "ja" ? "jlpt" : "cefr");
  }
});

Deno.test("uiLanguageName maps to a prompt-friendly name", () => {
  assertEquals(uiLanguageName("ja"), "Japanese (日本語)");
  assertEquals(uiLanguageName("en"), "English");
  assertEquals(uiLanguageName(null), "English");
});

/** Chainable stub good enough for the two queries getUserLanguages makes. */
function stubClient(profile: unknown, progress: unknown) {
  const seen: Array<Record<string, unknown>> = [];
  const client = {
    seen,
    from(table: string) {
      const rec: Record<string, unknown> = { table };
      seen.push(rec);
      const api = {
        select: () => api,
        eq: (k: string, v: unknown) => {
          rec[k] = v;
          return api;
        },
        maybeSingle: async () => ({ data: table === "profiles" ? profile : progress }),
      };
      return api;
    },
  };
  return client;
}

Deno.test("getUserLanguages reads the learner's language from the profile", async () => {
  const client = stubClient({ ui_language: "ja", learning_language: "de" }, { level: "B1" });
  const res = await getUserLanguages(client, "u1");
  assertEquals(res.learning.code, "de");
  assertEquals(res.uiLanguage, "ja");
  assertEquals(res.level, "B1");
});

Deno.test("getUserLanguages scopes the progress lookup to the learning language", async () => {
  const client = stubClient({ ui_language: "en", learning_language: "de" }, { level: "A2" });
  await getUserLanguages(client, "u1");
  const progressQuery = client.seen.find((q) => q.table === "user_language_progress")!;
  assertEquals(progressQuery.learning_language, "de");
  assertEquals(progressQuery.user_id, "u1");
});

Deno.test("getUserLanguages defaults when the profile is empty", async () => {
  const client = stubClient(null, null);
  const res = await getUserLanguages(client, "u1");
  assertEquals(res.learning.code, DEFAULT_LEARNING_LANG);
  assertEquals(res.uiLanguage, "en");
  assertEquals(res.level, "none");
});
