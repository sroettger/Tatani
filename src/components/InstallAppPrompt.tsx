import { useEffect, useMemo, useState } from "react";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

const DISMISS_KEY = "tatani-install-dismissed";

export function InstallAppPrompt() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === "1");

  const canShowFallback = useMemo(() => {
    const ua = navigator.userAgent;
    const isAndroidChrome = /Android/i.test(ua) && /Chrome/i.test(ua) && !/EdgA|OPR|SamsungBrowser/i.test(ua);
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone;
    return isAndroidChrome && !isStandalone;
  }, []);

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
      setDismissed(false);
      localStorage.removeItem(DISMISS_KEY);
    };

    const onInstalled = () => {
      setInstallEvent(null);
      setDismissed(true);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (dismissed || (!installEvent && !canShowFallback)) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  };

  const install = async () => {
    if (!installEvent) {
      toast("Install Tatani", {
        description: "Open tatani.lovable.app in Chrome, refresh once, then tap ⋮ → Install app.",
      });
      return;
    }

    await installEvent.prompt();
    const choice = await installEvent.userChoice;
    setInstallEvent(null);
    if (choice.outcome === "accepted") dismiss();
  };

  return (
    <div className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-sm items-center gap-2 rounded-lg border border-border bg-card/95 p-2 shadow-card backdrop-blur">
      <Button onClick={install} className="h-10 flex-1 gradient-primary text-primary-foreground">
        <Download className="h-4 w-4" /> Install Tatani
      </Button>
      <Button type="button" variant="ghost" size="icon" onClick={dismiss} aria-label="Hide install prompt" className="h-10 w-10">
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}