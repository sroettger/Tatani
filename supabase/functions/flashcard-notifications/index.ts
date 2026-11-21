import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { z } from "npm:zod@3";
import { currentSlot, eligibleWord, hasUnhandledDelivery } from "../_shared/push-schedule.ts";

const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const Schedule = z.object({ timezone: z.string().max(100).refine(v => { try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; } }), start_hour: z.number().int().min(0).max(23), end_hour: z.number().int().min(0).max(23), cards_per_hour: z.number().int().min(1).max(60) }).refine(s => s.end_hour > s.start_hour);
const Input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("settings"), device_id: z.string().uuid().optional() }),
  z.object({ action: z.literal("enable"), token: z.string().min(20).max(4096), schedule: Schedule }),
  z.object({ action: z.literal("disable"), device_id: z.string().uuid() }),
  z.object({ action: z.literal("test"), device_id: z.string().uuid() }),
  z.object({ action: z.literal("card"), delivery_id: z.string().uuid() }),
  z.object({ action: z.literal("review"), delivery_id: z.string().uuid(), remembered: z.boolean() }),
  z.object({ action: z.literal("dispatch"), job_id: z.string().uuid() }),
  z.object({ action: z.literal("notification_review"), delivery_id: z.string().uuid(), token: z.string().uuid(), remembered: z.boolean() }),
  z.object({ action: z.literal("quiz_answer"), delivery_id: z.string().uuid(), token: z.string().uuid().optional(), answer: z.number().int().min(-1).max(1) }),
]);

async function sendCard(device: any, slot: string): Promise<string> {
  const expireBefore = new Date(Date.now() - (slot.startsWith("test-") ? 0 : 2 * 3600_000)).toISOString();
  await db.from("flashcard_push_deliveries").update({ status: "expired" }).eq("user_id", device.user_id).is("reviewed_at", null).in("status", ["pending", "sent"]).lt("created_at", expireBefore);
  const { data: unhandled, error: pendingError } = await db.from("flashcard_push_deliveries").select("status,reviewed_at").eq("user_id", device.user_id).is("reviewed_at", null).in("status", ["pending", "sent"]).limit(1);
  if (pendingError) throw pendingError;
  if (hasUnhandledDelivery(unhandled ?? [])) return "unhandled";
  const { data: profile, error: profileError } = await db.from("profiles").select("learning_language,ui_language").eq("user_id", device.user_id).single();
  if (profileError) throw profileError;
  const language = profile.learning_language;
  const { data: states, error: stateError } = await db.from("user_word_state").select("word,reading,level,state,preference,known_source,last_reviewed_at,srs_due_at").eq("user_id", device.user_id).eq("learning_language", language);
  if (stateError) throw stateError;
  const dueStates = (states ?? []).filter(s => eligibleWord(s, true));
  if (!dueStates.length) return "empty";
  const dueWordSet = new Set(dueStates.map(s => s.word));
  type CardMeta = { word: string; reading: string | null; meaning: string; level: string | null; example_sentence_jp: string | null };
  const metaMap = new Map<string, CardMeta>();

  const { data: chunks, error: chunkError } = await db.from("study_chunks").select("id").eq("user_id", device.user_id).eq("learning_language", language).order("updated_at", { ascending: false }).limit(100);
  if (chunkError) throw chunkError;
  if (chunks?.length) {
    const { data: words, error: wordsError } = await db.from("study_chunk_words").select("word,reading,meaning,level,example_sentence_jp").in("chunk_id", chunks.map(c => c.id));
    if (wordsError) throw wordsError;
    for (const w of words ?? []) {
      if (w.meaning && dueWordSet.has(w.word) && (!metaMap.has(w.word) || (!metaMap.get(w.word)?.example_sentence_jp && w.example_sentence_jp))) {
        metaMap.set(w.word, { word: w.word, reading: w.reading, meaning: w.meaning, level: w.level, example_sentence_jp: w.example_sentence_jp });
      }
    }
  }

  // Also resolve graduated words learned directly from episodes without legacy chunks
  if (metaMap.size < dueWordSet.size) {
    const { data: lib } = await db.from("user_anime").select("anime_id").eq("user_id", device.user_id).eq("learning_language", language);
    const animeIds = (lib ?? []).map((r: { anime_id: string }) => r.anime_id);
    if (animeIds.length) {
      const { data: eps } = await db.from("episodes").select("id, seasons!inner(anime_id)").in("seasons.anime_id", animeIds).eq("processing_status", "ready").limit(60);
      const epIds = (eps ?? []).map((e: { id: string }) => e.id);
      if (epIds.length) {
        const { data: caches } = await db.from("episode_vocab_cache").select("vocab").in("episode_id", epIds).eq("language", language);
        for (const row of caches ?? []) {
          const vocab = Array.isArray(row.vocab) ? row.vocab : [];
          for (const v of vocab as Array<{ word?: string; reading?: string; meaning?: string; level?: string; jlpt_level?: string; example_sentence_jp?: string }>) {
            if (v.word && v.meaning && dueWordSet.has(v.word) && (!metaMap.has(v.word) || (!metaMap.get(v.word)?.example_sentence_jp && v.example_sentence_jp))) {
              metaMap.set(v.word, {
                word: v.word,
                reading: v.reading ?? null,
                meaning: v.meaning,
                level: v.level ?? v.jlpt_level ?? null,
                example_sentence_jp: v.example_sentence_jp ?? null,
              });
            }
          }
        }
      }
    }
  }

  const candidates = [...metaMap.values()];
  if (!candidates.length) return "empty";
  const { data: recent } = await db.from("flashcard_push_deliveries").select("word").eq("user_id", device.user_id).eq("learning_language", language).order("created_at", { ascending: false }).limit(50);
  const recentWords = new Set((recent ?? []).map(d => d.word));
  const fresh = candidates.filter(w => !recentWords.has(w.word));
  const pool = fresh.length ? fresh : candidates;
  const card = pool[Math.floor(Math.random() * pool.length)];
  const ja = profile.ui_language === "ja";
  const projectKey = Deno.env.get("LOVABLE_API_KEY");
  const connectionKey = Deno.env.get("FIREBASE_MESSAGING_API_KEY");
  if (!projectKey || !connectionKey) throw new Error("Firebase is not configured");
  const { data: delivery, error: insertError } = await db.from("flashcard_push_deliveries").insert({ user_id: device.user_id, device_id: device.id, slot, learning_language: language, word: card.word, reading: card.reading, meaning: card.meaning, example_sentence: card.example_sentence_jp, level: card.level, quiz_options: [ja ? "知ってる" : "I know", ja ? "わからない" : "I don't know"], quiz_correct_index: 0 }).select("id,review_token").single();
  if (insertError?.code === "P0001") return "unhandled";
  if (insertError?.code === "23505") return "duplicate";
  if (insertError || !delivery) throw insertError ?? new Error("Delivery was not created");
  const path = `/notifications/review/${delivery.id}`;
  // Answer key stays server-side; the worker submits only the chosen answer index.
  const data: Record<string, string> = {
    path, delivery_id: delivery.id, token: delivery.review_token, api: `${Deno.env.get("SUPABASE_URL")}/functions/v1/flashcard-notifications`,
    word: card.word, reading: card.reading ?? "",
    example: card.example_sentence_jp ?? "",
    l_know: ja ? "知ってる" : "I know",
    l_correct: ja ? "正解" : "Correct", l_incorrect: ja ? "不正解" : "Incorrect",
    l_dont_know: ja ? "わからない" : "I don't know",
    l_failed: ja ? "同期できませんでした" : "Couldn't sync",
  };
  let response: Response;
  try {
  response = await fetch("https://connector-gateway.lovable.dev/firebase_messaging/v1/projects/_/messages:send", {
    method: "POST", headers: { Authorization: `Bearer ${projectKey}`, "X-Connection-Api-Key": connectionKey, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { token: device.token, data, webpush: { headers: { TTL: "3600", Urgency: "high" } } } }),
  });
  } catch (error) {
    // Keep uncertain deliveries pending: a network timeout may still have delivered the card.
    console.error("Firebase delivery outcome unknown", error);
    throw error;
  }
  if (!response.ok) {
    const details = await response.text();
    // INVALID_ARGUMENT can describe malformed payloads, not just stale tokens.
    if (details.includes('"UNREGISTERED"')) await db.from("flashcard_push_devices").update({ enabled: false }).eq("id", device.id);
    await db.from("flashcard_push_deliveries").update({ status: "failed" }).eq("id", delivery.id);
    console.error(`Firebase send failed [${response.status}]: ${details}`);
    throw new Error(`Firebase send failed [${response.status}]: ${details}`);
  }
  await db.from("flashcard_push_deliveries").update({ status: "sent" }).eq("id", delivery.id);
  return "sent";
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const parsed = Input.safeParse(await req.json());
    if (!parsed.success) return reply({ error: "Invalid request", details: parsed.error.flatten() }, 400);
    const input = parsed.data;
    if (input.action === "quiz_answer") {
      let ownerId: string;
      if (input.token) {
        const { data: card, error } = await db.from("flashcard_push_deliveries").select("user_id").eq("id", input.delivery_id).eq("review_token", input.token).maybeSingle();
        if (error) throw error;
        if (!card) return reply({ error: "Unauthorized" }, 401);
        ownerId = card.user_id;
      } else {
        const jwt = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
        if (!jwt) return reply({ error: "Unauthorized" }, 401);
        const { data: auth, error } = await db.auth.getUser(jwt);
        if (error || !auth.user) return reply({ error: "Unauthorized" }, 401);
        ownerId = auth.user.id;
      }
      const { data: result, error } = await db.rpc("answer_flashcard_quiz", { delivery_id: input.delivery_id, owner_id: ownerId, selected_answer: input.answer });
      if (error) throw error;
      if (!result) return reply({ error: "Not found" }, 404);
      return reply(result);
    }
    if (input.action === "dispatch") {
      // A one-use queue record created by the database scheduler authenticates this callback.
      const { data: job, error } = await db.from("flashcard_push_jobs").update({ claimed_at: new Date().toISOString() }).eq("id", input.job_id).is("claimed_at", null).gte("created_at", new Date(Date.now() - 300000).toISOString()).select("id").maybeSingle();
      if (error || !job) return reply({ error: "Unauthorized" }, 401);
      const { data: devices, error: deviceError } = await db.from("flashcard_push_devices").select("*").eq("enabled", true);
      if (deviceError) throw deviceError;
      const results: string[] = [];
      for (const device of devices ?? []) {
        const slot = currentSlot(device, new Date());
        if (!slot) continue;
        try { results.push(await sendCard(device, slot)); } catch (error) { console.error(error); results.push("failed"); }
      }
      await db.from("flashcard_push_jobs").delete().lt("created_at", new Date(Date.now() - 86400000).toISOString());
      return reply({ results });
    }
    if (input.action === "notification_review") {
      // The per-delivery secret sent only to this device authorizes grading straight from the notification.
      const { data: card, error } = await db.from("flashcard_push_deliveries").select("id,user_id,quiz_options").eq("id", input.delivery_id).eq("review_token", input.token).maybeSingle();
      if (error) throw error;
      if (!card) return reply({ error: "Unauthorized" }, 401);
      if (card.quiz_options) return reply({ error: "Select a quiz answer" }, 400);
      const { data: recorded, error: reviewError } = await db.rpc("review_flashcard_delivery", { delivery_id: card.id, owner_id: card.user_id, remembered: input.remembered });
      if (reviewError) throw reviewError;
      return reply({ recorded });
    }
    const jwt = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    if (!jwt) return reply({ error: "Unauthorized" }, 401);
    const { data: auth, error: authError } = await db.auth.getUser(jwt);
    if (authError || !auth.user) return reply({ error: "Unauthorized" }, 401);
    const uid = auth.user.id;
    if (input.action === "enable") {
      const { data, error } = await db.from("flashcard_push_devices").upsert({ user_id: uid, token: input.token, enabled: true, ...input.schedule, cards_per_day: 1, updated_at: new Date().toISOString() }, { onConflict: "token" }).select("id,enabled,timezone,start_hour,end_hour,cards_per_hour").single();
      if (error) throw error;
      return reply({ device: data });
    }
    if (input.action === "settings") {
      if (!input.device_id) return reply({ device: null });
      const { data, error } = await db.from("flashcard_push_devices").select("id,enabled,timezone,start_hour,end_hour,cards_per_hour").eq("user_id", uid).eq("id", input.device_id).maybeSingle();
      if (error) throw error;
      return reply({ device: data });
    }
    if (input.action === "card" || input.action === "review") {
      const { data: card, error } = await db.from("flashcard_push_deliveries").select("id,word,reading,meaning,example_sentence,learning_language,reviewed_at,quiz_options,quiz_selected_index,quiz_correct_index").eq("id", input.delivery_id).eq("user_id", uid).maybeSingle();
      if (error) throw error;
      if (!card) return reply({ error: "Not found" }, 404);
      if (input.action === "card") {
        const { quiz_correct_index, ...visible } = card;
        return reply({ card: { ...visible, meaning: card.reviewed_at || !card.quiz_options ? card.meaning : null } });
      }
      if (card.quiz_options) return reply({ error: "Select a quiz answer" }, 400);
      const { data: recorded, error: reviewError } = await db.rpc("review_flashcard_delivery", { delivery_id: card.id, owner_id: uid, remembered: input.remembered });
      if (reviewError) throw reviewError;
      return reply({ recorded });
    }
    const { data: device, error } = await db.from("flashcard_push_devices").select("*").eq("id", input.device_id).eq("user_id", uid).maybeSingle();
    if (error) throw error;
    if (!device) return reply({ error: "Not found" }, 404);
    if (input.action === "disable") {
      const { error } = await db.from("flashcard_push_devices").update({ enabled: false }).eq("id", device.id);
      if (error) throw error;
      return reply({ disabled: true });
    }
    if (!device.enabled) return reply({ error: "Notifications are disabled" }, 400);
    return reply({ result: await sendCard(device, `test-${crypto.randomUUID()}`) });
  } catch (error) {
    const message = error instanceof Error ? error.message : (error as { message?: string })?.message ?? "Request failed";
    return reply({ error: message }, message === "Quiz expired" ? 410 : 500);
  }
});