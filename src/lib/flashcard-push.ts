import { initializeApp, getApps } from "firebase/app";
import { getMessaging, getToken, isSupported, onMessage } from "firebase/messaging";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export type DeviceSchedule = { id: string; enabled: boolean; timezone: string; start_hour: number; end_hour: number; cards_per_hour: number };
let stopForegroundMessages: (() => void) | undefined;

// Firebase sends pushes to visible windows instead of onBackgroundMessage.
// Forward them to the same worker so quizzes and answer handling stay identical.
export async function resumeForegroundPush() {
  if (!("serviceWorker" in navigator) || !(await isSupported())) return;
  const registrations = await navigator.serviceWorker.getRegistrations();
  const registration = registrations.find(r => {
    const worker = r.active;
    return worker && new URL(worker.scriptURL).pathname.endsWith("/firebase-messaging-sw.js");
  });
  const worker = registration?.active;
  if (!worker) return;
  const config = Object.fromEntries(new URL(worker.scriptURL).searchParams);
  const app = getApps().find(app => app.name === "tatani-push") ?? initializeApp(config, "tatani-push");
  stopForegroundMessages?.();
  stopForegroundMessages = onMessage(getMessaging(app), payload => {
    if (payload.data?.delivery_id) worker.postMessage({ type: "SHOW_PUSH_QUIZ", data: payload.data });
  });
}

export async function notificationRequest<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("flashcard-notifications", { body });
  if (error) {
    const details = error instanceof FunctionsHttpError ? await error.context.text() : error.message;
    throw new Error(details);
  }
  return data as T;
}

export async function enableFlashcardPush(): Promise<{ status: "registered"; token: string } | { status: "not-configured" | "unsupported" | "open-in-new-tab" | "denied" }> {
  if (window.top !== window.self) return { status: "open-in-new-tab" };
  const appId = import.meta.env.VITE_FIREBASE_APP_ID;
  const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;
  const config = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    appId,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || appId?.split(":")[1] || "",
  };
  if (!config.apiKey || !config.projectId || !appId || !vapidKey || !config.messagingSenderId) return { status: "not-configured" };
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return { status: "unsupported" };
  // Ask before awaiting support detection so the click's user gesture is retained.
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") return { status: "denied" };
  if (!(await isSupported())) return { status: "unsupported" };
  const baseUrl = import.meta.env.BASE_URL || "/";
  const registration = await navigator.serviceWorker.register(`${baseUrl}firebase-messaging-sw.js?${new URLSearchParams(config)}`, { scope: `${baseUrl}push/`, updateViaCache: "none" });
  if (!registration.active) {
    await new Promise<void>((resolve, reject) => {
      const worker = registration.installing ?? registration.waiting;
      if (!worker) { reject(new Error("Notification worker is unavailable")); return; }
      const timeout = window.setTimeout(() => reject(new Error("Notification worker activation timed out")), 20000);
      const check = () => {
        if (worker.state === "activated") { window.clearTimeout(timeout); resolve(); }
        else if (worker.state === "redundant") { window.clearTimeout(timeout); reject(new Error("Notification worker could not activate")); }
      };
      worker.addEventListener("statechange", check);
      check();
    });
  }
  const existing = getApps().find(app => app.name === "tatani-push");
  const app = existing ?? initializeApp(config, "tatani-push");
  const token = await getToken(getMessaging(app), { vapidKey, serviceWorkerRegistration: registration });
  await resumeForegroundPush();
  return token ? { status: "registered", token } : { status: "denied" };
}