import {
  corsHeaders,
  createAdminClient,
  jsonResponse,
  requireAuthUser,
} from "../_shared/auth.ts";
import { callAiChatCompletions } from "../_shared/ai.ts";
import { getUserLanguages, uiLanguageName } from "../_shared/languages.ts";

type StudiedWordRow = {
  word: string;
  reading: string | null;
  meaning: string | null;
};

type CachedSentence = {
  jp?: string;
  en?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const auth = await requireAuthUser(req);
    if (auth instanceof Response) return auth;
    const { userId } = auth;

    const body = (await req.json()) as {
      episode_id?: unknown;
      force?: unknown;
      learning_language?: unknown;
    };
    const episode_id = typeof body.episode_id === "string" ? body.episode_id.trim() : "";
    const force = Boolean(body.force);
    const requestedLang = typeof body.learning_language === "string" ? body.learning_language : undefined;

    if (!episode_id) {
      return jsonResponse({ error: "episode_id required" }, 400);
    }

    const supabase = createAdminClient();
    const { learning, uiLanguage } = await getUserLanguages(supabase, userId, requestedLang);
    const nativeLang = uiLanguageName(uiLanguage);

    // Return cached summary if exists and not forced
    if (!force) {
      const { data: existing } = await supabase
        .from("episode_summaries")
        .select("summary_jp,summary_en,used_words,updated_at")
        .eq("user_id", userId)
        .eq("episode_id", episode_id)
        .eq("learning_language", learning.code)
        .maybeSingle();
      if (existing) {
        return jsonResponse({ ...existing, cached: true });
      }
    }

    // Gather context: episode info, sentences, studied words for this episode
    const [{ data: ep }, { data: cache }, { data: chunks }] = await Promise.all([
      supabase.from("episodes").select("episode_number,title_jp,title_en").eq("id", episode_id).maybeSingle(),
      supabase
        .from("episode_vocab_cache")
        .select("vocab,sentences")
        .eq("episode_id", episode_id)
        .eq("language", learning.code)
        .maybeSingle(),
      supabase
        .from("study_chunks")
        .select("id")
        .eq("user_id", userId)
        .eq("episode_id", episode_id)
        .eq("learning_language", learning.code)
        .not("studied_at", "is", null),
    ]);

    const chunkIds = (chunks ?? []).map((c: { id: string }) => c.id);
    let studiedWords: StudiedWordRow[] = [];
    if (chunkIds.length > 0) {
      const { data: cw } = await supabase
        .from("study_chunk_words")
        .select("word,reading,meaning")
        .in("chunk_id", chunkIds);
      studiedWords = (cw ?? []) as StudiedWordRow[];
    }

    if (studiedWords.length === 0) {
      return jsonResponse({ error: "No studied words yet. Study at least one chunk first." }, 400);
    }

    const rawSentences = Array.isArray(cache?.sentences) ? (cache.sentences as CachedSentence[]) : [];
    const sentences = rawSentences.slice(0, 30);
    const wordList = studiedWords
      .map((w) => (w.reading ? `${w.word}（${w.reading}）= ${w.meaning ?? ""}` : `${w.word} = ${w.meaning ?? ""}`))
      .join("\n");
    const sentenceContext = sentences
      .map((s) => `${learning.name}: ${s.jp ?? ""}\n${nativeLang}: ${s.en ?? ""}`)
      .join("\n\n");

    const systemPrompt = `You are a ${learning.name} language tutor writing a recap summary of an anime episode the learner just watched.

GOAL: Write a short natural ${learning.name} summary of the episode (4-7 sentences) that uses AS MANY of the learner's recently studied words as possible. The summary should feel like a natural recap, not a forced word-list.

RULES:
- Use the studied words list below — incorporate as many as you naturally can.
- Wrap each used vocabulary word in **double asterisks** like **食べる** so the UI can highlight them.
- Keep the ${learning.name} natural and at a level appropriate to the words given.
- Then provide a translation into the learner's language (${nativeLang}) that mirrors the ${learning.name} summary (also wrap the corresponding ${nativeLang} meaning of each highlighted word in **double asterisks**).
- All explanations and non-${learning.name} text MUST be written in ${nativeLang}.
- Return ONLY a JSON object, no extra text.`;

    const userPrompt = `Episode: ${ep?.episode_number ?? "?"}${ep?.title_en ? ` — ${ep.title_en}` : ""}

STUDIED WORDS (use as many as possible):
${wordList}

EPISODE SENTENCE CONTEXT (for plot reference):
${sentenceContext}`;

    const aiResp = await callAiChatCompletions({
      model: "gemini-2.5-flash",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "write_summary",
            description: "Write the recap summary",
            parameters: {
              type: "object",
              properties: {
                summary_jp: {
                  type: "string",
                  description: `${learning.name} recap, 4-7 sentences, with **word** highlights.`,
                },
                summary_en: {
                  type: "string",
                  description: `Translation into ${nativeLang} with **word** highlights matching the ${learning.name} version.`,
                },
                used_words: {
                  type: "array",
                  description:
                    "List of vocabulary words from the studied list that were actually used in the summary.",
                  items: { type: "string" },
                },
              },
              required: ["summary_jp", "summary_en", "used_words"],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "write_summary" } },
    });

    if (!aiResp.ok) {
      if (aiResp.status === 429) {
        return jsonResponse({ error: "Rate limit exceeded, please try again in a moment." }, 429);
      }
      if (aiResp.status === 402) {
        return jsonResponse({ error: "AI quota exhausted." }, 402);
      }
      const t = await aiResp.text();
      console.error("AI error:", aiResp.status, t);
      return jsonResponse({ error: "AI API error" }, 500);
    }

    const aiData = (await aiResp.json()) as {
      choices?: Array<{ message?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }>;
    };
    const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall?.function?.arguments) {
      console.error("No tool call in response:", JSON.stringify(aiData));
      return jsonResponse({ error: "AI did not return structured output" }, 500);
    }
    const args = JSON.parse(toolCall.function.arguments) as {
      summary_jp?: unknown;
      summary_en?: unknown;
      used_words?: unknown;
    };
    const summary_jp = String(args.summary_jp ?? "");
    const summary_en = String(args.summary_en ?? "");
    const used_words = Array.isArray(args.used_words)
      ? args.used_words.filter((w): w is string => typeof w === "string")
      : [];

    const { error: saveErr } = await supabase.from("episode_summaries").upsert(
      {
        user_id: userId,
        episode_id,
        learning_language: learning.code,
        summary_jp,
        summary_en,
        used_words,
      },
      { onConflict: "user_id,episode_id,learning_language" },
    );
    if (saveErr) {
      console.error("Failed caching episode summary:", saveErr.message);
      return jsonResponse({ error: "Failed to save summary" }, 500);
    }

    return jsonResponse({ summary_jp, summary_en, used_words, cached: false });
  } catch (e) {
    console.error("episode-summary error:", e);
    return jsonResponse({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
