// Streaming AI tutor for vocabulary learning in the learner's target language.
// Uses Google Gemini API (OpenAI-compatible) and supports tool calls for marking words known
// and starting a mini-quiz from the episode's vocab.
import {
  corsHeaders,
  jsonResponse,
  requireAuthUser,
} from "../_shared/auth.ts";
import { callAiChatCompletions, getAiApiKey, validateClientMessages } from "../_shared/ai.ts";
import { langInfo, uiLanguageName } from "../_shared/languages.ts";

type VocabItem = {
  word: string;
  reading: string;
  meaning: string;
  part_of_speech?: string;
  jlpt_level?: string;
  example_sentence_jp?: string;
  example_sentence_en?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const auth = await requireAuthUser(req);
    if (auth instanceof Response) return auth;

    const aiApiKey = getAiApiKey();

    const body = (await req.json()) as {
      messages?: unknown;
      vocab?: unknown;
      jlpt_level?: unknown;
      focus_word?: unknown;
      ui_language?: unknown;
      learning_language?: unknown;
    };

    const validated = validateClientMessages(body?.messages, {
      allowEmpty: false,
      maxMessages: 40,
      maxCharsPerMessage: 4_000,
    });
    if (!validated.ok) {
      return jsonResponse({ error: validated.error }, 400);
    }
    const messages = validated.messages;

    const vocab: VocabItem[] = Array.isArray(body?.vocab)
      ? (body.vocab as VocabItem[]).slice(0, 80)
      : [];
    const jlptLevel: string = typeof body?.jlpt_level === "string" ? body.jlpt_level.slice(0, 20) : "none";
    const focusWord: string | null =
      typeof body?.focus_word === "string" && body.focus_word.trim()
        ? body.focus_word.trim().slice(0, 100)
        : null;
    const nativeLang = uiLanguageName(typeof body?.ui_language === "string" ? body.ui_language : "en");
    const learning = langInfo(typeof body?.learning_language === "string" ? body.learning_language : null);
    const learningLangName = learning.name;
    const levelScale = learning.scale.toUpperCase();

    const vocabContext = vocab.length
      ? vocab
          .map(
            (v) =>
              `- ${String(v.word ?? "")} (${String(v.reading ?? "")}) — ${String(v.meaning ?? "")}${
                v.jlpt_level ? ` [${String(v.jlpt_level)}]` : ""
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
          description:
            "Mark a vocabulary word as 'known' in the learner's word state. Use when they clearly indicate they know it.",
          parameters: {
            type: "object",
            properties: {
              word: {
                type: "string",
                description: "The target-language word (dictionary/kanji form if available)",
              },
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
          description:
            "Start a short interactive quiz on episode vocabulary. Use when the learner asks to be quizzed or wants practice.",
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

    const upstream = await callAiChatCompletions(
      {
        model: "gemini-2.5-flash",
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        tools,
        stream: true,
      },
      aiApiKey,
    );

    if (!upstream.ok) {
      if (upstream.status === 429) {
        return jsonResponse({ error: "Rate limit reached. Please wait a moment and try again." }, 429);
      }
      if (upstream.status === 402) {
        return jsonResponse({ error: "AI quota exhausted." }, 402);
      }
      const t = await upstream.text();
      console.error("AI API error", upstream.status, t);
      return jsonResponse({ error: "AI API error" }, 500);
    }

    return new Response(upstream.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("tutor-chat error:", e);
    return jsonResponse({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
