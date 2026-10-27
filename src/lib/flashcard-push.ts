import { initializeApp, getApps } from "firebase/app";
import { getMessaging, getToken, isSupported } from "firebase/messaging";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export type DeviceSchedule = { id: string; enabled: boolean; timezone: string; start_hour: number; end_hour: number; cards_per_day: number };
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
  const appId = import.meta.env.VITE_LOVABLE_CONNECTOR_FIREBASE_MESSAGING_APP_ID;
  const vapidKey = import.meta.env.VITE_LOVABLE_CONNECTOR_FIREBASE_MESSAGING_VAPID_KEY;
  const config = {
    apiKey: import.meta.env.VITE_LOVABLE_CONNECTOR_FIREBASE_MESSAGING_WEB_API_KEY,
    projectId: import.meta.env.VITE_LOVABLE_CONNECTOR_FIREBASE_MESSAGING_PROJECT_ID,
    appId, messagingSenderId: appId?.split(":")[1] ?? "",
  };
  if (!config.apiKey || !config.projectId || !appId || !vapidKey || !config.messagingSenderId) return { status: "not-configured" };
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return { status: "unsupported" };
  // Ask before awaiting support detection so the click's user gesture is retained.
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") return { status: "denied" };
  if (!(await isSupported())) return { status: "unsupported" };
  const registration = await navigator.serviceWorker.register(`/firebase-messaging-sw.js?${new URLSearchParams(config)}`, { scope: "/push/" });
  const existing = getApps().find(app => app.name === "tatani-push");
  const app = existing ?? initializeApp(config, "tatani-push");
  const token = await getToken(getMessaging(app), { vapidKey, serviceWorkerRegistration: registration });
  return token ? { status: "registered", token } : { status: "denied" };
}