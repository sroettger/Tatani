// Direct Google Gemini OpenAI-compatible Chat Completions client.
// Defaults to Google AI Studio's official OpenAI-compatible endpoint using GEMINI_API_KEY,
// with optional AI_BASE_URL / AI_API_KEY / AI_MODEL overrides for any OpenAI-compatible provider.

const DEFAULT_AI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const DEFAULT_AI_MODEL = "gemini-2.5-flash";

export function getAiApiKey(): string {
  const key = Deno.env.get("GEMINI_API_KEY")?.trim() || Deno.env.get("AI_API_KEY")?.trim();
  if (!key) {
    throw new Error("GEMINI_API_KEY is not configured in Supabase Edge Function secrets");
  }
  return key;
}

export function resolveAiModel(requested?: string): string {
  const override = Deno.env.get("AI_MODEL")?.trim();
  if (override) return override;
  if (!requested) return DEFAULT_AI_MODEL;
  const stripped = requested.replace(/^google\//i, "");
  if (stripped === "gemini-3-flash-preview") return DEFAULT_AI_MODEL;
  return stripped || DEFAULT_AI_MODEL;
}

/**
 * Strip `additionalProperties` recursively from tool parameter schemas so Google's
 * Gemini FunctionDeclaration validator never rejects strict OpenAI JSON schemas.
 */
export function sanitizeToolsForGemini(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(sanitizeToolsForGemini);
  if (val && typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (k === "additionalProperties") continue;
      out[k] = sanitizeToolsForGemini(v);
    }
    return out;
  }
  return val;
}

export async function callAiChatCompletions(
  payload: Record<string, unknown>,
  explicitApiKey?: string,
): Promise<Response> {
  const apiKey = explicitApiKey || getAiApiKey();
  const endpoint = Deno.env.get("AI_BASE_URL")?.trim() || DEFAULT_AI_URL;
  const model = resolveAiModel(typeof payload.model === "string" ? payload.model : undefined);

  const body: Record<string, unknown> = {
    ...payload,
    model,
  };

  if (endpoint.includes("generativelanguage.googleapis.com") && body.tools) {
    body.tools = sanitizeToolsForGemini(body.tools);
  }

  return await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
