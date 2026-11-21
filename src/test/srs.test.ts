import { describe, expect, it } from "vitest";
import {
  computeNextSrsState,
  computePriorKnownState,
  extractKanjiCharacters,
  isDueForSprint,
  isGraduatedForSrs,
  isUnlearnedCandidate,
  pickContextualSentence,
  splitSentenceWithHighlight,
} from "@/lib/srs";

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
