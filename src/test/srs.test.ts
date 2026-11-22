import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  computeNextSrsState,
  computePriorKnownState,
  extractKanjiCharacters,
  isDueForSprint,
  isGraduatedForSrs,
  isUnlearnedCandidate,
  nextIntervalDaysForGrade,
  pickContextualSentence,
  splitSentenceWithHighlight,
} from "@/lib/srs";
import { srsDeckStorageKey, useSrsDeck } from "@/lib/srs-store";
import { resetSupabaseMock, setTableResult } from "./utils/supabaseMock";

beforeEach(() => {
  resetSupabaseMock();
  localStorage.clear();
});

describe("SRS Learn vs Repeat split and contextual helpers", () => {
  const now = Date.parse("2026-11-20T12:00:00Z");

  it("graduates a newly encoded word at SRS level 0 (+1 day) without skipping to level 1", () => {
    const next = computeNextSrsState(
      undefined,
      { word: "探知", reading: "たんち", level: "N2" },
      true,
      now,
    );
    expect(next.state).toBe("known");
    expect(next.known_source).toBe("learned");
    expect(next.srs_level).toBe(0);
    expect(next.srs_due_at).toBe("2026-11-21T12:00:00.000Z");
    expect(isGraduatedForSrs(next)).toBe(true);
  });

  it("advances already-graduated words along Leitner intervals and resets on lapse", () => {
    const grad = computeNextSrsState(
      { srs_level: 0, srs_due_at: "2026-11-20T00:00:00Z", correct_streak: 1 },
      { word: "魔法", reading: "まほう", level: "N4" },
      true,
      now,
    );
    expect(grad.srs_level).toBe(1);
    expect(grad.srs_due_at).toBe("2026-11-23T12:00:00.000Z");

    const lapsed = computeNextSrsState(
      grad,
      { word: "魔法", reading: "まほう", level: "N4" },
      false,
      now,
    );
    expect(lapsed.state).toBe("learning");
    expect(lapsed.srs_level).toBe(0);
    expect(lapsed.correct_streak).toBe(0);
    expect(lapsed.srs_due_at).toBe("2026-11-21T12:00:00.000Z");
  });

  it("recovers from an intraday lapse at level 0 (+1d) instead of jumping to level 1 (+3d)", () => {
    const lapsed = computeNextSrsState(
      { state: "known", srs_level: 3, srs_due_at: "2026-11-20T00:00:00Z", correct_streak: 4 },
      { word: "魔法", reading: "まほう", level: "N4" },
      false,
      now,
    );
    expect(lapsed.state).toBe("learning");
    expect(lapsed.srs_level).toBe(0);

    const laterIntraday = now + 5 * 60 * 1000;
    expect(nextIntervalDaysForGrade(lapsed, true, laterIntraday)).toBe(1);

    const recovered = computeNextSrsState(
      lapsed,
      { word: "魔法", reading: "まほう", level: "N4" },
      true,
      laterIntraday,
    );
    expect(recovered.state).toBe("known");
    expect(recovered.srs_level).toBe(0);
    expect(recovered.srs_due_at).toBe(new Date(laterIntraday + 24 * 60 * 60 * 1000).toISOString());
  });

  it("preserves srs_level during early Cram / Practice Ahead reviews without inflating intervals", () => {
    const notYetDue = {
      state: "known" as const,
      srs_level: 2, // 7-day interval
      srs_due_at: "2026-11-25T12:00:00.000Z", // 5 days in the future relative to `now`
      correct_streak: 3,
    };

    expect(nextIntervalDaysForGrade(notYetDue, true, now)).toBe(7);

    const earlyReviewed = computeNextSrsState(
      notYetDue,
      { word: "結界", reading: "けっかい", level: "N2" },
      true,
      now,
    );
    expect(earlyReviewed.srs_level).toBe(2);
    expect(earlyReviewed.srs_due_at).toBe("2026-11-27T12:00:00.000Z");
  });

  it("preserves cached localStorage deck when refreshFromServer fails or runs offline", async () => {
    const storageKey = srsDeckStorageKey("offline-user", "ja");
    const cachedSnapshot = {
      updatedAt: now,
      cards: {
        "探知": {
          word: "探知",
          reading: "たんち",
          meaning: "detection",
          part_of_speech: "noun",
          level: "N2",
          frequency: 4,
          state: "known" as const,
          preference: "study" as const,
          known_source: "learned" as const,
          correct_streak: 2,
          srs_level: 1,
          srs_due_at: "2026-11-19T00:00:00.000Z",
          last_reviewed_at: "2026-11-16T00:00:00.000Z",
          contexts: [{ jp: "魔力を探知する。", en: "Detect mana." }],
        },
      },
      nextEpisode: null,
      outbox: {},
    };
    localStorage.setItem(storageKey, JSON.stringify(cachedSnapshot));

    // Simulate server query failure during refreshFromServer
    setTableResult("user_word_state", { data: null, error: new Error("Failed to fetch") });

    const { result } = renderHook(() => useSrsDeck("offline-user", "ja", "N5"));

    await act(async () => {
      await result.current.refreshFromServer();
    });

    expect(Object.keys(result.current.cards)).toEqual(["探知"]);
    expect(result.current.cards["探知"].meaning).toBe("detection");

    const persistedAfterError = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    expect(Object.keys(persistedAfterError.cards ?? {})).toEqual(["探知"]);
  });

  it("excludes prior-known and ungraduated words from Sprint while routing ungraduated words to Learn", () => {
    const prior = computePriorKnownState(undefined, { word: "私", reading: "わたし", level: "N5" }, now);
    expect(isGraduatedForSrs(prior)).toBe(false);
    expect(isDueForSprint(prior, now)).toBe(false);
    expect(isUnlearnedCandidate(prior, false)).toBe(false);

    const untouchedUnknown = { state: "unknown" as const, preference: "study" as const, known_source: null, srs_due_at: null };
    expect(isDueForSprint(untouchedUnknown, now)).toBe(false);
    expect(isUnlearnedCandidate(untouchedUnknown, false)).toBe(true);
  });

  it("rotates across multiple episode contexts for contextual diversity", () => {
    const contexts = [
      { jp: "魔力を探知する。", en: "Detect mana.", animeTitle: "Frieren", episodeNumber: 1 },
      { jp: "敵の気配を探知した。", en: "Detected the enemy presence.", animeTitle: "Frieren", episodeNumber: 4 },
    ];
    expect(pickContextualSentence(contexts, 0)?.episodeNumber).toBe(1);
    expect(pickContextualSentence(contexts, 1)?.episodeNumber).toBe(4);
    expect(pickContextualSentence(contexts, 2)?.episodeNumber).toBe(1);
  });

  it("highlights exact and conjugated kanji words inside sentences and extracts kanji components", () => {
    const exact = splitSentenceWithHighlight("そんな魔法は見たことがない", "魔法");
    expect(exact).toEqual([
      { text: "そんな", highlighted: false },
      { text: "魔法", highlighted: true },
      { text: "は見たことがない", highlighted: false },
    ]);

    const conjugated = splitSentenceWithHighlight("早く食べよう", "食べる");
    expect(conjugated.some((s) => s.highlighted && s.text.startsWith("食"))).toBe(true);

    expect(extractKanjiCharacters("探知する")).toEqual(["探", "知"]);
  });
});
