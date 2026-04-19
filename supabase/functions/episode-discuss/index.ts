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

    const { episode_id, messages, auto_start } = await req.json();
    if (!episode_id || !Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: "episode_id and messages required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Gather context: episode info, user JLPT, sentences, studied vocab for this episode
    const [{ data: ep }, { data: cache }, { data: profile }, { data: chunks }] = await Promise.all([
      supabase.from("episodes").select("episode_number,title_jp,title_en").eq("id", episode_id).maybeSingle(),
      supabase.from("episode_vocab_cache").select("vocab,sentences").eq("episode_id", episode_id).maybeSingle(),
      supabase.from("profiles").select("jlpt_level,display_name").eq("user_id", user.id).maybeSingle(),
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

    const jlpt = profile?.jlpt_level && profile.jlpt_level !== "none" ? profile.jlpt_level : "N5";
    // Use as many cached sentences as we can — these ARE the episode's plot for the AI.
    const allSentences = ((cache?.sentences ?? []) as any[]);
    const sentenceContext = allSentences.map((s: any, i: number) => `[${i + 1}] JP: ${s.jp}\n    EN: ${s.en}`).join("\n");
    const wordList = studiedWords.length
      ? studiedWords.map(w => `- ${w.word}（${w.reading}）= ${w.meaning}`).join("\n")
      : "(none yet)";

    const systemPrompt = `あなたはユーザーが今見たアニメのエピソードについて、日本語で楽しく話し合う会話パートナーです。

LEARNER LEVEL: JLPT ${jlpt}
EPISODE: ${ep?.episode_number ?? "?"}${ep?.title_en ? ` — ${ep.title_en}` : ""}

YOUR ROLE:
- Always reply in Japanese (日本語のみ).
- Match the learner's level (${jlpt}). Use simple grammar and vocabulary they can understand.
- You HAVE WATCHED THIS EPISODE — the numbered subtitle lines below ARE the actual dialogue. Refer to specific moments, characters' lines, and events from those subtitles. Do NOT make up plot points that aren't supported by the subtitles.
- Ask SPECIFIC, CONCRETE questions about things that actually happened in this episode (a particular line a character said, a specific event, an emotional moment), not generic questions like "did you like it?".
- Prefer using the learner's RECENTLY STUDIED WORDS below when they fit naturally — this reinforces their learning.
- ACTIVELY weave in 1-3 of the learner's recently studied words in EVERY reply (including the opening question). Pick words that fit the topic naturally — don't force awkward usage. Bold each studied word you use with **word** so the UI highlights it.
- Try to rotate through different studied words across the conversation rather than reusing the same ones.
- Keep responses SHORT (2-4 sentences max) so it feels like a real conversation.
- If the learner writes in English, gently encourage Japanese: respond mostly in Japanese.
- After your Japanese reply, on a NEW LINE, add an English translation in italics like: *(English: ...)* — this helps the learner check understanding without breaking the Japanese flow.
- If you use a vocabulary word from their studied list, you may bold it with **word** so the UI can highlight it.
- Be warm, curious, and fun — like a friend who just watched the episode with them.

GENTLE CORRECTIONS (only when the learner writes Japanese):
- If their last message contains unnatural grammar, wrong particles, awkward word choice, or a clear mistake, gently correct it BEFORE your normal reply.
- Format the correction block on its own lines at the very TOP of your response, like this exactly:
  > 💡 もっと自然に: 「<corrected Japanese>」
  > *(You wrote "<their original phrase>" — <very brief reason in English, max 1 short sentence>)*
- Then leave a blank line and continue with your normal Japanese reply + English translation.
- Only correct ACTUAL mistakes — never nitpick, never correct stylistic choices, never correct beginners for not using advanced grammar. If their Japanese is fine (even if simple), skip the correction entirely.
- Never correct English messages — just reply normally and encourage Japanese.
- At most ONE correction per reply, focused on the single most important issue.

LEARNER'S RECENTLY STUDIED WORDS (use these when natural):
${wordList}

ACTUAL EPISODE DIALOGUE (numbered subtitle lines from this episode — your source of truth):
${sentenceContext || "(no subtitles available — ask general questions instead)"}`;

    // Auto-start: model has no user input yet — instruct it to open the conversation
    // with a specific plot question grounded in the subtitles above.
    const finalMessages = auto_start && messages.length === 0
      ? [{
          role: "user",
          content: "Start our conversation. Greet me briefly, then ask ONE specific, concrete question in Japanese about something that actually happened in this episode (reference a specific moment, line, or event from the subtitles). IMPORTANT: weave 1-2 of my recently studied words into your greeting/question naturally and bold them with **word**. Keep it short and inviting.",
        }]
      : messages;

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
          ...finalMessages,
        ],
        stream: true,
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

    return new Response(aiResp.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("episode-discuss error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
