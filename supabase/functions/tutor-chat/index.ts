// Streaming AI tutor for Japanese vocabulary learning.
// Uses Lovable AI Gateway. Supports tool calls for marking words known and
// starting a mini-quiz from the episode's vocab.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type VocabItem = {
  word: string;
  reading: string;
  meaning: string;
  part_of_speech?: string;
  jlpt_level?: string;
  example_sentence_jp?: string;
  example_sentence_en?: string;
};

type ChatMsg = { role: "user" | "assistant" | "system" | "tool"; content: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const body = await req.json();
    const messages: ChatMsg[] = Array.isArray(body?.messages) ? body.messages : [];
    const vocab: VocabItem[] = Array.isArray(body?.vocab) ? body.vocab.slice(0, 80) : [];
    const jlptLevel: string = typeof body?.jlpt_level === "string" ? body.jlpt_level : "none";
    const focusWord: string | null = typeof body?.focus_word === "string" ? body.focus_word : null;

    if (messages.length === 0) {
      return new Response(JSON.stringify({ error: "messages required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const vocabContext = vocab.length
      ? vocab
          .map(
            (v) =>
              `- ${v.word} (${v.reading}) — ${v.meaning}${
                v.jlpt_level ? ` [${v.jlpt_level}]` : ""
              }`,
          )
          .join("\n")
      : "(no vocab loaded)";

    const systemPrompt = `You are a friendly Japanese tutor helping someone learn vocabulary from anime episodes.

Learner's JLPT level: ${jlptLevel}
${focusWord ? `They're focused on this word right now: ${focusWord}\n` : ""}
Vocabulary from the current episode:
${vocabContext}

Guidelines:
- Keep answers concise and conversational. Use markdown.
- Match the learner's JLPT level — simpler grammar/vocab in your Japanese examples for lower levels.
- For example sentences, ALWAYS include both Japanese and English translation.
- When showing Japanese, include readings (furigana style: 漢字(かんじ)) for words above the learner's level.
- If asked about a word not in the episode list, you can still help — just answer naturally.
- Use the mark_word_known tool when the learner clearly says they know a word (e.g. "I know this", "got it", "mark as known"). Confirm afterwards.
- Use the start_mini_quiz tool when the learner asks to be quizzed or wants practice. After calling it, briefly tell them the quiz has started.`;

    const tools = [
      {
        type: "function",
        function: {
          name: "mark_word_known",
          description: "Mark a vocabulary word as 'known' in the learner's word state. Use when they clearly indicate they know it.",
          parameters: {
            type: "object",
            properties: {
              word: { type: "string", description: "The Japanese word (kanji form if available)" },
            },
            required: ["word"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "start_mini_quiz",
          description: "Start a short interactive quiz on episode vocabulary. Use when the learner asks to be quizzed or wants practice.",
          parameters: {
            type: "object",
            properties: {
              count: { type: "number", description: "Number of questions, 3-8" },
            },
            required: ["count"],
            additionalProperties: false,
          },
        },
      },
    ];

    const upstream = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        tools,
        stream: true,
      }),
    });

    if (!upstream.ok) {
      if (upstream.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limit reached. Please wait a moment and try again." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (upstream.status === 402) {
        return new Response(
          JSON.stringify({ error: "AI credits exhausted. Add funds in Settings → Workspace → Usage." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const t = await upstream.text();
      console.error("AI gateway error", upstream.status, t);
      return new Response(JSON.stringify({ error: "AI gateway error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(upstream.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("tutor-chat error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
