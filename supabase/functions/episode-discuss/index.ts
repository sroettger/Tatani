import {
  corsHeaders,
  createAdminClient,
  jsonResponse,
  requireAuthUser,
} from "../_shared/auth.ts";
import { callAiChatCompletions, validateClientMessages } from "../_shared/ai.ts";
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
      messages?: unknown;
      auto_start?: unknown;
      learning_language?: unknown;
    };
    const episode_id = typeof body.episode_id === "string" ? body.episode_id.trim() : "";
    const autoStart = Boolean(body.auto_start);
    const requestedLang = typeof body.learning_language === "string" ? body.learning_language : undefined;

    if (!episode_id) {
      return jsonResponse({ error: "episode_id required" }, 400);
    }

    const validated = validateClientMessages(body.messages, {
      allowEmpty: autoStart,
      maxMessages: 40,
      maxCharsPerMessage: 4_000,
    });
    if (!validated.ok) {
      return jsonResponse({ error: validated.error }, 400);
    }
    const messages = validated.messages;

    const supabase = createAdminClient();
    const { learning, uiLanguage, level } = await getUserLanguages(supabase, userId, requestedLang);
    const nativeLang = uiLanguageName(uiLanguage);
    const translationLabel = nativeLang.replace(/\s*\([^)]*\)/g, "").trim();
    const includeTranslation = uiLanguage !== learning.code;
    const learnerLevel = level && level !== "none" ? level : learning.levels[0];

    // Gather context: episode info, sentences, studied vocab for this episode
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

    const allSentences = Array.isArray(cache?.sentences) ? (cache.sentences as CachedSentence[]) : [];
    const sentenceContext = allSentences
      .map((s, i) => `[${i + 1}] ${learning.name}: ${s.jp ?? ""}\n    ${nativeLang}: ${s.en ?? ""}`)
      .join("\n");
    const wordList = studiedWords.length
      ? studiedWords
          .map((w) => (w.reading ? `- ${w.word}（${w.reading}）= ${w.meaning ?? ""}` : `- ${w.word} = ${w.meaning ?? ""}`))
          .join("\n")
      : "(none yet)";

    const translationInstruction = includeTranslation
      ? `- After your ${learning.name} reply, on a NEW LINE, add a ${nativeLang} translation in italics using this clean non-nested tag format: *(${translationLabel}: <translation without parentheses>)* — do NOT nest parentheses inside the tag.`
      : `- Do NOT append a separate translation line after your ${learning.name} reply, because the learner's UI language is already ${learning.name}.`;

    const systemPrompt = `You are a conversation partner discussing, in ${learning.name}, an anime episode the learner just watched.

LEARNER LEVEL: ${learning.scale === "jlpt" ? "JLPT" : "CEFR"} ${learnerLevel}
EPISODE: ${ep?.episode_number ?? "?"}${ep?.title_en ? ` — ${ep.title_en}` : ""}

YOUR ROLE:
- Always reply in ${learning.name} (never switch languages for the main reply).
- Match the learner's level (${learnerLevel}). Use simple grammar and vocabulary they can understand.
- You HAVE WATCHED THIS EPISODE — the numbered subtitle lines below ARE the actual dialogue. Refer to specific moments, characters' lines, and events from those subtitles. Do NOT make up plot points that aren't supported by the subtitles.
- Ask SPECIFIC, CONCRETE questions about things that actually happened in this episode (a particular line a character said, a specific event, an emotional moment), not generic questions like "did you like it?".
- Prefer using the learner's RECENTLY STUDIED WORDS below when they fit naturally — this reinforces their learning.
- ACTIVELY weave in 1-3 of the learner's recently studied words in EVERY reply (including the opening question). Pick words that fit the topic naturally — don't force awkward usage. Bold each studied word you use with **word** so the UI highlights it.
- Try to rotate through different studied words across the conversation rather than reusing the same ones.
- Keep responses SHORT (2-4 sentences max) so it feels like a real conversation.
- The learner's own language is ${nativeLang}. Any explanation, translation or meta-comment must be written in ${nativeLang}.
- If the learner writes in ${nativeLang} instead of ${learning.name}, gently encourage ${learning.name}: respond mostly in ${learning.name}.
${translationInstruction}
- If you use a vocabulary word from their studied list, you may bold it with **word** so the UI can highlight it.
- Be warm, curious, and fun — like a friend who just watched the episode with them.

GENTLE CORRECTIONS (only when the learner writes ${learning.name}):
- If their last message contains unnatural grammar, wrong word choice, or a clear mistake, gently correct it BEFORE your normal reply.
- Format the correction block on its own lines at the very TOP of your response, like this exactly:
  > 💡 More natural: "<corrected ${learning.name}>"
  > *(You wrote "<their original phrase>" — <very brief reason in ${nativeLang}, max 1 short sentence>)*
- Then leave a blank line and continue with your normal ${learning.name} reply${includeTranslation ? ` + ${translationLabel} translation` : ""}.
- Only correct ACTUAL mistakes — never nitpick, never correct stylistic choices, never correct beginners for not using advanced grammar. If their ${learning.name} is fine (even if simple), skip the correction entirely.
- Never correct messages written in ${nativeLang} — just reply normally and encourage ${learning.name}.
- At most ONE correction per reply, focused on the single most important issue.

LEARNER'S RECENTLY STUDIED WORDS (use these when natural):
${wordList}

ACTUAL EPISODE DIALOGUE (numbered subtitle lines from this episode — your source of truth):
${sentenceContext || "(no subtitles available — ask general questions instead)"}`;

    const finalMessages =
      autoStart && messages.length === 0
        ? [
            {
              role: "user" as const,
              content: `Start our conversation. Greet me briefly, then ask ONE specific, concrete question in ${learning.name} about something that actually happened in this episode (reference a specific moment, line, or event from the subtitles). IMPORTANT: weave 1-2 of my recently studied words into your greeting/question naturally and bold them with **word**. Keep it short and inviting.`,
            },
          ]
        : messages;

    const aiResp = await callAiChatCompletions({
      model: "gemini-2.5-flash",
      messages: [{ role: "system", content: systemPrompt }, ...finalMessages],
      stream: true,
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

    return new Response(aiResp.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("episode-discuss error:", e);
    return jsonResponse({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
