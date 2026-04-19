import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { episode_id, force } = await req.json();
    if (!episode_id) {
      return new Response(JSON.stringify({ error: "episode_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Return cached summary if exists and not forced
    if (!force) {
      const { data: existing } = await supabase
        .from("episode_summaries")
        .select("summary_jp,summary_en,used_words,updated_at")
        .eq("user_id", user.id).eq("episode_id", episode_id).maybeSingle();
      if (existing) {
        return new Response(JSON.stringify({ ...existing, cached: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Gather context: episode info, sentences, studied words for this episode
    const [{ data: ep }, { data: cache }, { data: chunks }] = await Promise.all([
      supabase.from("episodes").select("episode_number,title_jp,title_en").eq("id", episode_id).maybeSingle(),
      supabase.from("episode_vocab_cache").select("vocab,sentences").eq("episode_id", episode_id).maybeSingle(),
      supabase.from("study_chunks").select("id").eq("user_id", user.id).eq("episode_id", episode_id).not("studied_at", "is", null),
    ]);

    const chunkIds = (chunks ?? []).map((c: any) => c.id);
    let studiedWords: { word: string; reading: string; meaning: string }[] = [];
    if (chunkIds.length > 0) {
      const { data: cw } = await supabase
        .from("study_chunk_words")
        .select("word,reading,meaning")
        .in("chunk_id", chunkIds);
      studiedWords = (cw ?? []) as any;
    }

    if (studiedWords.length === 0) {
      return new Response(JSON.stringify({ error: "No studied words yet. Study at least one chunk first." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sentences = ((cache?.sentences ?? []) as any[]).slice(0, 30);
    const wordList = studiedWords.map(w => `${w.word}（${w.reading}）= ${w.meaning}`).join("\n");
    const sentenceContext = sentences.map((s: any) => `JP: ${s.jp}\nEN: ${s.en}`).join("\n\n");

    const systemPrompt = `You are a Japanese language tutor writing a recap summary of an anime episode the learner just watched.

GOAL: Write a short natural Japanese summary of the episode (4-7 sentences) that uses AS MANY of the learner's recently studied words as possible. The summary should feel like a natural recap, not a forced word-list.

RULES:
- Use the studied words list below — incorporate as many as you naturally can.
- Wrap each used vocabulary word in **double asterisks** like **食べる** so the UI can highlight them.
- Keep the Japanese natural and at a level appropriate to the words given.
- Then provide an English translation that mirrors the Japanese (also wrap the corresponding English meaning of each highlighted word in **double asterisks**).
- Return ONLY a JSON object, no extra text.`;

    const userPrompt = `Episode: ${ep?.episode_number ?? "?"}${ep?.title_en ? ` — ${ep.title_en}` : ""}

STUDIED WORDS (use as many as possible):
${wordList}

EPISODE SENTENCE CONTEXT (for plot reference):
${sentenceContext}`;

    const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("LOVABLE_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        tools: [{
          type: "function",
          function: {
            name: "write_summary",
            description: "Write the recap summary",
            parameters: {
              type: "object",
              properties: {
                summary_jp: { type: "string", description: "Japanese recap, 4-7 sentences, with **word** highlights." },
                summary_en: { type: "string", description: "English translation with **word** highlights matching the JP version." },
                used_words: {
                  type: "array",
                  description: "List of vocabulary words from the studied list that were actually used in the summary.",
                  items: { type: "string" },
                },
              },
              required: ["summary_jp", "summary_en", "used_words"],
              additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "write_summary" } },
      }),
    });

    if (!aiResp.ok) {
      if (aiResp.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded, please try again in a moment." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResp.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted. Please add funds in Settings." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const t = await aiResp.text();
      console.error("AI error:", aiResp.status, t);
      return new Response(JSON.stringify({ error: "AI gateway error" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiData = await aiResp.json();
    const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) {
      console.error("No tool call in response:", JSON.stringify(aiData));
      return new Response(JSON.stringify({ error: "AI did not return structured output" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const args = JSON.parse(toolCall.function.arguments);
    const summary_jp = String(args.summary_jp ?? "");
    const summary_en = String(args.summary_en ?? "");
    const used_words = Array.isArray(args.used_words) ? args.used_words : [];

    // Cache it
    await supabase.from("episode_summaries").upsert({
      user_id: user.id,
      episode_id,
      summary_jp,
      summary_en,
      used_words,
    }, { onConflict: "user_id,episode_id" });

    return new Response(JSON.stringify({ summary_jp, summary_en, used_words, cached: false }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("episode-summary error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
