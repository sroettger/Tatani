import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { StatusBar, Style } from "@capacitor/status-bar";

export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

const ROOT_PATHS = new Set(["/", "/auth", "/onboarding"]);

export async function initNativeAndroid(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  try {
    await StatusBar.setOverlaysWebView({ overlay: false });
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: "#1a1424" });
  } catch {
    // Ignore on platforms where StatusBar APIs are unavailable.
  }

  try {
    await App.addListener("backButton", ({ canGoBack }) => {
      if (canGoBack && !ROOT_PATHS.has(window.location.pathname)) {
        window.history.back();
      } else {
        void App.exitApp();
      }
    });
  } catch {
    // Ignore if App plugin is unavailable.
  }
}
