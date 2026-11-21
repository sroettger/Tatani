// Streaming AI tutor for vocabulary learning in the learner's target language.
// Uses Google Gemini API (OpenAI-compatible) and supports tool calls for marking words known
// and starting a mini-quiz from the episode's vocab.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callAiChatCompletions, getAiApiKey } from "../_shared/ai.ts";
import { langInfo, uiLanguageName } from "../_shared/languages.ts";

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
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await supa.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiApiKey = getAiApiKey();

    const body = await req.json();
    const messages: ChatMsg[] = Array.isArray(body?.messages) ? body.messages : [];
    const vocab: VocabItem[] = Array.isArray(body?.vocab) ? body.vocab.slice(0, 80) : [];
    const jlptLevel: string = typeof body?.jlpt_level === "string" ? body.jlpt_level : "none";
    const focusWord: string | null = typeof body?.focus_word === "string" ? body.focus_word : null;
    const nativeLang = uiLanguageName(typeof body?.ui_language === "string" ? body.ui_language : "en");
    // Learning language resolved from the shared config (falls back to the default).
    const learning = langInfo(typeof body?.learning_language === "string" ? body.learning_language : null);
    const learningLangName = learning.name;
    const levelScale = learning.scale.toUpperCase();

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

    const systemPrompt = `You are a friendly ${learningLangName} tutor helping someone learn vocabulary from anime episodes.

Learner's ${levelScale} level: ${jlptLevel}
${focusWord ? `They're focused on this word right now: ${focusWord}\n` : ""}
Vocabulary from the current episode:
${vocabContext}

Guidelines:
- The learner's own language is ${nativeLang}. Write ALL of your explanations, instructions and translations in ${nativeLang}.
- Keep answers concise and conversational. Use markdown.
- Match the learner's ${levelScale} level — simpler grammar/vocab in your ${learningLangName} examples for lower levels.
- For example sentences, ALWAYS include both the ${learningLangName} and a ${nativeLang} translation.
${learning.morphological ? `- When showing ${learningLangName} text, include readings (furigana style: 漢字(かんじ)) for words above the learner's level.` : ""}
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
              word: { type: "string", description: "The target-language word (dictionary/kanji form if available)" },
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

    const upstream = await callAiChatCompletions({
      model: "gemini-2.5-flash",
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      tools,
      stream: true,
    }, aiApiKey);

    if (!upstream.ok) {
      if (upstream.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limit reached. Please wait a moment and try again." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (upstream.status === 402) {
        return new Response(
          JSON.stringify({ error: "AI quota exhausted." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const t = await upstream.text();
      console.error("AI API error", upstream.status, t);
      return new Response(JSON.stringify({ error: "AI API error" }), {
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
