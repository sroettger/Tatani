import "@testing-library/jest-dom";
import { vi } from "vitest";
import { supabaseMock } from "./utils/supabaseMock";
import { currentAuth } from "./utils/authState";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});

window.scrollTo = () => {};
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = () => {};
}

// Never talk to a real backend in tests.
vi.mock("@/integrations/supabase/client", () => ({ supabase: supabaseMock }));

// Auth is driven by `setAuthState()` from src/test/utils/authState.
vi.mock("@/context/AuthContext", async () => {
  const React = await import("react");
  return {
    AuthProvider: ({ children }: { children: React.ReactNode }) => children,
    useAuth: () => currentAuth(),
  };
});
