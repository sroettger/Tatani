// Admin-only: wipe all anime catalog data + every user's library/study state tied to it.
// Used by the "Delete anime data" Settings button when iterating during dev.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: claims, error: claimsErr } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
    if (claimsErr || !claims?.claims) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = claims.claims.sub as string;

    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Verify caller has admin role.
    const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", userId).eq("role", "admin");
    if (!roles || roles.length === 0) {
      return new Response(JSON.stringify({ error: "Forbidden — admin only" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Order matters for FK-less but logically dependent rows. Use neq() trick to delete all.
    const wipes = [
      ["study_chunk_words", "id"],
      ["study_chunks", "id"],
      ["study_sessions", "id"],
      ["quiz_results", "id"],
      ["user_anime", "id"],
      ["episode_vocab_cache", "id"],
      ["subtitles", "id"],
      ["episodes", "id"],
      ["seasons", "id"],
      ["anime", "id"],
    ] as const;

    const counts: Record<string, number> = {};
    for (const [table, col] of wipes) {
      const { error, count } = await admin
        .from(table)
        .delete({ count: "exact" })
        .neq(col, "00000000-0000-0000-0000-000000000000");
      if (error) {
        console.error(`Failed wiping ${table}:`, error.message);
        return new Response(JSON.stringify({ error: `Failed wiping ${table}: ${error.message}` }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      counts[table] = count ?? 0;
    }

    console.log(`Anime data wiped by ${userId}:`, counts);
    return new Response(JSON.stringify({ ok: true, counts }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "unknown" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
