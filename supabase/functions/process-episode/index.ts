// Process an episode's subtitles: tokenize (kuromoji for Japanese, word-boundary
// tokenizer for latin-script languages), frequency-rank, then ask the AI for
// meanings + grammar (in the learner's UI language) based on real example sentences.
import {
  corsHeaders,
  createAdminClient,
  jsonResponse,
  requireAuthUser,
} from "../_shared/auth.ts";
import {
  callAiChatCompletions,
  DEFAULT_AI_MODEL,
  extractAiErrorDetail,
  getAiApiKey,
} from "../_shared/ai.ts";
import { getOfficialJlptLevel } from "../_shared/jlpt-lookup.ts";
import {
  rankVocabBySeasonAndUtility,
  sampleKitsunekkoSiblingDialogues,
  type SeasonRankedVocab,
} from "../_shared/season-corpus.ts";
import { cleanSubtitleDialogue } from "../_shared/subtitles.ts";
import {
  extractVocabFromSubtitles,
  extractWordSetFromSubtitles,
  type VocabEntry,
} from "../_shared/tokenize-jp.ts";
import { extractVocabLatin } from "../_shared/tokenize-latin.ts";
import { getUserLanguages, uiLanguageName } from "../_shared/languages.ts";

const MAX_SUBTITLE_LENGTH = 600_000;
const BATCH_SIZE = 100;
const MAX_CONCURRENCY = 2;
const MOBILE_SYNC_WORD_CAP = 200;

type UnusualKanaSuggestion = {
  kana_surface?: unknown;
  canonical_word?: unknown;
  reading?: unknown;
  meaning?: unknown;
  part_of_speech?: unknown;
  example_sentence_jp?: unknown;
  example_sentence_en?: unknown;
};

type GrammarItem = {
  pattern: string;
  meaning: string;
  example_jp: string;
  example_en: string;
  jlpt_level: string;
};

type TranslatedWord = {
  meaning: string;
  example_en: string;
  level: string;
  is_proper_noun: boolean;
};

type TaggedVocab = SeasonRankedVocab;

type CachedVocabItem = {
  word: string;
  reading: string;
  part_of_speech: string;
  jlpt_level: string;
  level: string;
  meaning: string;
  example_sentence_jp: string;
  example_sentence_en: string;
  frequency: number;
  episode_frequency?: number;
};

type BatchResult = {
  meanings: Map<string, TranslatedWord>;
  grammar: GrammarItem[];
};

const edgeRuntime = (
  globalThis as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }
).EdgeRuntime;

// AI tool: find common Japanese words written in unusual kana-only form (childish speech, stylization)
// that morphological tokenizers like kuromoji split into meaningless fragments. Japanese-only.
const UNUSUAL_KANA_TOOL = {
  type: "function",
  function: {
    name: "report_unusual_kana_spellings",
    description:
      "Report common Japanese vocabulary words that appear in the subtitle text written in unusual kana-only form (e.g. じなん for 次男, ぱぱ for パパ) which morphological tokenizers typically fail to recognize as a single word.",
    parameters: {
      type: "object",
      properties: {
        words: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kana_surface: {
                type: "string",
                description: "EXACT kana substring as it appears in the subtitle text (e.g. じなん)",
              },
              canonical_word: {
                type: "string",
                description: "Standard dictionary form, usually with kanji (e.g. 次男)",
              },
              reading: { type: "string", description: "Hiragana reading of the canonical word" },
              meaning: { type: "string", description: "Concise meaning" },
              part_of_speech: { type: "string", description: "Japanese POS tag like 名詞, 動詞, 形容詞" },
              example_sentence_jp: {
                type: "string",
                description: "MUST be an actual line from the supplied subtitle text containing kana_surface",
              },
              example_sentence_en: { type: "string", description: "Natural translation of that sentence" },
            },
            required: [
              "kana_surface",
              "canonical_word",
              "reading",
              "meaning",
              "part_of_speech",
              "example_sentence_jp",
              "example_sentence_en",
            ],
            additionalProperties: false,
          },
        },
      },
      required: ["words"],
      additionalProperties: false,
    },
  },
};

function buildTranslateTool(levels: string[]) {
  return {
    type: "function",
    function: {
      name: "translate_vocab_and_extract_grammar",
      description:
        "For each given target-language vocabulary item, return a meaning (in the learner's own language) that fits the example sentence, plus a difficulty level. Also extract grammar points used across these sentences.",
      parameters: {
        type: "object",
        properties: {
          vocab: {
            type: "array",
            items: {
              type: "object",
              properties: {
                word: { type: "string", description: "MUST exactly match one of the input words" },
                meaning: {
                  type: "string",
                  description:
                    "Concise meaning (in the learner's own language) that fits the example sentence context",
                },
                example_sentence_en: {
                  type: "string",
                  description:
                    "Natural translation of THIS word's example sentence, in the learner's own language",
                },
                level: {
                  type: "string",
                  enum: [...levels, "none"],
                  description: "Difficulty level of this word on the requested scale",
                },
                is_proper_noun: {
                  type: "boolean",
                  description:
                    "true if this item is a character/person name, surname, nickname, place/country/city name, organization/brand name, fictional proper noun, vocal interjection/SFX, or broken non-word fragment; false for genuine learnable vocabulary",
                },
              },
              required: ["word", "meaning", "example_sentence_en", "level", "is_proper_noun"],
              additionalProperties: false,
            },
          },
          grammar: {
            type: "array",
            items: {
              type: "object",
              properties: {
                pattern: { type: "string" },
                meaning: { type: "string" },
                example_jp: { type: "string", description: "MUST be one of the supplied example sentences" },
                example_en: { type: "string" },
                jlpt_level: { type: "string", enum: [...levels, "none"] },
              },
              required: ["pattern", "meaning", "example_jp", "example_en", "jlpt_level"],
              additionalProperties: false,
            },
          },
        },
        required: ["vocab", "grammar"],
        additionalProperties: false,
      },
    },
  };
}

async function detectUnusualKanaSpellings(
  cleanedText: string,
  lines: string[],
  alreadyKnown: Set<string>,
  apiKey: string,
): Promise<VocabEntry[]> {
  const MAX_CHARS = 12000;
  const sample = cleanedText.length > MAX_CHARS ? cleanedText.slice(0, MAX_CHARS) : cleanedText;

  const userMessage = `Below is the Japanese subtitle text from one anime episode. Identify any common Japanese vocabulary words (nouns, verbs, adjectives) that appear written in an UNUSUAL KANA-ONLY form — for example: じなん instead of 次男, ぱぱ instead of パパ, おかあさん written as おかーさん, etc. These are typically childish speech, baby talk, or stylized renderings that morphological tokenizers miss.

Only report words where:
- The kana surface form ACTUALLY appears as a contiguous substring in the text below
- The word is a meaningful general-language content word (NOT a character name, nickname, proper noun, particle, interjection, or onomatopoeia)
- A learner would benefit from knowing the canonical kanji form

Do NOT report character names, place names, or words already in standard kanji form. Return at most 25 entries.

SUBTITLE TEXT:
${sample}`;

  try {
    const aiResp = await callAiChatCompletions(
      {
        model: DEFAULT_AI_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You help Japanese language learners by spotting common words written in unusual kana spellings that morphological tokenizers fail to recognize. You MUST call the report_unusual_kana_spellings function.",
          },
          { role: "user", content: userMessage },
        ],
        tools: [UNUSUAL_KANA_TOOL],
        tool_choice: { type: "function", function: { name: "report_unusual_kana_spellings" } },
      },
      apiKey,
    );
    if (!aiResp.ok) {
      console.warn(`unusual-kana AI call failed: ${aiResp.status}`);
      return [];
    }
    const aiJson = (await aiResp.json()) as {
      choices?: Array<{ message?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }>;
    };
    const call = aiJson?.choices?.[0]?.message?.tool_calls?.[0];
    if (!call?.function?.arguments) return [];
    const parsed = JSON.parse(call.function.arguments) as { words?: UnusualKanaSuggestion[] };
    const suggestions: UnusualKanaSuggestion[] = Array.isArray(parsed.words) ? parsed.words : [];

    const out: VocabEntry[] = [];
    const seen = new Set<string>();
    for (const s of suggestions) {
      if (!s?.kana_surface || !s?.canonical_word) continue;
      const surface = String(s.kana_surface).trim();
      const canonical = String(s.canonical_word).trim();
      if (!surface || !canonical) continue;
      if (alreadyKnown.has(canonical) || seen.has(canonical)) continue;
      if (!cleanedText.includes(surface)) {
        console.log(`Skipping hallucinated kana surface: ${surface}`);
        continue;
      }
      let exampleLine = String(s.example_sentence_jp ?? "").trim();
      if (!exampleLine || !exampleLine.includes(surface) || !lines.includes(exampleLine)) {
        exampleLine = lines.find((l) => l.includes(surface)) ?? "";
      }
      if (!exampleLine) continue;
      const freq = (
        cleanedText.match(new RegExp(surface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []
      ).length;
      seen.add(canonical);
      out.push({
        word: canonical,
        reading: String(s.reading ?? "").trim(),
        part_of_speech: String(s.part_of_speech ?? "名詞").trim(),
        frequency: Math.max(1, freq),
        example_sentence_jp: exampleLine,
      });
    }
    return out;
  } catch (e) {
    console.warn("detectUnusualKanaSpellings error:", e instanceof Error ? e.message : String(e));
    return [];
  }
}

function buildTopSentences(vocab: CachedVocabItem[]): { jp: string; en: string }[] {
  const sentenceSet = new Set<string>();
  const sentences: { jp: string; en: string }[] = [];
  for (const v of vocab) {
    if (v.example_sentence_jp && !sentenceSet.has(v.example_sentence_jp)) {
      sentenceSet.add(v.example_sentence_jp);
      sentences.push({ jp: v.example_sentence_jp, en: v.example_sentence_en });
      if (sentences.length >= 60) break;
    }
  }
  return sentences;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const auth = await requireAuthUser(req);
    if (auth instanceof Response) return auth;
    const { userId } = auth;

    const aiApiKey = getAiApiKey(req);

    const { episode_id, subtitle_text, wait } = (await req.json()) as {
      episode_id?: unknown;
      subtitle_text?: unknown;
      wait?: unknown;
    };
    if (typeof episode_id !== "string" || !episode_id.trim() || typeof subtitle_text !== "string" || !subtitle_text.trim()) {
      return jsonResponse({ error: "episode_id and subtitle_text required" }, 400);
    }
    if (subtitle_text.length > MAX_SUBTITLE_LENGTH) {
      return jsonResponse(
        { error: `subtitle_text exceeds maximum length (${MAX_SUBTITLE_LENGTH} characters)` },
        413,
      );
    }

    const clientInfo = req.headers.get("x-client-info") ?? "";
    const isWebPollingClient = clientInfo.includes("supabase-js") && !wait;
    const waitForCompletion = !isWebPollingClient;

    const supabase = createAdminClient();

    // Verify episode_id exists and fetch season + anime metadata for name filtering & season dispersion.
    const { data: epRow, error: epErr } = await supabase
      .from("episodes")
      .select(
        "id, episode_number, season_id, seasons(id, season_number, anime_id, anime(id, title_romaji, title_en, title_jp))",
      )
      .eq("id", episode_id)
      .maybeSingle();
    if (epErr || !epRow) {
      return jsonResponse({ error: "Episode not found" }, 404);
    }

    type NestedAnimeMeta = {
      id?: string;
      title_romaji?: string | null;
      title_en?: string | null;
      title_jp?: string | null;
    };
    type NestedSeasonMeta = {
      id?: string;
      season_number?: number | null;
      anime_id?: string | null;
      anime?: NestedAnimeMeta | null;
    };
    const seasonMeta = (epRow as { seasons?: NestedSeasonMeta | null }).seasons;
    const animeMeta = seasonMeta?.anime;
    const seasonId = (epRow as { season_id?: string | null }).season_id ?? seasonMeta?.id ?? null;
    const seasonNumber = seasonMeta?.season_number ?? 1;
    const episodeNumber = (epRow as { episode_number?: number | null }).episode_number ?? 1;
    const animeTitles = [animeMeta?.title_en, animeMeta?.title_romaji, animeMeta?.title_jp]
      .map((t) => (typeof t === "string" ? t.trim() : ""))
      .filter((t) => t.length > 0);
    const animeContextTitle = animeTitles[0] ?? "Anime episode";

    const { learning, uiLanguage } = await getUserLanguages(supabase, userId);
    const explainLang = uiLanguageName(uiLanguage);
    const isJapanese = learning.code === "ja";

    // Cache hit? Cache is keyed per (episode_id, language).
    const { data: existing } = await supabase
      .from("episode_vocab_cache")
      .select("vocab,grammar,sentences")
      .eq("episode_id", episode_id)
      .eq("language", learning.code)
      .maybeSingle();
    if (existing && Array.isArray(existing.vocab) && existing.vocab.length > 0) {
      await supabase.from("episodes").update({ processing_status: "ready" }).eq("id", episode_id);
      return jsonResponse({ cached: true, ...existing });
    }

    const cleaned = cleanSubtitleDialogue(subtitle_text);
    if (!cleaned.trim()) {
      return jsonResponse({ error: "No usable subtitle dialogue found" }, 400);
    }

    await supabase
      .from("episodes")
      .update({ processing_status: "processing", processing_chunks_done: 0, processing_chunks_total: 0 })
      .eq("id", episode_id);

    const TRANSLATE_TOOL = buildTranslateTool(learning.levels);

    const callBatch = async (
      batch: TaggedVocab[],
      idx: number,
      onDone?: () => void,
    ): Promise<{ ok: true; data: BatchResult } | { ok: false; error: string }> => {
      const wordsPayload = batch.map((v) => ({
        word: v.word,
        reading: v.reading,
        part_of_speech: v.part_of_speech,
        example_sentence_jp: v.example_sentence_jp,
      }));
      const levelInstruction = isJapanese
        ? 'Each word already has an official JLPT level tagged separately — you do not need to re-assess level, just set it to "none".'
        : `Also assign each word a CEFR difficulty level (${learning.levels.join(", ")}) based on how common/advanced it is in ${learning.name}.`;
      const userMessage = `Anime context: "${animeContextTitle}" (Season ${seasonNumber}, Episode ${episodeNumber}).
Translate each ${learning.name} word below into ${explainLang} using its example sentence as context. ${levelInstruction}
IMPORTANT: Set is_proper_noun=true for ANY character name, surname, nickname, place/city/country name, organization/company name, fictional proper noun specific only to "${animeContextTitle}", vocal interjection/sound effect, or broken non-word fragment so learners only study genuine reusable ${learning.name} vocabulary.
Also extract meaningful grammar points used in these sentences (particles/conjugations/common patterns), each tagged with a difficulty level from: ${learning.levels.join(", ")}.

WORDS:
${JSON.stringify(wordsPayload, null, 2)}`;

      try {
        let lastErrMsg = "unknown AI error";
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const aiResp = await callAiChatCompletions(
              {
                model: DEFAULT_AI_MODEL,
                messages: [
                  {
                    role: "system",
                    content: `You are a ${learning.name}-to-${explainLang} translator helping language learners study reusable vocabulary from "${animeContextTitle}". Flag all character names, surnames, place/org names, fictional proper nouns, and vocal SFX with is_proper_noun=true. For real vocabulary words, provide a concise ${explainLang} meaning that fits the example sentence context, plus a natural ${explainLang} translation of that example sentence. Then extract grammar points actually used in the supplied sentences, explained in ${explainLang}. You MUST call the translate_vocab_and_extract_grammar function.`,
                  },
                  { role: "user", content: userMessage },
                ],
                tools: [TRANSLATE_TOOL],
                tool_choice: { type: "function", function: { name: "translate_vocab_and_extract_grammar" } },
              },
              aiApiKey,
            );

            if (!aiResp.ok) {
              const status = aiResp.status;
              const t = await aiResp.text();
              const detail = extractAiErrorDetail(t, status);
              if ((status === 429 || status === 500 || status === 502 || status === 503) && attempt < 2) {
                const backoffMs = 2500 * Math.pow(2, attempt) + Math.floor(Math.random() * 400);
                await new Promise((r) => setTimeout(r, backoffMs));
                continue;
              }
              throw new Error(`ai_${detail}`);
            }

            const aiJson = (await aiResp.json()) as {
              choices?: Array<{ message?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }>;
            };
            const call = aiJson?.choices?.[0]?.message?.tool_calls?.[0];
            if (!call?.function?.arguments) throw new Error("no_tool_call");

            const parsed = JSON.parse(call.function.arguments) as {
              vocab?: Array<{
                word?: string;
                meaning?: string;
                example_sentence_en?: string;
                level?: string;
                is_proper_noun?: boolean;
              }>;
              grammar?: Array<{
                pattern?: string;
                meaning?: string;
                example_jp?: string;
                example_en?: string;
                jlpt_level?: string;
              }>;
            };

            const meanings = new Map<string, TranslatedWord>();
            for (const v of parsed.vocab ?? []) {
              if (v?.word) {
                meanings.set(v.word, {
                  meaning: v.meaning ?? "",
                  example_en: v.example_sentence_en ?? "",
                  level: v.level ?? "none",
                  is_proper_noun: Boolean(v.is_proper_noun),
                });
              }
            }

            const grammar: GrammarItem[] = [];
            for (const g of parsed.grammar ?? []) {
              if (g?.pattern && g?.meaning) {
                grammar.push({
                  pattern: g.pattern,
                  meaning: g.meaning,
                  example_jp: g.example_jp ?? "",
                  example_en: g.example_en ?? "",
                  jlpt_level: g.jlpt_level ?? "none",
                });
              }
            }

            return { ok: true, data: { meanings, grammar } };
          } catch (attemptErr) {
            lastErrMsg = attemptErr instanceof Error ? attemptErr.message : String(attemptErr);
            if (attempt < 2 && !lastErrMsg.startsWith("ai_40") && !lastErrMsg.startsWith("ai_429")) {
              const backoffMs = 2000 * Math.pow(2, attempt) + Math.floor(Math.random() * 400);
              await new Promise((r) => setTimeout(r, backoffMs));
              continue;
            }
            break;
          }
        }
        console.warn(`Batch ${idx} failed:`, lastErrMsg);
        return { ok: false, error: lastErrMsg.replace(/^ai_/, "") };
      } finally {
        onDone?.();
      }
    };

    const translateSlice = async (
      slice: TaggedVocab[],
      trackProgress: boolean,
    ): Promise<{
      vocab: CachedVocabItem[];
      grammarMap: Map<string, GrammarItem>;
      okBatches: number;
      totalBatches: number;
      firstError: string | null;
    }> => {
      const batches: TaggedVocab[][] = [];
      for (let i = 0; i < slice.length; i += BATCH_SIZE) {
        batches.push(slice.slice(i, i + BATCH_SIZE));
      }

      if (trackProgress) {
        await supabase
          .from("episodes")
          .update({ processing_chunks_total: batches.length, processing_chunks_done: 0 })
          .eq("id", episode_id);
      }

      let chunksDone = 0;
      const bumpProgress = trackProgress
        ? () => {
            chunksDone++;
            supabase
              .from("episodes")
              .update({ processing_chunks_done: chunksDone })
              .eq("id", episode_id)
              .then(({ error }) => {
                if (error) console.warn("progress update failed:", error.message);
              });
          }
        : undefined;

      const results: Array<{ ok: true; data: BatchResult } | { ok: false; error: string }> = new Array(
        batches.length,
      );
      let cursor = 0;
      const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, batches.length) }, async () => {
        while (true) {
          const i = cursor++;
          if (i >= batches.length) return;
          results[i] = await callBatch(batches[i], i, bumpProgress);
        }
      });
      await Promise.all(workers);

      const allMeanings = new Map<string, TranslatedWord>();
      const grammarMap = new Map<string, GrammarItem>();
      let okBatches = 0;
      let firstError: string | null = null;
      for (const r of results) {
        if (!r.ok) {
          if (!firstError) firstError = r.error;
          continue;
        }
        okBatches++;
        for (const [w, m] of r.data.meanings) allMeanings.set(w, m);
        for (const g of r.data.grammar) {
          if (g.pattern && !grammarMap.has(g.pattern)) grammarMap.set(g.pattern, g);
        }
      }

      const vocab: CachedVocabItem[] = slice
        .map((v) => {
          const m = allMeanings.get(v.word);
          const level = isJapanese ? v.level : (m?.level ?? "none");
          return {
            word: v.word,
            reading: isJapanese ? v.reading : "",
            part_of_speech: v.part_of_speech,
            jlpt_level: level,
            level,
            meaning: (m?.meaning ?? "").trim(),
            example_sentence_jp: v.example_sentence_jp,
            example_sentence_en: (m?.example_en ?? "").trim(),
            frequency: v.frequency,
            episode_frequency: v.episodeFrequency,
            _skipProper: Boolean(m?.is_proper_noun),
          };
        })
        .filter((v) => v.meaning.length > 0 && !v._skipProper)
        .map(({ _skipProper: _dropped, ...cleanItem }) => cleanItem);

      return { vocab, grammarMap, okBatches, totalBatches: batches.length, firstError };
    };

    const gatherSeasonDispersion = async (): Promise<{
      siblingDocFreq: Map<string, number>;
      sampledSiblingCount: number;
    }> => {
      const siblingDocFreq = new Map<string, number>();
      let sampledSiblingCount = 0;

      try {
        // 1. Reuse any already-cached sibling episodes in the same season (instant DB read, 0 AI).
        if (seasonId) {
          const { data: sibEps } = await supabase
            .from("episodes")
            .select("id")
            .eq("season_id", seasonId)
            .neq("id", episode_id)
            .limit(24);
          const sibIds = (sibEps ?? []).map((e: { id: string }) => e.id);
          if (sibIds.length > 0) {
            const { data: sibCaches } = await supabase
              .from("episode_vocab_cache")
              .select("episode_id, vocab")
              .eq("language", learning.code)
              .in("episode_id", sibIds)
              .limit(12);
            for (const row of sibCaches ?? []) {
              const list = Array.isArray(row.vocab) ? (row.vocab as Array<{ word?: string }>) : [];
              if (list.length === 0) continue;
              sampledSiblingCount++;
              const seenInEp = new Set<string>();
              for (const item of list) {
                if (item?.word && !seenInEp.has(item.word)) {
                  seenInEp.add(item.word);
                  siblingDocFreq.set(item.word, (siblingDocFreq.get(item.word) ?? 0) + 1);
                }
              }
            }
          }
        }

        // 2. If fewer than 4 cached sibling episodes exist for a Japanese anime, sample up to 5
        // sibling episode subtitle files from Kitsunekko in parallel (<= 3.2s budget, 0 AI calls!).
        if (isJapanese && sampledSiblingCount < 4 && animeTitles.length > 0) {
          const dialogues = await sampleKitsunekkoSiblingDialogues({
            titles: animeTitles,
            season: seasonNumber,
            excludeEpisode: episodeNumber,
            maxSamples: 5,
            timeoutMs: 3200,
          });
          for (const dlg of dialogues) {
            const wordSet = await extractWordSetFromSubtitles(dlg);
            if (wordSet.size === 0) continue;
            sampledSiblingCount++;
            for (const w of wordSet) {
              siblingDocFreq.set(w, (siblingDocFreq.get(w) ?? 0) + 1);
            }
          }
        }
      } catch (dispErr) {
        console.warn(
          `Episode ${episode_id} season dispersion fallback:`,
          dispErr instanceof Error ? dispErr.message : String(dispErr),
        );
      }

      return { siblingDocFreq, sampledSiblingCount };
    };

    const work = (async (): Promise<
      | {
          ok: true;
          count: number;
          remainingTagged: TaggedVocab[];
          initialVocab: CachedVocabItem[];
          initialGrammar: Map<string, GrammarItem>;
          siblingDocFreq: Map<string, number>;
          sampledSiblingCount: number;
        }
      | { ok: false; error: string }
    > => {
      try {
        const [{ siblingDocFreq, sampledSiblingCount }, allVocab] = await Promise.all([
          gatherSeasonDispersion(),
          isJapanese
            ? extractVocabFromSubtitles(cleaned)
            : Promise.resolve(extractVocabLatin(cleaned, learning.code)),
        ]);
        console.log(
          `Episode ${episode_id} [${learning.code}]: tokenized → ${allVocab.length} unique words (season sibling samples: ${sampledSiblingCount})`,
        );

        if (isJapanese && !waitForCompletion) {
          const knownSurfaces = new Set(allVocab.map((v) => v.word));
          const subtitleLines = cleaned.split("\n").filter((l) => l.trim().length > 0);
          const extraKanaVocab = await detectUnusualKanaSpellings(
            cleaned,
            subtitleLines,
            knownSurfaces,
            aiApiKey,
          );
          if (extraKanaVocab.length > 0) {
            console.log(`Episode ${episode_id}: +${extraKanaVocab.length} unusual-kana vocab merged`);
            allVocab.push(...extraKanaVocab);
          }
        }

        const tagged: TaggedVocab[] = rankVocabBySeasonAndUtility(
          allVocab,
          (v) => (isJapanese ? (getOfficialJlptLevel(v.word, v.reading) ?? "none") : "none"),
          siblingDocFreq,
          sampledSiblingCount,
        );

        if (tagged.length === 0) {
          throw new Error("No vocabulary extracted from subtitles");
        }

        const top = waitForCompletion ? tagged.slice(0, MOBILE_SYNC_WORD_CAP) : tagged;
        const remainingTagged = waitForCompletion ? tagged.slice(MOBILE_SYNC_WORD_CAP) : [];

        const { vocab: finalVocab, grammarMap, okBatches, totalBatches, firstError } = await translateSlice(
          top,
          true,
        );

        if (totalBatches === 0 || okBatches / totalBatches < 0.8) {
          const suffix = firstError ? `: ${firstError}` : "";
          throw new Error(`AI translation failed (${okBatches}/${totalBatches} batches succeeded)${suffix}`);
        }
        if (finalVocab.length === 0) {
          throw new Error("No translated vocabulary produced");
        }

        const sentences = buildTopSentences(finalVocab);

        const { error: cacheErr } = await supabase.from("episode_vocab_cache").upsert(
          {
            episode_id,
            language: learning.code,
            vocab: finalVocab,
            grammar: Array.from(grammarMap.values()),
            sentences,
          },
          { onConflict: "episode_id,language" },
        );
        if (cacheErr) {
          throw new Error(`Cache save failed: ${cacheErr.message}`);
        }

        await supabase.from("episodes").update({ processing_status: "ready" }).eq("id", episode_id);
        console.log(
          `Episode ${episode_id} [${learning.code}] done: ${finalVocab.length} vocab (${okBatches}/${totalBatches} batches ok), ${grammarMap.size} grammar, ${sentences.length} sentences`,
        );
        return {
          ok: true,
          count: finalVocab.length,
          remainingTagged,
          initialVocab: finalVocab,
          initialGrammar: grammarMap,
          siblingDocFreq,
          sampledSiblingCount,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`Episode ${episode_id} failed:`, msg);
        await supabase.from("episodes").update({ processing_status: "failed" }).eq("id", episode_id);
        return { ok: false, error: msg };
      }
    })();

    if (waitForCompletion) {
      const outcome = await work;
      if (!outcome.ok) {
        return jsonResponse({ error: outcome.error }, 500);
      }

      // Asynchronously enrich remaining words beyond the top 200 in the background without blocking mobile response.
      if (outcome.remainingTagged.length > 0 && edgeRuntime?.waitUntil) {
        const tailTask = (async () => {
          try {
            let tailSlice = [...outcome.remainingTagged];
            if (isJapanese) {
              const knownWords = new Set([
                ...outcome.initialVocab.map((v) => v.word),
                ...tailSlice.map((v) => v.word),
              ]);
              const subtitleLines = cleaned.split("\n").filter((l) => l.trim().length > 0);
              const extraKana = await detectUnusualKanaSpellings(
                cleaned,
                subtitleLines,
                knownWords,
                aiApiKey,
              );
              if (extraKana.length > 0) {
                const rankedExtra = rankVocabBySeasonAndUtility(
                  extraKana,
                  (v) => getOfficialJlptLevel(v.word, v.reading) ?? "none",
                  outcome.siblingDocFreq,
                  outcome.sampledSiblingCount,
                );
                tailSlice = [...tailSlice, ...rankedExtra].sort(
                  (a, b) => b.importanceScore - a.importanceScore,
                );
              }
            }

            const tailResult = await translateSlice(tailSlice, false);
            if (tailResult.totalBatches > 0 && tailResult.okBatches / tailResult.totalBatches >= 0.8) {
              const mergedByWord = new Map<string, CachedVocabItem>();
              for (const v of outcome.initialVocab) mergedByWord.set(v.word, v);
              for (const v of tailResult.vocab) {
                if (!mergedByWord.has(v.word)) mergedByWord.set(v.word, v);
              }
              const mergedVocab = Array.from(mergedByWord.values()).sort(
                (a, b) => b.frequency - a.frequency,
              );
              const mergedGrammar = new Map(outcome.initialGrammar);
              for (const [k, g] of tailResult.grammarMap) {
                if (!mergedGrammar.has(k)) mergedGrammar.set(k, g);
              }
              await supabase.from("episode_vocab_cache").upsert(
                {
                  episode_id,
                  language: learning.code,
                  vocab: mergedVocab,
                  grammar: Array.from(mergedGrammar.values()),
                  sentences: buildTopSentences(mergedVocab),
                },
                { onConflict: "episode_id,language" },
              );
              console.log(
                `Episode ${episode_id} [${learning.code}] background enrichment complete: ${mergedVocab.length} total vocab`,
              );
            }
          } catch (bgErr) {
            console.warn(
              `Episode ${episode_id} background tail enrichment failed:`,
              bgErr instanceof Error ? bgErr.message : String(bgErr),
            );
          }
        })();
        edgeRuntime.waitUntil(tailTask);
      }

      return jsonResponse({ status: "ready", count: outcome.count }, 200);
    }

    if (edgeRuntime?.waitUntil) {
      edgeRuntime.waitUntil(work);
    }

    return jsonResponse({ started: true, status: "processing" }, 202);
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});
