import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders, resetTestState } from "./utils/render";
import { functionsInvoke, setTableResult } from "./utils/supabaseMock";
import Home from "@/pages/Home";

beforeEach(resetTestState);

describe("AddAnimeDialog + Home non-cancellable progress", () => {
  it("shows live progress when adding multi-episode anime and continues in Home if dialog is closed", async () => {
    let resolveAdd!: (val: { data: unknown; error: unknown }) => void;
    const addPromise = new Promise<{ data: unknown; error: unknown }>((res) => {
      resolveAdd = res;
    });

    let libraryRows: Array<Record<string, unknown>> = [];
    setTableResult("user_anime", () => ({ data: libraryRows, error: null }));
    setTableResult("episodes", { data: [], error: null });
    setTableResult("episode_vocab_cache", { data: [], error: null });

    functionsInvoke.mockImplementation(async (fnName?: string) => {
      if (fnName === "search-anime") {
        return {
          data: {
            results: [
              {
                anilist_id: 11061,
                mal_id: 11061,
                title_romaji: "Hunter x Hunter (2011)",
                title_en: "Hunter x Hunter",
                title_jp: "HUNTER×HUNTER",
                cover_url: null,
                year: 2011,
                episode_count: 148,
                synopsis: "Gon searches for his father.",
              },
            ],
          },
          error: null,
        };
      }
      if (fnName === "add-anime-to-library") {
        return addPromise;
      }
      return { data: null, error: null };
    });

    renderWithProviders(<Home />, { uiLanguage: "en", learningLanguage: "ja" });

    // Open Add Anime dialog
    const openButtons = await screen.findAllByRole("button", { name: /add anime|^add$/i });
    fireEvent.click(openButtons[0]);

    const searchInput = await screen.findByPlaceholderText(/search anime/i);
    fireEvent.change(searchInput, { target: { value: "Hunter" } });
    fireEvent.submit(searchInput.closest("form")!);

    const resultRow = await screen.findByText("Hunter x Hunter");
    fireEvent.click(resultRow.closest("button")!);

    // Dialog shows live progress banner + Adding… button immediately
    await waitFor(() => {
      expect(screen.getByText(/Adding "Hunter x Hunter" \(148 eps\)/i)).toBeInTheDocument();
      expect(screen.getByText("Adding…")).toBeInTheDocument();
    });

    // User closes the dialog mid-flight (Escape key on Radix Dialog)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", code: "Escape" });

    // Home view keeps showing live Adding card with 148 episodes while request continues
    await waitFor(() => {
      expect(screen.getByText(/Setting up 148 episodes in your library/i)).toBeInTheDocument();
    });

    // Resolve server add -> library reloads and progress card transitions to the added anime
    libraryRows = [
      {
        id: "ua-1",
        added_at: new Date().toISOString(),
        position: 0,
        anime: {
          id: "anime-hxh",
          title_romaji: "Hunter x Hunter (2011)",
          title_en: "Hunter x Hunter",
          title_jp: "HUNTER×HUNTER",
          cover_url: null,
          year: 2011,
          episode_count: 148,
        },
      },
    ];
    resolveAdd({ data: { anime_id: "anime-hxh", episode_count: 148 }, error: null });

    await waitFor(() => {
      expect(screen.queryByText(/Setting up 148 episodes in your library/i)).not.toBeInTheDocument();
      expect(screen.getByText(/0 \/ 148 eps ready/i)).toBeInTheDocument();
    });
  });
});
