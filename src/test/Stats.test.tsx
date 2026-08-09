import { describe, it, expect, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders, resetTestState, LANGUAGE_MATRIX } from "./utils/render";
import { setTableResult, filtersFor } from "./utils/supabaseMock";
import Stats from "@/pages/Stats";

beforeEach(resetTestState);

describe("Stats", () => {
  it("renders labels in the UI language", async () => {
    renderWithProviders(<Stats />, { uiLanguage: "ja", learningLanguage: "de" });
    await waitFor(() => expect(screen.getByText("統計")).toBeInTheDocument());
    expect(screen.queryByText("Stats")).not.toBeInTheDocument();
  });

  it("shows the scale label matching the learning language", async () => {
    renderWithProviders(<Stats />, { uiLanguage: "en", learningLanguage: "de" });
    await waitFor(() => expect(screen.getByText(/CEFR/)).toBeInTheDocument());
    expect(screen.queryByText(/JLPT/)).not.toBeInTheDocument();
  });

  it.each(LANGUAGE_MATRIX)(
    "scopes all counts to the active learning language ($learningLanguage)",
    async ({ uiLanguage, learningLanguage }) => {
      resetTestState();
      setTableResult("user_word_state", { data: [], count: 3 });
      setTableResult("study_sessions", { data: [], count: 7 });
      renderWithProviders(<Stats />, { uiLanguage, learningLanguage });

      await waitFor(() => expect(screen.getByText("7")).toBeInTheDocument());
      for (const table of ["user_word_state", "study_sessions"]) {
        const langFilters = filtersFor(table).filter(([k]) => k === "learning_language");
        expect(langFilters.length, `${table} not scoped`).toBeGreaterThan(0);
        for (const [, v] of langFilters) expect(v).toBe(learningLanguage);
      }
    },
  );

  it("shows an empty state when the active language has no data", async () => {
    setTableResult("user_word_state", { data: [], count: 0 });
    setTableResult("study_sessions", { data: [], count: 0 });
    renderWithProviders(<Stats />, {
      uiLanguage: "en",
      learningLanguage: "de",
      auth: { progress: { learning_language: "de", level: "none", placement_done: true, total_words_known: 0, study_streak: 0 } },
    });
    await waitFor(() => expect(screen.getAllByText("0").length).toBeGreaterThan(0));
    // level is unset for a fresh language
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
