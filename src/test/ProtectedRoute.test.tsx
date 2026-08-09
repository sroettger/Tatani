import { describe, it, expect, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders, resetTestState } from "./utils/render";
import { ProtectedRoute } from "@/components/ProtectedRoute";

beforeEach(resetTestState);

const Guarded = () => <div>protected content</div>;
const routes = [
  { path: "/auth", element: <div>auth page</div> },
  { path: "/onboarding", element: <div>onboarding page</div> },
];

describe("ProtectedRoute", () => {
  it("renders children when placement is done for the active language", () => {
    renderWithProviders(
      <ProtectedRoute>
        <Guarded />
      </ProtectedRoute>,
      { learningLanguage: "de", auth: { progress: { learning_language: "de", level: "B1", placement_done: true, total_words_known: 0, study_streak: 0 } }, routes },
    );
    expect(screen.getByText("protected content")).toBeInTheDocument();
  });

  it("sends the user to onboarding when the active language has no placement yet", () => {
    renderWithProviders(
      <ProtectedRoute>
        <Guarded />
      </ProtectedRoute>,
      { learningLanguage: "de", auth: { progress: { learning_language: "de", level: "none", placement_done: false, total_words_known: 0, study_streak: 0 } }, routes },
    );
    expect(screen.getByText("onboarding page")).toBeInTheDocument();
  });

  it("uses per-language progress, not the legacy profile flag", () => {
    // Legacy profile says placement is done (Japanese), but the active German
    // progress row says it is not — the user must be sent to onboarding.
    renderWithProviders(
      <ProtectedRoute>
        <Guarded />
      </ProtectedRoute>,
      {
        learningLanguage: "de",
        auth: {
          profile: { user_id: "test-user", ui_language: "en", learning_language: "de", placement_done: true },
          progress: { learning_language: "de", level: "none", placement_done: false, total_words_known: 0, study_streak: 0 },
        },
        routes,
      },
    );
    expect(screen.getByText("onboarding page")).toBeInTheDocument();
  });

  it("redirects to auth when signed out", () => {
    renderWithProviders(
      <ProtectedRoute>
        <Guarded />
      </ProtectedRoute>,
      { auth: { user: null, progress: null }, routes },
    );
    expect(screen.getByText("auth page")).toBeInTheDocument();
  });

  it("does not redirect while auth is still loading", () => {
    renderWithProviders(
      <ProtectedRoute>
        <Guarded />
      </ProtectedRoute>,
      { auth: { loading: true, user: null, progress: null }, routes },
    );
    expect(screen.queryByText("auth page")).not.toBeInTheDocument();
  });
});
