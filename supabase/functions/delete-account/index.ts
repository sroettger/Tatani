// Authenticated account deletion: removes all user-owned data across all tables and deletes the auth.users record.
import {
  corsHeaders,
  createAdminClient,
  jsonResponse,
  requireAuthUser,
} from "../_shared/auth.ts";

const USER_OWNED_TABLES = [
  "quiz_results",
  "study_sessions",
  "study_chunks",
  "episode_summaries",
  "user_word_state",
  "user_anime",
  "flashcard_push_deliveries",
  "flashcard_push_devices",
  "user_language_progress",
  "user_roles",
  "profiles",
] as const;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const auth = await requireAuthUser(req, { allowClaimsFallback: false });
    if (auth instanceof Response) return auth;
    const { userId } = auth;

    const admin = createAdminClient();

    // Best-effort cleanup of any user-uploaded subtitle blobs under `${userId}/`
    try {
      const { data: uploadedFiles } = await admin.storage.from("subtitles").list(userId, { limit: 1000 });
      if (uploadedFiles && uploadedFiles.length > 0) {
        const paths = uploadedFiles
          .map((f) => (f.name ? `${userId}/${f.name}` : ""))
          .filter((p) => p.length > 0);
        if (paths.length > 0) {
          await admin.storage.from("subtitles").remove(paths);
        }
      }
    } catch (storageErr) {
      console.warn("Non-fatal error cleaning user subtitle uploads:", storageErr);
    }

    // Belt-and-suspenders deletion of user-owned rows before deleting auth.users (which also cascades)
    for (const table of USER_OWNED_TABLES) {
      const { error } = await admin.from(table).delete().eq("user_id", userId);
      if (error) {
        console.error(`Failed deleting user rows from ${table}:`, error.message);
        return jsonResponse({ error: `Failed deleting account data (${table})` }, 500);
      }
    }

    const { error: deleteUserError } = await admin.auth.admin.deleteUser(userId);
    if (deleteUserError) {
      console.error("Failed deleting auth.users record:", deleteUserError.message);
      return jsonResponse({ error: deleteUserError.message }, 500);
    }

    return jsonResponse({ ok: true, deleted_user_id: userId });
  } catch (err) {
    console.error("delete-account error:", err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Account deletion failed" }, 500);
  }
});
