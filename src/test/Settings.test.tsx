import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, resetTestState } from "./utils/render";
import { calls } from "./utils/supabaseMock";
import { setLearningLanguageMock } from "./utils/authState";
import { JLPT_LEVELS, CEFR_LEVELS } from "@/lib/languages";
import Settings from "@/pages/Settings";

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));

beforeEach(() => {
  resetTestState();
  toastSuccess.mockClear();
  toastError.mockClear();
});

describe("Settings", () => {
  it("shows JLPT levels when learning Japanese", () => {
    renderWithProviders(<Settings />, { uiLanguage: "en", learningLanguage: "ja" });
    for (const lvl of JLPT_LEVELS) expect(screen.getByRole("button", { name: lvl })).toBeInTheDocument();
    for (const lvl of CEFR_LEVELS) expect(screen.queryByRole("button", { name: lvl })).not.toBeInTheDocument();
    expect(screen.getByText("JLPT level")).toBeInTheDocument();
  });

  it("shows CEFR levels when learning German", () => {
    renderWithProviders(<Settings />, { uiLanguage: "en", learningLanguage: "de" });
    for (const lvl of CEFR_LEVELS) expect(screen.getByRole("button", { name: lvl })).toBeInTheDocument();
    for (const lvl of JLPT_LEVELS) expect(screen.queryByRole("button", { name: lvl })).not.toBeInTheDocument();
    expect(screen.getByText("CEFR level")).toBeInTheDocument();
  });

  it("renders the whole page in Japanese when the UI language is 日本語", () => {
    renderWithProviders(<Settings />, { uiLanguage: "ja", learningLanguage: "de" });
    expect(screen.getByText("設定")).toBeInTheDocument();
    expect(screen.getByText("CEFR レベル")).toBeInTheDocument();
    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
  });

  it("writes the level to the active language's progress row", async () => {
    renderWithProviders(<Settings />, { uiLanguage: "en", learningLanguage: "de" });
    await userEvent.click(screen.getByRole("button", { name: "B2" }));
    await waitFor(() => {
      const rec = calls.find((c) => c.table === "user_language_progress" && c.op === "update");
      expect(rec, "no progress update issued").toBeTruthy();
      expect(rec!.filters).toContainEqual(["learning_language", "de"]);
    });
  });

  it("switching the learning language goes through the auth context", async () => {
    renderWithProviders(<Settings />, { uiLanguage: "en", learningLanguage: "ja" });
    await userEvent.click(screen.getByRole("button", { name: /Deutsch/ }));
    await waitFor(() => expect(setLearningLanguageMock).toHaveBeenCalledWith("de"));
  });

  it("shows the language-updated toast in the language just picked", async () => {
    renderWithProviders(<Settings />, { uiLanguage: "en", learningLanguage: "ja" });
    await userEvent.click(screen.getByRole("button", { name: "日本語" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("言語を更新しました"));
  });
});
