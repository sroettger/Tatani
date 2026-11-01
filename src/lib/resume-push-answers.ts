// Wake only an existing messaging worker; do not register offline/app-shell workers.
export function resumePushAnswers() {
  if (!("serviceWorker" in navigator)) return;
  const resume = () => {
    if (!navigator.onLine) return;
    void navigator.serviceWorker.getRegistrations().then(registrations => {
      for (const registration of registrations) {
        const worker = registration.active;
        if (worker && new URL(worker.scriptURL).pathname === "/firebase-messaging-sw.js") {
          worker.postMessage({ type: "FLUSH_PUSH_ANSWERS" });
        }
      }
    }).catch(() => {});
  };
  window.addEventListener("online", resume);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) resume(); });
  resume();
}