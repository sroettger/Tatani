// Unified CORS headers, Bearer JWT verification, and Supabase client factories for Edge Functions.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-retry-count, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const BEARER_RE = /^\s*Bearer\s+(.+?)\s*$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function extractBearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization") ?? req.headers.get("authorization");
  if (!header) return null;
  const match = BEARER_RE.exec(header);
  return match?.[1] ? match[1] : null;
}

export function createAdminClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceKey) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured");
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function createUserClient(jwt: string): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey =
    Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
  if (!url || !anonKey) {
    throw new Error("SUPABASE_URL or SUPABASE_ANON_KEY is not configured");
  }
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

export interface AuthUser {
  userId: string;
  email: string | null;
}

export async function requireAuthUser(
  req: Request,
  options?: { allowClaimsFallback?: boolean },
): Promise<AuthUser | Response> {
  const jwt = extractBearerToken(req);
  if (!jwt) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let userClient: SupabaseClient;
  try {
    userClient = createUserClient(jwt);
  } catch (err) {
    console.error("Failed to initialize Supabase user client:", err);
    return jsonResponse({ error: "Server configuration error" }, 500);
  }

  const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
  if (!userErr && userData?.user?.id && UUID_RE.test(userData.user.id)) {
    return {
      userId: userData.user.id,
      email: userData.user.email ?? null,
    };
  }

  const allowFallback = options?.allowClaimsFallback ?? true;
  const errStatus = (userErr as { status?: number } | null)?.status;
  if (allowFallback && errStatus !== 401 && errStatus !== 403) {
    const { data: claimsData, error: claimsErr } = await userClient.auth.getClaims(jwt);
    const claims = claimsData?.claims as Record<string, unknown> | undefined;
    if (
      !claimsErr &&
      claims &&
      claims.role === "authenticated" &&
      typeof claims.sub === "string" &&
      UUID_RE.test(claims.sub) &&
      (typeof claims.exp !== "number" || claims.exp * 1000 > Date.now())
    ) {
      return {
        userId: claims.sub,
        email: typeof claims.email === "string" ? claims.email : null,
      };
    }
  }

  return jsonResponse({ error: "Unauthorized" }, 401);
}
