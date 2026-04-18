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

    await supabase.from("episodes").update({ processing_status: "processing" }).eq("id", episode_id);

    const cleaned = stripSubtitleFormatting(subtitle_text).slice(0, 40000);

    const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "You are a Japanese language teacher creating a comprehensive study database from anime subtitles. Extract EVERY meaningful vocabulary word that appears in the subtitles — do not filter by difficulty or learner level. Include common words (N5/N4) AND advanced words (N1/N2) AND proper nouns and slang. Aim for 150-250 vocabulary entries, 15-25 grammar points, and 25-40 example sentences. Tag each word with its accurate JLPT level so individual learners can filter client-side. You MUST call the extract_japanese_learning_data function." },
          { role: "user", content: `Extract ALL Japanese vocabulary from these subtitles. Be exhaustive — capture every meaningful word regardless of difficulty:\n\n${cleaned}` },
        ],
        tools: [EXTRACTION_TOOL],
        tool_choice: { type: "function", function: { name: "extract_japanese_learning_data" } },
      }),
    });
    if (!aiResp.ok) {
      const t = await aiResp.text();
      console.error("AI gateway error", aiResp.status, t);
      await supabase.from("episodes").update({ processing_status: "failed" }).eq("id", episode_id);
      if (aiResp.status === 429) return new Response(JSON.stringify({ error: "Rate limit exceeded. Try again later." }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      if (aiResp.status === 402) return new Response(JSON.stringify({ error: "AI credits exhausted. Please add credits to your workspace." }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ error: "AI extraction failed" }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const aiJson = await aiResp.json();
    const call = aiJson?.choices?.[0]?.message?.tool_calls?.[0];
    if (!call?.function?.arguments) {
      console.error("no tool_call in AI response:", JSON.stringify(aiJson).slice(0, 2000));
      await supabase.from("episodes").update({ processing_status: "failed" }).eq("id", episode_id);
      return new Response(JSON.stringify({ error: "AI returned no extraction" }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    let extracted: any;
    try { extracted = JSON.parse(call.function.arguments); }
    catch (e) {
      console.error("parse fail", e);
      await supabase.from("episodes").update({ processing_status: "failed" }).eq("id", episode_id);
      return new Response(JSON.stringify({ error: "invalid AI response" }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const payload = {
      episode_id,
      vocab: extracted.vocab ?? [],
      grammar: extracted.grammar ?? [],
      sentences: extracted.sentences ?? [],
    };
    await supabase.from("episode_vocab_cache").upsert(payload, { onConflict: "episode_id" });
    await supabase.from("episodes").update({ processing_status: "ready" }).eq("id", episode_id);

    return new Response(JSON.stringify({ cached: false, ...payload }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "unknown" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
