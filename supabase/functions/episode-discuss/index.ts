import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { callAiChatCompletions } from "../_shared/ai.ts";
import { getUserLanguages, uiLanguageName } from "../_shared/languages.ts";

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

    const { learning, uiLanguage, level } = await getUserLanguages(supabase, user.id);
    const nativeLang = uiLanguageName(uiLanguage);
    const learnerLevel = level && level !== "none" ? level : learning.levels[0];

    // Gather context: episode info, sentences, studied vocab for this episode
    const [{ data: ep }, { data: cache }, { data: chunks }] = await Promise.all([
      supabase.from("episodes").select("episode_number,title_jp,title_en").eq("id", episode_id).maybeSingle(),
      supabase.from("episode_vocab_cache").select("vocab,sentences").eq("episode_id", episode_id).eq("language", learning.code).maybeSingle(),
      supabase.from("study_chunks").select("id").eq("user_id", user.id).eq("episode_id", episode_id).eq("learning_language", learning.code).not("studied_at", "is", null),
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

    // Use as many cached sentences as we can — these ARE the episode's plot for the AI.
    const allSentences = ((cache?.sentences ?? []) as any[]);
    const sentenceContext = allSentences.map((s: any, i: number) => `[${i + 1}] ${learning.name}: ${s.jp}\n    ${nativeLang}: ${s.en}`).join("\n");
    const wordList = studiedWords.length
      ? studiedWords.map(w => w.reading ? `- ${w.word}（${w.reading}）= ${w.meaning}` : `- ${w.word} = ${w.meaning}`).join("\n")
      : "(none yet)";

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
- After your ${learning.name} reply, on a NEW LINE, add a ${nativeLang} translation in italics like: *(${nativeLang}: ...)* — this helps the learner check understanding without breaking the ${learning.name} flow.
- If you use a vocabulary word from their studied list, you may bold it with **word** so the UI can highlight it.
- Be warm, curious, and fun — like a friend who just watched the episode with them.

GENTLE CORRECTIONS (only when the learner writes ${learning.name}):
- If their last message contains unnatural grammar, wrong word choice, or a clear mistake, gently correct it BEFORE your normal reply.
- Format the correction block on its own lines at the very TOP of your response, like this exactly:
  > 💡 More natural: "<corrected ${learning.name}>"
  > *(You wrote "<their original phrase>" — <very brief reason in ${nativeLang}, max 1 short sentence>)*
- Then leave a blank line and continue with your normal ${learning.name} reply + ${nativeLang} translation.
- Only correct ACTUAL mistakes — never nitpick, never correct stylistic choices, never correct beginners for not using advanced grammar. If their ${learning.name} is fine (even if simple), skip the correction entirely.
- Never correct messages written in ${nativeLang} — just reply normally and encourage ${learning.name}.
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
          content: `Start our conversation. Greet me briefly, then ask ONE specific, concrete question in ${learning.name} about something that actually happened in this episode (reference a specific moment, line, or event from the subtitles). IMPORTANT: weave 1-2 of my recently studied words into your greeting/question naturally and bold them with **word**. Keep it short and inviting.`,
        }]
      : messages;

    const aiResp = await callAiChatCompletions({
      model: "gemini-2.5-flash",
      messages: [
        { role: "system", content: systemPrompt },
        ...finalMessages,
      ],
      stream: true,
    });

    if (!aiResp.ok) {
      if (aiResp.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded, please try again in a moment." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResp.status === 402) {
        return new Response(JSON.stringify({ error: "AI quota exhausted." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const t = await aiResp.text();
      console.error("AI error:", aiResp.status, t);
      return new Response(JSON.stringify({ error: "AI API error" }), {
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
