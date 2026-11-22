import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  dictionaryFormReading,
  extractVocabWithTokenizer,
  type JapaneseTokenizer,
  type Token,
} from "./tokenize-jp.ts";
import { extractVocabLatin } from "./tokenize-latin.ts";
import { rankVocabBySeasonAndUtility } from "./season-corpus.ts";
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

Deno.test("extractVocabLatin normalizes German non-nouns and filters Spanish/French proper names", () => {
  const deText = "Schnell, lauf zum Haus!\nEr läuft sehr schnell zum Haus.";
  const vocab = extractVocabLatin(deText, "de");
  const schnell = vocab.find((v) => v.word.toLowerCase() === "schnell");
  const haus = vocab.find((v) => v.word.toLowerCase() === "haus");
  assert(schnell !== undefined);
  assert(haus !== undefined);
  assertEquals(schnell.word, "schnell");
  assertEquals(haus.word, "Haus");

  // Spanish: character names Anya & Loid appear capitalized mid-sentence and never lowercase -> dropped;
  // real words promesa & misión are preserved.
  const esText = "Hola Anya, tenemos una misión secreta.\nAnya hizo una promesa con Loid hoy.";
  const esVocab = extractVocabLatin(esText, "es");
  const esWords = new Set(esVocab.map((v) => v.word));
  assert(!esWords.has("anya"), "expected Anya to be filtered as proper name");
  assert(!esWords.has("loid"), "expected Loid to be filtered as proper name");
  assert(esWords.has("misión"));
  assert(esWords.has("promesa"));
});

Deno.test("extractVocabWithTokenizer drops 固有名詞, honorific-bound coined names, vocative katakana names, and nakaguro names while keeping real vocab", () => {
  const lineMap: Record<string, Token[]> = {
    "アーニャちゃんは約束を守る": [
      { surface_form: "アーニャ", basic_form: "アーニャ", reading: "アーニャ", pos: "名詞", pos_detail_1: "一般" },
      { surface_form: "ちゃん", basic_form: "ちゃん", reading: "チャン", pos: "名詞", pos_detail_1: "接尾", pos_detail_2: "人名" },
      { surface_form: "は", basic_form: "は", pos: "助詞" },
      { surface_form: "約束", basic_form: "約束", reading: "ヤクソク", pos: "名詞", pos_detail_1: "サ変接続" },
      { surface_form: "を", basic_form: "を", pos: "助詞" },
      { surface_form: "守る", basic_form: "守る", reading: "マモル", pos: "動詞", pos_detail_1: "自立" },
    ],
    "アーニャも秘密を知る": [
      // Even without -ちゃん on this line, アーニャ was identified as a character name across the episode!
      { surface_form: "アーニャ", basic_form: "アーニャ", reading: "アーニャ", pos: "名詞", pos_detail_1: "一般" },
      { surface_form: "も", basic_form: "も", pos: "助詞" },
      { surface_form: "秘密", basic_form: "秘密", reading: "ヒミツ", pos: "名詞", pos_detail_1: "一般" },
      { surface_form: "を", basic_form: "を", pos: "助詞" },
      { surface_form: "知る", basic_form: "知る", reading: "シル", pos: "動詞", pos_detail_1: "自立" },
    ],
    "ロイドは東京で先生と話す": [
      { surface_form: "ロイド", basic_form: "ロイド", reading: "ロイド", pos: "名詞", pos_detail_1: "固有名詞", pos_detail_2: "人名" },
      { surface_form: "は", basic_form: "は", pos: "助詞" },
      { surface_form: "東京", basic_form: "東京", reading: "トウキョウ", pos: "名詞", pos_detail_1: "固有名詞", pos_detail_2: "地域" },
      { surface_form: "で", basic_form: "で", pos: "助詞" },
      { surface_form: "先生", basic_form: "先生", reading: "センセイ", pos: "名詞", pos_detail_1: "一般" },
      { surface_form: "と", basic_form: "と", pos: "助詞" },
      { surface_form: "話す", basic_form: "話す", reading: "ハナス", pos: "動詞", pos_detail_1: "自立" },
    ],
    "ルーシー！": [
      { surface_form: "ルーシー", basic_form: "ルーシー", reading: "ルーシー", pos: "名詞", pos_detail_1: "一般" },
      { surface_form: "！", basic_form: "！", pos: "記号" },
    ],
    "ルーシー、ドアを開けて": [
      { surface_form: "ルーシー", basic_form: "ルーシー", reading: "ルーシー", pos: "名詞", pos_detail_1: "一般" },
      { surface_form: "、", basic_form: "、", pos: "記号" },
      { surface_form: "ドア", basic_form: "ドア", reading: "ドア", pos: "名詞", pos_detail_1: "一般" },
      { surface_form: "を", basic_form: "を", pos: "助詞" },
      { surface_form: "開けて", basic_form: "開ける", reading: "アケテ", pos: "動詞", pos_detail_1: "自立" },
    ],
    "ロイド・フォージャーの任務": [
      { surface_form: "ロイド", basic_form: "ロイド", reading: "ロイド", pos: "名詞", pos_detail_1: "固有名詞", pos_detail_2: "人名" },
      { surface_form: "・", basic_form: "・", pos: "記号" },
      { surface_form: "フォージャー", basic_form: "フォージャー", reading: "フォージャー", pos: "名詞", pos_detail_1: "一般" },
      { surface_form: "の", basic_form: "の", pos: "助詞" },
      { surface_form: "任務", basic_form: "任務", reading: "ニンム", pos: "名詞", pos_detail_1: "一般" },
    ],
  };

  const mockTokenizer: JapaneseTokenizer = {
    tokenize: (line: string) => lineMap[line] ?? [],
  };

  const extracted = extractVocabWithTokenizer(mockTokenizer, Object.keys(lineMap).join("\n"));
  const words = new Set(extracted.map((e) => e.word));

  assert(!words.has("アーニャ"), "coined honorific character name アーニャ should be filtered");
  assert(!words.has("ロイド"), "IPADIC 固有名詞 ロイド should be filtered");
  assert(!words.has("東京"), "IPADIC 固有名詞 東京 should be filtered");
  assert(!words.has("ルーシー"), "vocative katakana name ルーシー should be filtered");
  assert(!words.has("フォージャー"), "nakaguro surname フォージャー should be filtered");

  assert(words.has("約束"));
  assert(words.has("守る"));
  assert(words.has("秘密"));
  assert(words.has("先生"));
  assert(words.has("ドア"));
  assert(words.has("任務"));
});

Deno.test("rankVocabBySeasonAndUtility ranks recurring multi-episode & JLPT words above one-scene gag words", () => {
  const entries = [
    {
      word: "クラゲ", // One-off jellyfish mentioned 6x in a single aquarium scene, 0x in rest of season
      reading: "くらげ",
      part_of_speech: "名詞",
      frequency: 6,
      example_sentence_jp: "クラゲが泳いでいる",
    },
    {
      word: "約束", // Core N4 word mentioned 2x in this episode and across 4 other season episodes
      reading: "やくそく",
      part_of_speech: "名詞",
      frequency: 2,
      example_sentence_jp: "約束を守るよ",
    },
    {
      word: "標的", // Unlisted genre word recurring across 3 other episodes in the spy season
      reading: "ひょうてき",
      part_of_speech: "名詞",
      frequency: 2,
      example_sentence_jp: "標的を確認した",
    },
  ];

  const siblingDocFreq = new Map<string, number>([
    ["約束", 4],
    ["標的", 3],
  ]);

  const ranked = rankVocabBySeasonAndUtility(
    entries,
    (e) => (e.word === "約束" ? "N4" : "none"),
    siblingDocFreq,
    5,
  );

  assertEquals(ranked[0].word, "約束");
  assertEquals(ranked[1].word, "標的");
  assertEquals(ranked[2].word, "クラゲ");
  assert(ranked[0].frequency > ranked[2].frequency);
  assertEquals(ranked[0].episodeFrequency, 2);
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
