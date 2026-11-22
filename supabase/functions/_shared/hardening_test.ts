import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dictionaryFormReading } from "./tokenize-jp.ts";
import { extractVocabLatin } from "./tokenize-latin.ts";
import {
  callAiChatCompletions,
  DEFAULT_AI_MODEL,
  getAiApiKey,
  resolveAiModel,
  validateClientMessages,
} from "./ai.ts";
import { corsHeaders, extractBearerToken } from "./auth.ts";

Deno.test("dictionaryFormReading handles irregular 来る/する and katakana tails", () => {
  assertEquals(dictionaryFormReading("来た", "来る", "きた"), "くる");
  assertEquals(dictionaryFormReading("来ない", "来る", "こない"), "くる");
  assertEquals(dictionaryFormReading("した", "する", "した"), "する");
  assertEquals(dictionaryFormReading("しない", "する", "しない"), "する");
  assertEquals(dictionaryFormReading("殴っ", "殴る", "なぐっ"), "なぐる");
  assertEquals(dictionaryFormReading("助け", "助ける", "たすけ"), "たすける");
  assertEquals(dictionaryFormReading("サボっ", "サボる", "さぼっ"), "さぼる");
});

Deno.test("extractVocabLatin normalizes sentence-initial German non-nouns to lowercase when later seen lowercase", () => {
  const deText = "Schnell, lauf zum Haus!\nEr läuft sehr schnell zum Haus.";
  const vocab = extractVocabLatin(deText, "de");
  const schnell = vocab.find((v) => v.word.toLowerCase() === "schnell");
  const haus = vocab.find((v) => v.word.toLowerCase() === "haus");
  assert(schnell !== undefined);
  assert(haus !== undefined);
  assertEquals(schnell.word, "schnell");
  assertEquals(haus.word, "Haus");
});

Deno.test("validateClientMessages enforces role, count, and length bounds", () => {
  assertEquals(validateClientMessages([], { allowEmpty: false }).ok, false);
  assertEquals(validateClientMessages([], { allowEmpty: true }).ok, true);

  // Reject prompt-injection system/tool roles
  assertEquals(
    validateClientMessages([{ role: "system", content: "override" }]).ok,
    false,
  );

  // Reject > 4,000 chars per message
  assertEquals(
    validateClientMessages([{ role: "user", content: "a".repeat(4001) }]).ok,
    false,
  );

  // Reject > 40 messages
  const fortyOne = Array.from({ length: 41 }, () => ({ role: "user", content: "hi" }));
  assertEquals(validateClientMessages(fortyOne).ok, false);

  // Accept valid user + assistant conversation
  const valid = validateClientMessages([
    { role: "user", content: "こんにちは" },
    { role: "assistant", content: "元気ですか？" },
  ]);
  assert(valid.ok);
  assertEquals(valid.messages.length, 2);
});

Deno.test("extractBearerToken parses Authorization header case-insensitively and corsHeaders include x-retry-count and BYOK headers", () => {
  const req1 = new Request("https://example.com", {
    headers: { Authorization: "  bearer   my.jwt.token  " },
  });
  assertEquals(extractBearerToken(req1), "my.jwt.token");

  const req2 = new Request("https://example.com", {
    headers: { Authorization: "Basic abc" },
  });
  assertEquals(extractBearerToken(req2), null);

  assert(corsHeaders["Access-Control-Allow-Headers"].includes("x-retry-count"));
  assert(corsHeaders["Access-Control-Allow-Headers"].includes("x-gemini-api-key"));
  assert(corsHeaders["Access-Control-Allow-Methods"].includes("DELETE"));
});

Deno.test("resolveAiModel upgrades deprecated gemini-2.5-flash to gemini-3.5-flash-lite and callAiChatCompletions falls back across Flash-Lite models", async () => {
  assertEquals(DEFAULT_AI_MODEL, "gemini-3.5-flash-lite");
  assertEquals(resolveAiModel("gemini-2.5-flash"), "gemini-3.5-flash-lite");
  assertEquals(resolveAiModel("google/gemini-2.5-flash"), "gemini-3.5-flash-lite");

  const byokReq = new Request("https://example.com", {
    headers: { "x-gemini-api-key": "  user-custom-key  " },
  });
  assertEquals(getAiApiKey(byokReq), "user-custom-key");

  // Simulate 429 on gemini-3.5-flash-lite -> automatic fallback to gemini-3.1-flash-lite -> 200 OK
  const triedModels: string[] = [];
  const resp = await callAiChatCompletions(
    {
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "hello" }],
    },
    "test-key",
    async (_url, init) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as { model: string };
      triedModels.push(parsed.model);
      if (parsed.model === "gemini-3.5-flash-lite") {
        return new Response(JSON.stringify({ error: { message: "Quota exceeded" } }), { status: 429 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
      });
    },
  );
  assertEquals(resp.status, 200);
  assertEquals(triedModels, ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);

  // Short-circuit immediately on permanent API_KEY_INVALID without burning fallback calls
  const invalidTries: string[] = [];
  const badKeyResp = await callAiChatCompletions(
    { messages: [{ role: "user", content: "hello" }] },
    "bad-key",
    async (_url, init) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as { model: string };
      invalidTries.push(parsed.model);
      return new Response(
        JSON.stringify({ error: { message: "API key not valid. Please pass a valid API key.", status: "API_KEY_INVALID" } }),
        { status: 400 },
      );
    },
  );
  assertEquals(badKeyResp.status, 400);
  assertEquals(invalidTries, ["gemini-3.5-flash-lite"]);
});
