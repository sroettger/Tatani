import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders, resetTestState } from "./utils/render";
import Sprint from "@/pages/Sprint";

beforeEach(() => {
  resetTestState();
  localStorage.clear();
});

describe("Sprint distraction-free boot mode", () => {
  it("boots instantly from local cache, reveals context + reading in one tap, grades optimistically, and supports Undo and Library switch", () => {
    localStorage.setItem(
      "tatani-srs-deck-v1:test-user:ja",
      JSON.stringify({
        updatedAt: Date.now(),
        cards: {
          "探知": {
            word: "探知",
            reading: "たんち",
            meaning: "detection",
            part_of_speech: "noun",
            level: "N2",
            frequency: 3,
            state: "known",
            preference: "study",
            known_source: "learned",
            correct_streak: 1,
            srs_level: 1,
            srs_due_at: "2020-01-01T00:00:00.000Z",
            last_reviewed_at: "2020-01-01T00:00:00.000Z",
            contexts: [
              {
                jp: "魔力を探知する。",
                en: "Detect mana.",
                animeTitle: "Frieren",
                episodeNumber: 2,
              },
            ],
          },
        },
        nextEpisode: null,
        outbox: {},
      }),
    );

    renderWithProviders(<Sprint />, {
      route: "/",
      routes: [{ path: "/library", element: <div>anime library view</div> }],
    });

    // Prompt displays kanji word and episode context immediately without reading/meaning, plus 1-tap Peek Reading
    expect(screen.getByText("1 due")).toBeInTheDocument();
    expect(screen.getAllByText("探知").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("たんち")).not.toBeInTheDocument();
    expect(screen.queryByText("detection")).not.toBeInTheDocument();

    // 1-tap Peek Reading reveals kana reading without revealing the English meaning!
    fireEvent.click(screen.getByRole("button", { name: /Peek reading/i }));
    expect(screen.getByText("たんち")).toBeInTheDocument();
    expect(screen.queryByText("detection")).not.toBeInTheDocument();

    // Instant 1-tap reveal shows English meaning + context translation
    fireEvent.click(screen.getByRole("button", { name: /Tap or press Space to reveal/i }));
    expect(screen.getByText("たんち")).toBeInTheDocument();
    expect(screen.getByText("detection")).toBeInTheDocument();
    expect(screen.getByText("Detect mana.")).toBeInTheDocument();

    // Instant optimistic Know grade transitions to Caught Up
    fireEvent.click(screen.getByRole("button", { name: /Know/i }));
    expect(screen.getByRole("heading", { name: "All caught up" })).toBeInTheDocument();

    // Undo restores the card immediately in Kanji-first state (peek reset)
    fireEvent.click(screen.getByTitle("Undo"));
    expect(screen.getByText("1 due")).toBeInTheDocument();
    expect(screen.queryByText("たんち")).not.toBeInTheDocument();

    // Grading Again lapses the card and immediately re-scaffolds reading upfront on re-drill!
    fireEvent.click(screen.getByRole("button", { name: /Tap or press Space to reveal/i }));
    fireEvent.click(screen.getByRole("button", { name: /Again/i }));
    expect(screen.getByText("たんち")).toBeInTheDocument();
    expect(screen.queryByText("detection")).not.toBeInTheDocument();

    // Switch to Anime Library works in one tap
    fireEvent.click(screen.getByRole("button", { name: /Library/i }));
    expect(screen.getByText("anime library view")).toBeInTheDocument();
  });
});
