// Process an episode's subtitles via Lovable AI (Gemini), cache result.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EXTRACTION_TOOL = {
  type: "function",
  function: {
    name: "extract_japanese_learning_data",
    description: "Extract vocabulary, grammar points, and example sentences from Japanese anime subtitles for a learner.",
    parameters: {
      type: "object",
      properties: {
        vocab: {
          type: "array",
          items: {
            type: "object",
            properties: {
              word: { type: "string", description: "Dictionary form, in Japanese" },
              reading: { type: "string", description: "Hiragana reading" },
              meaning: { type: "string", description: "Concise English meaning" },
              part_of_speech: { type: "string" },
              jlpt_level: { type: "string", enum: ["N5","N4","N3","N2","N1","none"] },
              example_sentence_jp: { type: "string", description: "An example sentence pulled from the subtitles using this word" },
              example_sentence_en: { type: "string", description: "English translation of the example sentence" },
            },
            required: ["word","reading","meaning","part_of_speech","jlpt_level","example_sentence_jp","example_sentence_en"],
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
              example_jp: { type: "string" },
              example_en: { type: "string" },
              jlpt_level: { type: "string", enum: ["N5","N4","N3","N2","N1","none"] },
            },
            required: ["pattern","meaning","example_jp","example_en","jlpt_level"],
            additionalProperties: false,
          },
        },
        sentences: {
          type: "array",
          items: {
            type: "object",
            properties: {
              jp: { type: "string" },
              en: { type: "string" },
            },
            required: ["jp","en"],
            additionalProperties: false,
          },
        },
      },
      required: ["vocab","grammar","sentences"],
      additionalProperties: false,
    },
  },
};

function stripSubtitleFormatting(raw: string): string {
  // Strip SRT timestamps + numeric counters and ASS dialogue formatting.
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  for (let line of lines) {
    if (/^\d+$/.test(line.trim())) continue;
    if (/-->/i.test(line)) continue;
    if (/^\[.*\]$/.test(line.trim())) continue;
    if (line.startsWith("Dialogue:")) {
      const parts = line.split(",");
      if (parts.length > 9) line = parts.slice(9).join(",");
    }
    line = line.replace(/\{[^}]*\}/g, "").replace(/<[^>]+>/g, "").trim();
    if (line) out.push(line);
  }
  // De-dupe consecutive
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

    const cleaned = stripSubtitleFormatting(subtitle_text).slice(0, 60000);

    // Split cleaned subtitles into roughly equal chunks on line boundaries.
    // Each chunk is sent to the AI in parallel and the results are merged + deduped.
    const CHUNK_SIZE = 7000;       // chars per chunk — keeps each tool_call response well under output limits
    const MAX_CONCURRENCY = 4;     // parallel AI calls
    const chunkText = (text: string, size: number): string[] => {
      const lines = text.split("\n");
      const chunks: string[] = [];
      let buf = "";
      for (const line of lines) {
        if (buf.length + line.length + 1 > size && buf.length > 0) {
          chunks.push(buf);
          buf = "";
        }
        buf += (buf ? "\n" : "") + line;
      }
      if (buf) chunks.push(buf);
      return chunks;
    };

    // Run the heavy AI extraction in the background so the request returns immediately.
    // The client polls `episodes.processing_status` (and `episode_vocab_cache`) for progress.
    const work = (async () => {
      const callAi = async (text: string) => {
        const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            messages: [
              { role: "system", content: "You are a Japanese language teacher building a study database from anime subtitles. Extract EVERY meaningful vocabulary word that appears in the given subtitle excerpt regardless of difficulty (N5 through N1, plus proper nouns and slang). Aim for 30-60 vocabulary entries, 3-6 grammar points, and 6-10 example sentences from THIS excerpt. Tag each word with its accurate JLPT level. You MUST call the extract_japanese_learning_data function and return valid JSON." },
              { role: "user", content: `Extract Japanese vocabulary from this subtitle excerpt:\n\n${text}` },
            ],
            tools: [EXTRACTION_TOOL],
            tool_choice: { type: "function", function: { name: "extract_japanese_learning_data" } },
          }),
        });
        if (!aiResp.ok) {
          const t = await aiResp.text();
          throw new Error(`ai_gateway_${aiResp.status}: ${t.slice(0, 500)}`);
        }
        return await aiResp.json();
      };

      const tryParse = (aiJson: any) => {
        const choice = aiJson?.choices?.[0];
        const call = choice?.message?.tool_calls?.[0];
        const finish = choice?.finish_reason;
        if (!call?.function?.arguments) {
          throw new Error(`no_tool_call (finish_reason=${finish}): ${JSON.stringify(aiJson).slice(0, 1000)}`);
        }
        try {
          return { parsed: JSON.parse(call.function.arguments), finish };
        } catch (e) {
          throw new Error(`parse_fail (finish_reason=${finish}, args_len=${call.function.arguments.length}): ${(e as Error).message}`);
        }
      };

      let chunksDone = 0;
      const bumpProgress = async () => {
        chunksDone++;
        // Fire and forget — the row update doesn't need to block the next chunk.
        supabase
          .from("episodes")
          .update({ processing_chunks_done: chunksDone })
          .eq("id", episode_id)
          .then(({ error }) => { if (error) console.warn("progress update failed:", error.message); });
      };

      const processChunk = async (text: string, idx: number) => {
        try {
          const aiJson = await callAi(text);
          const { parsed } = tryParse(aiJson);
          return parsed;
        } catch (e) {
          console.warn(`Episode ${episode_id} chunk ${idx} failed:`, (e as Error).message);
          return null;
        } finally {
          await bumpProgress();
        }
      };

      // Simple concurrency-limited runner.
      const runWithConcurrency = async <T,>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<any>) => {
        const results: any[] = new Array(items.length);
        let cursor = 0;
        const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
          while (true) {
            const i = cursor++;
            if (i >= items.length) return;
            results[i] = await fn(items[i], i);
          }
        });
        await Promise.all(workers);
        return results;
      };

      try {
        const chunks = chunkText(cleaned, CHUNK_SIZE);
        console.log(`Episode ${episode_id}: split into ${chunks.length} chunk(s), running with concurrency ${MAX_CONCURRENCY}`);
        await supabase.from("episodes").update({ processing_chunks_total: chunks.length, processing_chunks_done: 0 }).eq("id", episode_id);
        const partials = await runWithConcurrency(chunks, MAX_CONCURRENCY, processChunk);

        const vocabMap = new Map<string, any>();
        const grammarMap = new Map<string, any>();
        const sentenceSet = new Set<string>();
        const sentences: any[] = [];
        let successCount = 0;
        for (const p of partials) {
          if (!p) continue;
          successCount++;
          for (const v of (p.vocab ?? [])) {
            if (v?.word && !vocabMap.has(v.word)) vocabMap.set(v.word, v);
          }
          for (const g of (p.grammar ?? [])) {
            if (g?.pattern && !grammarMap.has(g.pattern)) grammarMap.set(g.pattern, g);
          }
          for (const s of (p.sentences ?? [])) {
            if (s?.jp && !sentenceSet.has(s.jp)) {
              sentenceSet.add(s.jp);
              sentences.push(s);
            }
          }
        }

        if (successCount === 0) {
          throw new Error("all chunks failed");
        }

        const payload = {
          episode_id,
          vocab: Array.from(vocabMap.values()),
          grammar: Array.from(grammarMap.values()),
          sentences: sentences.slice(0, 60),
        };
        await supabase.from("episode_vocab_cache").upsert(payload, { onConflict: "episode_id" });
        await supabase.from("episodes").update({ processing_status: "ready" }).eq("id", episode_id);
        console.log(`Episode ${episode_id} processed: ${successCount}/${chunks.length} chunks ok, ${payload.vocab.length} vocab, ${payload.grammar.length} grammar, ${payload.sentences.length} sentences`);
      } catch (e) {
        console.error(`Episode ${episode_id} background processing failed:`, e instanceof Error ? e.message : e);
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
