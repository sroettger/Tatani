import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { resumePushAnswers } from "./lib/resume-push-answers";
import { resumeForegroundPush } from "./lib/flashcard-push";
import { initNativeAndroid, isNativePlatform } from "./lib/capacitor";

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
void initNativeAndroid();
resumePushAnswers();
void resumeForegroundPush().catch(() => {});

// PWA service worker — only in production web, never inside Capacitor or editor iframe / preview hosts
if ("serviceWorker" in navigator && !isNativePlatform()) {
  const inIframe = (() => { try { return window.self !== window.top; } catch { return true; } })();
  const host = window.location.hostname;
  const isPreview = host.includes("lovableproject.com") || host.includes("id-preview--");
  if (!inIframe && !isPreview && import.meta.env.PROD) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  } else {
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => {
      const worker = r.active ?? r.waiting ?? r.installing;
      if (worker && new URL(worker.scriptURL).pathname === "/sw.js") r.unregister();
    }));
  }
}
