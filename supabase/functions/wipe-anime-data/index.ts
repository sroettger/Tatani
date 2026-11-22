// Admin-only: wipe all anime catalog data + every user's library/study state tied to it,
// including episode_summaries and subtitle storage objects.
import {
  corsHeaders,
  createAdminClient,
  jsonResponse,
  requireAuthUser,
} from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const auth = await requireAuthUser(req);
    if (auth instanceof Response) return auth;
    const { userId } = auth;

    const admin = createAdminClient();

    // Verify caller has admin role.
    const { data: roles, error: roleErr } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin");
    if (roleErr || !roles || roles.length === 0) {
      return jsonResponse({ error: "Forbidden — admin only" }, 403);
    }

    const counts: Record<string, number> = {};

    // 1. Clean subtitle files in storage.objects (bucket_id = 'subtitles')
    let storageDeleted = 0;
    const { data: subRows } = await admin.from("subtitles").select("storage_path");
    const paths = Array.from(
      new Set((subRows ?? []).map((r: { storage_path: string }) => r.storage_path).filter(Boolean)),
    );
    for (let i = 0; i < paths.length; i += 100) {
      const batch = paths.slice(i, i + 100);
      const { data: removed } = await admin.storage.from("subtitles").remove(batch);
      storageDeleted += removed?.length ?? 0;
    }
    const { error: emptyErr } = await admin.storage.emptyBucket("subtitles");
    if (emptyErr) {
      // Fallback direct delete on storage.objects if Storage REST emptyBucket is unavailable
      const { count: objCount } = await admin
        .schema("storage")
        .from("objects")
        .delete({ count: "exact" })
        .eq("bucket_id", "subtitles");
      storageDeleted = Math.max(storageDeleted, objCount ?? 0);
    }
    counts["storage_subtitles"] = storageDeleted;

    // 2. Delete public catalog & study tables in strict dependency order (quiz_results before study_sessions).
    const wipes = [
      ["study_chunk_words", "id"],
      ["study_chunks", "id"],
      ["quiz_results", "id"],
      ["study_sessions", "id"],
      ["episode_summaries", "id"],
      ["user_anime", "id"],
      ["episode_vocab_cache", "id"],
      ["subtitles", "id"],
      ["episodes", "id"],
      ["seasons", "id"],
      ["anime", "id"],
    ] as const;

    for (const [table, col] of wipes) {
      const { error, count } = await admin
        .from(table)
        .delete({ count: "exact" })
        .neq(col, "00000000-0000-0000-0000-000000000000");
      if (error) {
        console.error(`Failed wiping ${table}:`, error.message);
        return jsonResponse({ error: `Failed wiping ${table}: ${error.message}` }, 500);
      }
      counts[table] = count ?? 0;
    }

    console.log(`Anime data wiped by ${userId}:`, counts);
    return jsonResponse({ ok: true, counts });
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});
