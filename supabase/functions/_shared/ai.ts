// Direct Google Gemini OpenAI-compatible Chat Completions client.
// Defaults to Google AI Studio's official OpenAI-compatible endpoint using GEMINI_API_KEY,
// with optional AI_BASE_URL / AI_API_KEY / AI_MODEL overrides for any OpenAI-compatible provider.

const DEFAULT_AI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
export const DEFAULT_AI_MODEL = "gemini-3.5-flash-lite";
export const GEMINI_FALLBACK_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash-lite",
] as const;

const DEPRECATED_GEMINI_MODELS = new Set([
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-3-flash-preview",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
]);

export function getAiApiKey(req?: Request): string {
  const userKey = req?.headers.get("x-gemini-api-key")?.trim();
  if (userKey) return userKey;
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
  const stripped = requested.replace(/^google\//i, "").trim();
  if (!stripped || DEPRECATED_GEMINI_MODELS.has(stripped)) return DEFAULT_AI_MODEL;
  return stripped;
}

export function extractAiErrorDetail(rawBody: string, status: number): string {
  const trimmed = rawBody.trim();
  if (!trimmed) return `HTTP ${status}`;
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { message?: string; status?: string } | string;
      message?: string;
    };
    if (typeof parsed.error === "string") return `${status}: ${parsed.error}`.slice(0, 220);
    if (parsed.error && typeof parsed.error === "object" && parsed.error.message) {
      return `${status}: ${parsed.error.message}`.slice(0, 220);
    }
    if (typeof parsed.message === "string") return `${status}: ${parsed.message}`.slice(0, 220);
  } catch {
    // Non-JSON upstream error
  }
  return `${status}: ${trimmed.slice(0, 200)}`;
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

function isPermanentAuthFailure(status: number, bodyText: string): boolean {
  if (status === 401) return true;
  if (status === 400 || status === 403) {
    const lower = bodyText.toLowerCase();
    return lower.includes("api_key_invalid") || lower.includes("api key not valid");
  }
  return false;
}

export async function callAiChatCompletions(
  payload: Record<string, unknown>,
  explicitApiKey?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const apiKey = explicitApiKey || getAiApiKey();
  const endpoint = Deno.env.get("AI_BASE_URL")?.trim() || DEFAULT_AI_URL;
  const primaryModel = resolveAiModel(typeof payload.model === "string" ? payload.model : undefined);
  const isGeminiEndpoint = endpoint.includes("generativelanguage.googleapis.com");
  const hasExplicitModelEnv = Boolean(Deno.env.get("AI_MODEL")?.trim());

  const sanitizedTools =
    isGeminiEndpoint && payload.tools ? sanitizeToolsForGemini(payload.tools) : payload.tools;

  const candidateModels =
    isGeminiEndpoint && !hasExplicitModelEnv
      ? Array.from(new Set([primaryModel, ...GEMINI_FALLBACK_MODELS]))
      : [primaryModel];

  let lastResponse: Response | null = null;
  for (let i = 0; i < candidateModels.length; i++) {
    const model = candidateModels[i];
    const body: Record<string, unknown> = {
      ...payload,
      model,
    };
    if (sanitizedTools !== undefined) {
      body.tools = sanitizedTools;
    }

    const resp = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (resp.ok || i === candidateModels.length - 1) {
      return resp;
    }

    const errText = await resp.text();
    if (isPermanentAuthFailure(resp.status, errText)) {
      return new Response(errText, {
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
      });
    }

    if (
      resp.status === 429 ||
      resp.status === 404 ||
      resp.status === 403 ||
      resp.status === 400 ||
      resp.status >= 500
    ) {
      console.warn(
        `Gemini model '${model}' returned ${resp.status} (${extractAiErrorDetail(errText, resp.status)}); falling back to '${candidateModels[i + 1]}'`,
      );
      lastResponse = new Response(errText, {
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
      });
      continue;
    }

    return new Response(errText, {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
    });
  }

  return lastResponse as Response;
}

export type ValidatedChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export function validateClientMessages(
  raw: unknown,
  options?: { allowEmpty?: boolean; maxMessages?: number; maxCharsPerMessage?: number },
): { ok: true; messages: ValidatedChatMessage[] } | { ok: false; error: string } {
  const maxMessages = options?.maxMessages ?? 40;
  const maxChars = options?.maxCharsPerMessage ?? 4_000;

  if (!Array.isArray(raw)) {
    return { ok: false, error: "messages must be an array" };
  }
  if (!options?.allowEmpty && raw.length === 0) {
    return { ok: false, error: "messages required" };
  }
  if (raw.length > maxMessages) {
    return { ok: false, error: `Too many messages (max ${maxMessages})` };
  }

  const out: ValidatedChatMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      return { ok: false, error: "Each message must be an object" };
    }
    const { role, content } = item as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") {
      return { ok: false, error: "Message role must be 'user' or 'assistant'" };
    }
    if (typeof content !== "string") {
      return { ok: false, error: "Message content must be a string" };
    }
    if (content.length > maxChars) {
      return { ok: false, error: `Message exceeds max length of ${maxChars} characters` };
    }
    out.push({ role, content });
  }

  return { ok: true, messages: out };
}
