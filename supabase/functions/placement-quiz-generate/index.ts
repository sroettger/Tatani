// Generate a placement quiz (~20 adaptive questions across the learner's level scale) via Lovable AI.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getUserLanguages, uiLanguageName } from "../_shared/languages.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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
              prompt: { type: "string", description: "The question shown to the learner, written in their own language." },
              word: { type: "string", description: `The ${targetName} word being tested (dictionary form).` },
              reading: { type: "string", description: "Phonetic reading; empty string for languages that don't need one." },
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "", { global: { headers: { Authorization: authHeader } } });
    const { data: claims, error: claimsErr } = await supa.auth.getClaims(authHeader.replace("Bearer ", ""));
    if (claimsErr || !claims?.claims) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const userId = (claims.claims as any).sub as string;
    const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { learning, uiLanguage } = await getUserLanguages(service, userId);
    const nativeLang = uiLanguageName(uiLanguage);
    const scale = learning.scale === "jlpt" ? "JLPT" : "CEFR";
    const levels = learning.levels;
    const perLevel = Math.round(20 / levels.length);

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY missing");

    const genForLevels = async (batchLevels: string[], count: number) => {
      const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google/gemini-3-flash-preview",
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
        }),
      });
      if (!aiResp.ok) {
        const t = await aiResp.text();
        console.error("AI gateway error", aiResp.status, t);
        return { status: aiResp.status, questions: [] as any[] };
      }
      const questions = rawQuestions.map((q: any) => ({
      ...q,
      word: q.word ?? q.jp_word ?? "",
      level: q.level ?? q.jlpt_level ?? levels[0],
      jp_word: q.word ?? q.jp_word ?? "",
      jlpt_level: q.level ?? q.jlpt_level ?? levels[0],
      reading: q.reading ?? "",
    }));
    return new Response(JSON.stringify({ questions }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "unknown" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
