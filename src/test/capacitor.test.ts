import { describe, it, expect, vi, beforeEach } from "vitest";

const isNativeMock = vi.fn(() => false);
const setOverlaysMock = vi.fn().mockResolvedValue(undefined);
const setStyleMock = vi.fn().mockResolvedValue(undefined);
const setBgMock = vi.fn().mockResolvedValue(undefined);
const exitAppMock = vi.fn().mockResolvedValue(undefined);
let backHandler: ((ev: { canGoBack: boolean }) => void) | undefined;

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => isNativeMock(),
  },
}));

vi.mock("@capacitor/status-bar", () => ({
  StatusBar: {
    setOverlaysWebView: (...args: unknown[]) => setOverlaysMock(...args),
    setStyle: (...args: unknown[]) => setStyleMock(...args),
    setBackgroundColor: (...args: unknown[]) => setBgMock(...args),
  },
  Style: { Dark: "DARK" },
}));

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn((event: string, cb: (ev: { canGoBack: boolean }) => void) => {
      if (event === "backButton") backHandler = cb;
      return Promise.resolve({ remove: vi.fn() });
    }),
    exitApp: () => exitAppMock(),
  },
}));

import { initNativeAndroid, isNativePlatform } from "@/lib/capacitor";

describe("capacitor native android helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    backHandler = undefined;
    isNativeMock.mockReturnValue(false);
    window.history.replaceState({}, "", "/");
  });

  it("does nothing on web platforms", async () => {
    expect(isNativePlatform()).toBe(false);
    await initNativeAndroid();
    expect(setStyleMock).not.toHaveBeenCalled();
    expect(backHandler).toBeUndefined();
  });

  it("configures dark status bar and handles hardware back button on native Android", async () => {
    isNativeMock.mockReturnValue(true);
    const historyBack = vi.spyOn(window.history, "back").mockImplementation(() => {});

    await initNativeAndroid();

    expect(setOverlaysMock).toHaveBeenCalledWith({ overlay: false });
    expect(setStyleMock).toHaveBeenCalledWith({ style: "DARK" });
    expect(setBgMock).toHaveBeenCalledWith({ color: "#1a1424" });
    expect(backHandler).toBeDefined();

    // Navigates back on nested routes
    window.history.replaceState({}, "", "/episode/123");
    backHandler!({ canGoBack: true });
    expect(historyBack).toHaveBeenCalledTimes(1);
    expect(exitAppMock).not.toHaveBeenCalled();

    // Exits app on root route
    window.history.replaceState({}, "", "/");
    backHandler!({ canGoBack: true });
    expect(exitAppMock).toHaveBeenCalledTimes(1);

    historyBack.mockRestore();
  });
});
