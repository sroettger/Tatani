// Process an episode's subtitles: tokenize with kuromoji, frequency-rank,
// then ask the AI for English meanings + grammar based on real example sentences.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getOfficialJlptLevel } from "../_shared/jlpt-lookup.ts";
import { extractVocabFromSubtitles, type VocabEntry } from "../_shared/tokenize-jp.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// AI tool: find common Japanese words written in unusual kana-only form (childish speech, stylization)
// that morphological tokenizers like kuromoji split into meaningless fragments.
const UNUSUAL_KANA_TOOL = {
  type: "function",
  function: {
    name: "report_unusual_kana_spellings",
    description: "Report common Japanese vocabulary words that appear in the subtitle text written in unusual kana-only form (e.g. じなん for 次男, ぱぱ for パパ) which morphological tokenizers typically fail to recognize as a single word.",
    parameters: {
      type: "object",
      properties: {
        words: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kana_surface: { type: "string", description: "EXACT kana substring as it appears in the subtitle text (e.g. じなん)" },
              canonical_word: { type: "string", description: "Standard dictionary form, usually with kanji (e.g. 次男)" },
              reading: { type: "string", description: "Hiragana reading of the canonical word" },
              meaning: { type: "string", description: "Concise English meaning" },
              part_of_speech: { type: "string", description: "Japanese POS tag like 名詞, 動詞, 形容詞" },
              example_sentence_jp: { type: "string", description: "MUST be an actual line from the supplied subtitle text containing kana_surface" },
              example_sentence_en: { type: "string", description: "Natural English translation of that sentence" },
            },
            required: ["kana_surface", "canonical_word", "reading", "meaning", "part_of_speech", "example_sentence_jp", "example_sentence_en"],
            additionalProperties: false,
          },
        },
      },
      required: ["words"],
      additionalProperties: false,
    },
  },
};

// AI tool: translate a batch of vocab + extract grammar from the supplied example sentences.
const TRANSLATE_TOOL = {
  type: "function",
  function: {
    name: "translate_vocab_and_extract_grammar",
    description: "For each given Japanese vocabulary item, return an English meaning that fits the example sentence. Also extract grammar points used across these sentences.",
    parameters: {
      type: "object",
      properties: {
        vocab: {
          type: "array",
          items: {
            type: "object",
            properties: {
              word: { type: "string", description: "MUST exactly match one of the input words" },
              meaning: { type: "string", description: "Concise English meaning that fits the example sentence context" },
              example_sentence_en: { type: "string", description: "Natural English translation of THIS word's example sentence" },
            },
            required: ["word", "meaning", "example_sentence_en"],
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
              jlpt_level: { type: "string", enum: ["N5", "N4", "N3", "N2", "N1", "none"] },
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

function stripSubtitleFormatting(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  // Skip ASS/SSA metadata lines that aren't actual dialogue.
  const ASS_META = /^(Format|Style|Title|ScriptType|Collisions|PlayRes[XY]|Timer|WrapStyle|ScaledBorderAndShadow|YCbCr Matrix|Audio URI|Video URI|Original\s|Update\s|Synch Point|Script Updated By|Comment|PlayDepth):/i;
  for (let line of lines) {
    if (/^\d+$/.test(line.trim())) continue;
    if (/-->/i.test(line)) continue;
    if (/^\[.*\]$/.test(line.trim())) continue;
    if (ASS_META.test(line.trim())) continue;
    if (line.startsWith("Dialogue:")) {
      const parts = line.split(",");
      if (parts.length > 9) line = parts.slice(9).join(",");
    }
    line = line.replace(/\{[^}]*\}/g, "").replace(/<[^>]+>/g, "").trim();
    if (line) out.push(line);
  }
  return out.filter((l, i) => l !== out[i - 1]).join("\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "", { global: { headers: { Authorization: authHeader } } });
    const { data: claims, error: claimsErr } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
    if (claimsErr || !claims?.claims) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY missing");

    const { episode_id, subtitle_text } = await req.json();
    if (!episode_id || !subtitle_text) {
      return new Response(JSON.stringify({ error: "episode_id and subtitle_text required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    // Cache hit?
    const { data: existing } = await supabase
      .from("episode_vocab_cache")
      .select("vocab,grammar,sentences")
      .eq("episode_id", episode_id)
      .maybeSingle();
    if (existing && Array.isArray(existing.vocab) && existing.vocab.length > 0) {
      await supabase.from("episodes").update({ processing_status: "ready" }).eq("id", episode_id);
      return new Response(JSON.stringify({ cached: true, ...existing }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await supabase.from("episodes").update({ processing_status: "processing", processing_chunks_done: 0, processing_chunks_total: 0 }).eq("id", episode_id);

    const cleaned = stripSubtitleFormatting(subtitle_text);

    // Tunables.
    const BATCH_SIZE = 40;       // words per AI call (keeps response well under output limits)
    const MAX_CONCURRENCY = 4;

    // Run extraction in the background; client polls episodes.processing_status.
    const work = (async () => {
      try {
        // 1. Tokenize + frequency rank (deterministic, no AI).
        const allVocab = await extractVocabFromSubtitles(cleaned);
        console.log(`Episode ${episode_id}: tokenized → ${allVocab.length} unique words`);

        // 1b. AI pass: detect common words written in unusual kana-only form
        // (childish speech, stylization) that kuromoji splits into fragments.
        const knownSurfaces = new Set(allVocab.map((v) => v.word));
        const subtitleLines = cleaned.split("\n").filter((l) => l.trim().length > 0);
        const extraKanaVocab = await detectUnusualKanaSpellings(cleaned, subtitleLines, knownSurfaces, LOVABLE_API_KEY);
        if (extraKanaVocab.length > 0) {
          console.log(`Episode ${episode_id}: +${extraKanaVocab.length} unusual-kana vocab merged`);
          allVocab.push(...extraKanaVocab);
        }

        // 2. Tag JLPT levels from official list (covers ~8000 most common words).
        const tagged = allVocab.map((v) => ({
          ...v,
          jlpt_level: getOfficialJlptLevel(v.word, v.reading) ?? "none",
        }));

        // 3. Translate everything (no cap).
        const top = tagged;

        // 4. Batch words to AI for English meanings + grammar extraction.
        const batches: Array<typeof top> = [];
        for (let i = 0; i < top.length; i += BATCH_SIZE) {
          batches.push(top.slice(i, i + BATCH_SIZE));
        }
        await supabase
          .from("episodes")
          .update({ processing_chunks_total: batches.length, processing_chunks_done: 0 })
          .eq("id", episode_id);

        let chunksDone = 0;
        const bumpProgress = () => {
          chunksDone++;
          supabase
            .from("episodes")
            .update({ processing_chunks_done: chunksDone })
            .eq("id", episode_id)
            .then(({ error }) => { if (error) console.warn("progress update failed:", error.message); });
        };

        const callBatch = async (batch: typeof top, idx: number): Promise<{ meanings: Map<string, { meaning: string; example_en: string }>; grammar: any[] } | null> => {
          const wordsPayload = batch.map((v) => ({
            word: v.word,
            reading: v.reading,
            part_of_speech: v.part_of_speech,
            example_sentence_jp: v.example_sentence_jp,
          }));
          const userMessage = `Translate each Japanese word below to English using its example sentence as context. Also extract any meaningful grammar points used in these sentences (particles, verb forms, common patterns).\n\nWORDS:\n${JSON.stringify(wordsPayload, null, 2)}`;

          try {
            const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
              method: "POST",
              headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                model: "google/gemini-2.5-flash",
                messages: [
                  { role: "system", content: "You are a Japanese-to-English translator helping language learners. For each word given, provide a concise English meaning that fits its example sentence context, plus a natural English translation of that example sentence. Then extract grammar points (particles, verb conjugations, common patterns) actually used in the supplied sentences. You MUST call the translate_vocab_and_extract_grammar function." },
                  { role: "user", content: userMessage },
                ],
                tools: [TRANSLATE_TOOL],
                tool_choice: { type: "function", function: { name: "translate_vocab_and_extract_grammar" } },
              }),
            });
            if (!aiResp.ok) {
              const t = await aiResp.text();
              throw new Error(`ai_${aiResp.status}: ${t.slice(0, 300)}`);
            }
            const aiJson = await aiResp.json();
            const call = aiJson?.choices?.[0]?.message?.tool_calls?.[0];
            if (!call?.function?.arguments) throw new Error("no_tool_call");
            const parsed = JSON.parse(call.function.arguments);
            const meanings = new Map<string, { meaning: string; example_en: string }>();
            for (const v of (parsed.vocab ?? [])) {
              if (v?.word) meanings.set(v.word, { meaning: v.meaning ?? "", example_en: v.example_sentence_en ?? "" });
            }
            return { meanings, grammar: parsed.grammar ?? [] };
          } catch (e) {
            console.warn(`Batch ${idx} failed:`, (e as Error).message);
            return null;
          } finally {
            bumpProgress();
          }
        };

        // Concurrency-limited runner.
        const results: Array<{ meanings: Map<string, { meaning: string; example_en: string }>; grammar: any[] } | null> = new Array(batches.length);
        let cursor = 0;
        const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, batches.length) }, async () => {
          while (true) {
            const i = cursor++;
            if (i >= batches.length) return;
            results[i] = await callBatch(batches[i], i);
          }
        });
        await Promise.all(workers);

        // 5. Merge translations + dedupe grammar.
        const allMeanings = new Map<string, { meaning: string; example_en: string }>();
        const grammarMap = new Map<string, any>();
        let okBatches = 0;
        for (const r of results) {
          if (!r) continue;
          okBatches++;
          for (const [w, m] of r.meanings) allMeanings.set(w, m);
          for (const g of r.grammar) {
            if (g?.pattern && !grammarMap.has(g.pattern)) grammarMap.set(g.pattern, g);
          }
        }
        if (okBatches === 0) throw new Error("all batches failed");

        const finalVocab = top.map((v) => {
          const m = allMeanings.get(v.word);
          return {
            word: v.word,
            reading: v.reading,
            part_of_speech: v.part_of_speech,
            jlpt_level: v.jlpt_level,
            meaning: m?.meaning ?? "",
            example_sentence_jp: v.example_sentence_jp,
            example_sentence_en: m?.example_en ?? "",
            frequency: v.frequency,
          };
        });

        // Sentences = top example sentences (deduped).
        const sentenceSet = new Set<string>();
        const sentences: { jp: string; en: string }[] = [];
        for (const v of finalVocab) {
          if (v.example_sentence_jp && !sentenceSet.has(v.example_sentence_jp)) {
            sentenceSet.add(v.example_sentence_jp);
            sentences.push({ jp: v.example_sentence_jp, en: v.example_sentence_en });
            if (sentences.length >= 60) break;
          }
        }

        await supabase.from("episode_vocab_cache").upsert({
          episode_id,
          vocab: finalVocab,
          grammar: Array.from(grammarMap.values()),
          sentences,
        }, { onConflict: "episode_id" });
        await supabase.from("episodes").update({ processing_status: "ready" }).eq("id", episode_id);
        console.log(`Episode ${episode_id} done: ${finalVocab.length} vocab (${okBatches}/${batches.length} batches ok), ${grammarMap.size} grammar, ${sentences.length} sentences`);
      } catch (e) {
        console.error(`Episode ${episode_id} failed:`, e instanceof Error ? e.message : e);
        await supabase.from("episodes").update({ processing_status: "failed" }).eq("id", episode_id);
      }
    })();

    // @ts-ignore - EdgeRuntime is available in Supabase edge functions
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(work);
    }

    return new Response(JSON.stringify({ started: true, status: "processing" }), {
      status: 202,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "unknown" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
