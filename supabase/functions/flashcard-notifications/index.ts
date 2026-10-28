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
  const { data: chunks, error: chunkError } = await db.from("study_chunks").select("id,studied_at").eq("user_id", device.user_id).eq("learning_language", language).order("updated_at", { ascending: false }).limit(100);
  if (chunkError) throw chunkError;
  if (!chunks?.length) return "empty";
  const { data: words, error: wordsError } = await db.from("study_chunk_words").select("word,reading,meaning,level,example_sentence_jp,chunk_id").in("chunk_id", chunks.map(c => c.id));
  if (wordsError) throw wordsError;
  const { data: states, error: stateError } = await db.from("user_word_state").select("word,state,preference,last_reviewed_at").eq("user_id", device.user_id).eq("learning_language", language);
  if (stateError) throw stateError;
  const stateMap = new Map((states ?? []).map(s => [s.word, s]));
  const studied = new Set(chunks.filter(c => c.studied_at).map(c => c.id));
  const candidates = [...new Map((words ?? []).filter(w => w.meaning && eligibleWord(stateMap.get(w.word), studied.has(w.chunk_id))).map(w => [w.word, w])).values()];
  if (!candidates.length) return "empty";
  const { data: recent } = await db.from("flashcard_push_deliveries").select("word").eq("user_id", device.user_id).eq("learning_language", language).order("created_at", { ascending: false }).limit(50);
  const recentWords = new Set((recent ?? []).map(d => d.word));
  const fresh = candidates.filter(w => !recentWords.has(w.word));
  const pool = fresh.length ? fresh : candidates;
  const card = pool[Math.floor(Math.random() * pool.length)];
  const projectKey = Deno.env.get("LOVABLE_API_KEY");
  const connectionKey = Deno.env.get("FIREBASE_MESSAGING_API_KEY");
  if (!projectKey || !connectionKey) throw new Error("Firebase is not configured");
  const { data: delivery, error: insertError } = await db.from("flashcard_push_deliveries").insert({ user_id: device.user_id, device_id: device.id, slot, learning_language: language, word: card.word, reading: card.reading, meaning: card.meaning, example_sentence: card.example_sentence_jp, level: card.level }).select("id").single();
  if (insertError?.code === "P0001") return "unhandled";
  if (insertError?.code === "23505") return "duplicate";
  if (insertError || !delivery) throw insertError ?? new Error("Delivery was not created");
  const path = `/notifications/review/${delivery.id}`;
  let response: Response;
  try {
  response = await fetch("https://connector-gateway.lovable.dev/firebase_messaging/v1/projects/_/messages:send", {
    method: "POST", headers: { Authorization: `Bearer ${projectKey}`, "X-Connection-Api-Key": connectionKey, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { token: device.token, notification: { title: `Tatani · ${card.word}`, body: profile.ui_language === "ja" ? "意味を思い出せますか？" : "Can you remember the meaning?" }, data: { path }, webpush: { headers: { TTL: "3600" }, notification: { icon: "/icon-192.png", tag: delivery.id }, fcm_options: { link: `https://tatani.lovable.app${path}` } } } }),
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
      const { data: card, error } = await db.from("flashcard_push_deliveries").select("id,word,reading,meaning,example_sentence,learning_language,reviewed_at").eq("id", input.delivery_id).eq("user_id", uid).maybeSingle();
      if (error) throw error;
      if (!card) return reply({ error: "Not found" }, 404);
      if (input.action === "card") return reply({ card });
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
  } catch (error) { return reply({ error: error instanceof Error ? error.message : "Request failed" }, 500); }
});