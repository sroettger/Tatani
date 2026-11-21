import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { resumePushAnswers } from "./lib/resume-push-answers";
import { resumeForegroundPush } from "./lib/flashcard-push";

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
resumePushAnswers();
void resumeForegroundPush().catch(() => {});

// PWA service worker — only in production, never inside an iframe
if ("serviceWorker" in navigator) {
  const inIframe = (() => { try { return window.self !== window.top; } catch { return true; } })();
  const baseUrl = import.meta.env.BASE_URL || "/";
  const swPath = `${baseUrl}sw.js`;
  if (!inIframe && import.meta.env.PROD) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register(swPath).catch(() => {});
    });
  } else {
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => {
      const worker = r.active ?? r.waiting ?? r.installing;
      if (worker && new URL(worker.scriptURL).pathname.endsWith("/sw.js")) r.unregister();
    }));
  }
}
