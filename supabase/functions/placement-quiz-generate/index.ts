// Generate a JLPT placement quiz (~20 adaptive questions across N5→N1) via Lovable AI.
import { corsHeaders } from "@supabase/supabase-js/cors";

const TOOL = {
  type: "function",
  function: {
    name: "build_placement_quiz",
    description: "Build a 20-question adaptive Japanese placement quiz spanning JLPT N5 to N1.",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              prompt: { type: "string", description: "The question shown to the user, in English when asking 'what does X mean' style." },
              jp_word: { type: "string", description: "The Japanese word being tested (dictionary form)." },
              reading: { type: "string" },
              choices: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 4 },
              correct_index: { type: "integer", minimum: 0, maximum: 3 },
              jlpt_level: { type: "string", enum: ["N5","N4","N3","N2","N1"] },
            },
            required: ["prompt","jp_word","reading","choices","correct_index","jlpt_level"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY missing");

    const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: "You write Japanese placement quizzes. Always return exactly 20 multiple-choice questions distributed roughly: 4 N5, 4 N4, 4 N3, 4 N2, 4 N1. Each question tests vocabulary recognition (Japanese → English meaning). Provide 4 plausible distractors." },
          { role: "user", content: "Generate a placement quiz now." },
        ],
        tools: [TOOL],
        tool_choice: { type: "function", function: { name: "build_placement_quiz" } },
      }),
    });
    if (!aiResp.ok) {
      const t = await aiResp.text();
      console.error("AI gateway error", aiResp.status, t);
      if (aiResp.status === 429) return new Response(JSON.stringify({ error: "Rate limit exceeded." }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      if (aiResp.status === 402) return new Response(JSON.stringify({ error: "AI credits exhausted." }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ error: "Quiz generation failed" }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const aiJson = await aiResp.json();
    const call = aiJson?.choices?.[0]?.message?.tool_calls?.[0];
    if (!call?.function?.arguments) {
      return new Response(JSON.stringify({ error: "no quiz returned" }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const data = JSON.parse(call.function.arguments);
    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "unknown" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
