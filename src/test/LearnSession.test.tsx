import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders, resetTestState } from "./utils/render";
import LearnSession from "@/pages/LearnSession";

beforeEach(() => {
  resetTestState();
  localStorage.clear();
});

describe("LearnSession Speed Blitz 'I don't know' button", () => {
  it("shows an 'I don't know' button in the initial quiz that highlights the correct meaning without red error penalty and re-queues the word", () => {
    const sampleWords = [
      {
        word: "冒険",
        reading: "ぼうけん",
        meaning: "adventure",
        part_of_speech: "noun",
        level: "N3",
        frequency: 5,
        state: "unknown" as const,
        preference: "study" as const,
        known_source: null,
        correct_streak: 0,
        srs_level: 0,
        srs_due_at: null,
        last_reviewed_at: null,
        contexts: [
          {
            jp: "新しい冒険が始まる。",
            en: "A new adventure begins.",
            animeTitle: "Frieren",
            episodeNumber: 1,
            episodeId: "ep-1",
          },
        ],
      },
      {
        word: "魔法",
        reading: "まほう",
        meaning: "magic",
        part_of_speech: "noun",
        level: "N4",
        frequency: 4,
        state: "unknown" as const,
        preference: "study" as const,
        known_source: null,
        correct_streak: 0,
        srs_level: 0,
        srs_due_at: null,
        last_reviewed_at: null,
        contexts: [
          {
            jp: "魔法を使う。",
            en: "Use magic.",
            animeTitle: "Frieren",
            episodeNumber: 1,
            episodeId: "ep-1",
          },
        ],
      },
      {
        word: "約束",
        reading: "やくそく",
        meaning: "promise",
        part_of_speech: "noun",
        level: "N4",
        frequency: 3,
        state: "unknown" as const,
        preference: "study" as const,
        known_source: null,
        correct_streak: 0,
        srs_level: 0,
        srs_due_at: null,
        last_reviewed_at: null,
        contexts: [],
      },
      {
        word: "仲間",
        reading: "なかま",
        meaning: "companion",
        part_of_speech: "noun",
        level: "N3",
        frequency: 2,
        state: "unknown" as const,
        preference: "study" as const,
        known_source: null,
        correct_streak: 0,
        srs_level: 0,
        srs_due_at: null,
        last_reviewed_at: null,
        contexts: [],
      },
    ];

    const cardsMap = Object.fromEntries(sampleWords.map((w) => [w.word, w]));
    localStorage.setItem(
      "tatani-srs-deck-v1:test-user:ja",
      JSON.stringify({
        updatedAt: Date.now(),
        cards: cardsMap,
        nextEpisode: {
          episodeId: "ep-1",
          animeTitle: "Frieren",
          episodeNumber: 1,
          words: sampleWords,
        },
        outbox: {},
      }),
    );

    renderWithProviders(<LearnSession />, {
      route: "/learn",
      uiLanguage: "en",
      learningLanguage: "ja",
    });

    // Step through Contextual Encoding for the 4 words into the initial Speed Blitz quiz
    for (let i = 0; i < 4; i++) {
      fireEvent.click(document.getElementById("learn-got-it")!);
    }

    // In Speed Blitz (1/2) for "冒険": "I don't know" button is present; English translation is hidden
    expect(screen.getByText(/Speed Blitz/i)).toBeInTheDocument();
    expect(screen.queryByText("A new adventure begins.")).not.toBeInTheDocument();
    const dontKnowBtn = screen.getByRole("button", { name: "I don't know" });
    expect(dontKnowBtn).toBeInTheDocument();

    // Tap "I don't know" -> highlights "adventure" in green, no choice highlighted in red, reveals English sentence
    fireEvent.click(dontKnowBtn);

    expect(screen.getByText("A new adventure begins.")).toBeInTheDocument();
    const correctOption = screen.getByText("adventure").closest("button")!;
    expect(correctOption.className).toContain("border-success");
    expect(document.querySelectorAll(".border-destructive").length).toBe(0);

    // Tap "Got it — Re-queue" -> advances to next word ("魔法") and keeps "冒険" in the drill queue
    const requeueBtn = screen.getByRole("button", { name: /Got it — Re-queue/i });
    fireEvent.click(requeueBtn);

    expect(screen.getAllByText("魔法").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: "I don't know" })).toBeInTheDocument();
  });
});
