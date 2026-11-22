// Generate a placement quiz (~20 adaptive questions across the learner's level scale) via Gemini API.
import {
  corsHeaders,
  createAdminClient,
  jsonResponse,
  requireAuthUser,
} from "../_shared/auth.ts";
import { callAiChatCompletions, getAiApiKey } from "../_shared/ai.ts";
import { getUserLanguages, uiLanguageName } from "../_shared/languages.ts";

type RawQuizQuestion = {
  prompt?: unknown;
  word?: unknown;
  jp_word?: unknown;
  reading?: unknown;
  choices?: unknown;
  correct_index?: unknown;
  level?: unknown;
  jlpt_level?: unknown;
};

type NormalizedQuizQuestion = {
  prompt: string;
  word: string;
  jp_word: string;
  reading: string;
  choices: string[];
  correct_index: number;
  level: string;
  jlpt_level: string;
};

const buildTool = (targetName: string, scale: string, levels: string[]) => ({
  type: "function",
  function: {
    name: "build_placement_quiz",
    description: `Build a 20-question adaptive ${targetName} placement quiz spanning ${levels[0]} to ${levels[levels.length - 1]}.`,
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              prompt: {
                type: "string",
                description: "The question shown to the learner, written in their own language.",
              },
              word: {
                type: "string",
                description: `The ${targetName} word being tested (dictionary form).`,
              },
              reading: {
                type: "string",
                description: "Phonetic reading; empty string for languages that don't need one.",
              },
              choices: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 4 },
              correct_index: { type: "integer", minimum: 0, maximum: 3 },
              level: { type: "string", enum: levels, description: `${scale} level of the word.` },
            },
            required: ["prompt", "word", "reading", "choices", "correct_index", "level"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
  },
});

function normalizeBatchQuestions(
  rawList: unknown,
  fallbackLevel: string,
): NormalizedQuizQuestion[] {
  if (!Array.isArray(rawList)) return [];
  const out: NormalizedQuizQuestion[] = [];
  for (const item of rawList as RawQuizQuestion[]) {
    if (!item || typeof item !== "object") continue;
    const word = String(item.word ?? item.jp_word ?? "").trim();
    const prompt = String(item.prompt ?? "").trim();
    const reading = typeof item.reading === "string" ? item.reading.trim() : "";
    const level = String(item.level ?? item.jlpt_level ?? fallbackLevel).trim() || fallbackLevel;
    const choices = Array.isArray(item.choices)
      ? item.choices.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
      : [];
    const correctIndex = Number(item.correct_index);
    if (!word || !prompt || choices.length !== 4 || !Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3) {
      continue;
    }
    out.push({
      prompt,
      word,
      jp_word: word,
      reading,
      choices,
      correct_index: correctIndex,
      level,
      jlpt_level: level,
    });
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const auth = await requireAuthUser(req);
    if (auth instanceof Response) return auth;
    const { userId } = auth;

    const service = createAdminClient();
    const { learning, uiLanguage } = await getUserLanguages(service, userId);
    const nativeLang = uiLanguageName(uiLanguage);
    const scale = learning.scale === "jlpt" ? "JLPT" : "CEFR";
    const levels = learning.levels;

    const aiApiKey = getAiApiKey();

    const genForLevelsOnce = async (
      batchLevels: string[],
      count: number,
    ): Promise<{ status: number; questions: NormalizedQuizQuestion[] }> => {
      try {
        const aiResp = await callAiChatCompletions(
          {
            model: "gemini-2.5-flash",
            reasoning_effort: "low",
            messages: [
              {
                role: "system",
                content: `You write ${learning.name} placement quizzes. Return exactly ${count} multiple-choice questions at ${scale} level(s) ${batchLevels.join(", ")}. Each question tests vocabulary recognition (${learning.name} word → its meaning). Write the prompt and all four answer choices in ${nativeLang}. ${learning.morphological ? "Include the kana reading for each word." : "Leave the reading field as an empty string."} Provide 4 plausible distractors.`,
              },
              { role: "user", content: "Generate the questions now." },
            ],
            tools: [buildTool(learning.name, scale, batchLevels)],
            tool_choice: { type: "function", function: { name: "build_placement_quiz" } },
          },
          aiApiKey,
        );
        if (!aiResp.ok) {
          const t = await aiResp.text();
          console.error("AI API error", aiResp.status, t);
          return { status: aiResp.status, questions: [] };
        }
        const aiJson = (await aiResp.json()) as {
          choices?: Array<{ message?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }>;
        };
        const call = aiJson?.choices?.[0]?.message?.tool_calls?.[0];
        if (!call?.function?.arguments) return { status: 502, questions: [] };
        const parsed = JSON.parse(call.function.arguments) as { questions?: unknown };
        const questions = normalizeBatchQuestions(parsed?.questions, batchLevels[0]);
        if (questions.length === 0) return { status: 502, questions: [] };
        return { status: 200, questions };
      } catch (err) {
        console.warn("Placement batch parse/network failure:", err);
        return { status: 502, questions: [] };
      }
    };

    // Retry failed level batches once before giving up.
    const genForLevelsWithRetry = async (
      batchLevels: string[],
      count: number,
    ): Promise<{ status: number; questions: NormalizedQuizQuestion[] }> => {
      const first = await genForLevelsOnce(batchLevels, count);
      if (first.status === 200 && first.questions.length > 0) return first;
      if (first.status === 402) return first;
      await new Promise((r) => setTimeout(r, 500));
      return await genForLevelsOnce(batchLevels, count);
    };

    // Distribute exactly 20 questions across all levels (e.g. [4,4,4,4,4] for 5 JLPT levels, [4,4,3,3,3,3] for 6 CEFR levels).
    const basePerLevel = Math.floor(20 / levels.length);
    const remainder = 20 % levels.length;
    const results = await Promise.all(
      levels.map((lvl, idx) => genForLevelsWithRetry([lvl], basePerLevel + (idx < remainder ? 1 : 0))),
    );

    const succeededLevels = results.filter((r) => r.status === 200 && r.questions.length > 0).length;
    const majorityLevels = Math.floor(levels.length / 2) + 1;
    const questions = results.flatMap((r) => r.questions);

    if (succeededLevels < majorityLevels || questions.length === 0) {
      const rateLimited = results.find((r) => r.status === 429);
      const quotaExhausted = results.find((r) => r.status === 402);
      if (quotaExhausted) return jsonResponse({ error: "AI credits exhausted." }, 402);
      if (rateLimited) return jsonResponse({ error: "Rate limit exceeded." }, 429);
      return jsonResponse({ error: "Quiz generation failed" }, 502);
    }

    return jsonResponse({ questions });
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});
