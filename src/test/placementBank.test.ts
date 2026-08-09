import { describe, it, expect } from "vitest";
import { buildPlacementQuiz, PLACEMENT_BANK } from "@/lib/placementBank";
import { LEARNING_LANGUAGES, levelsFor } from "@/lib/languages";
import { SUPPORTED_LANGUAGES } from "@/i18n/strings";

const MATRIX = LEARNING_LANGUAGES.flatMap((l) =>
  SUPPORTED_LANGUAGES.map((ui) => ({ learning: l.code, ui: ui.code })),
);

describe("buildPlacementQuiz", () => {
  for (const { learning, ui } of MATRIX) {
    describe(`${ui} UI learning ${learning}`, () => {
      it("covers every level of the language's scale", () => {
        const qs = buildPlacementQuiz(learning, ui, 2);
        const levels = [...new Set(qs.map((q) => q.level))];
        expect(levels.sort()).toEqual([...levelsFor(learning)].sort());
      });

      it("asks perLevel questions per level", () => {
        const qs = buildPlacementQuiz(learning, ui, 3);
        for (const level of levelsFor(learning)) {
          expect(qs.filter((q) => q.level === level)).toHaveLength(3);
        }
      });

      it("produces four distinct choices with a valid correct index", () => {
        const qs = buildPlacementQuiz(learning, ui, 4);
        for (const q of qs) {
          expect(q.choices).toHaveLength(4);
          expect(new Set(q.choices).size).toBe(4);
          expect(q.correct_index).toBeGreaterThanOrEqual(0);
          expect(q.correct_index).toBeLessThan(4);
        }
      });

      it("uses the target word in the prompt and answers in the UI language", () => {
        const qs = buildPlacementQuiz(learning, ui, 4);
        for (const q of qs) {
          expect(q.prompt).toContain(q.word);
          const entry = PLACEMENT_BANK[learning][q.level].find((e) => e.word === q.word)!;
          expect(entry).toBeTruthy();
          expect(q.choices[q.correct_index]).toBe(entry.m[ui as "en" | "ja"]);
        }
      });

      it("only draws words from this language's bank", () => {
        const own = new Set(Object.values(PLACEMENT_BANK[learning]).flat().map((e) => e.word));
        for (const q of buildPlacementQuiz(learning, ui, 4)) {
          expect(own.has(q.word), `${q.word} is not a ${learning} word`).toBe(true);
        }
      });
    });
  }

  it("falls back to English meanings for an unknown UI language", () => {
    const qs = buildPlacementQuiz("de", "xx", 1);
    const all = Object.values(PLACEMENT_BANK.de).flat();
    for (const q of qs) {
      const entry = all.find((e) => e.word === q.word)!;
      expect(q.choices[q.correct_index]).toBe(entry.m.en);
    }
  });

  it("never repeats the same word within a level", () => {
    for (const l of LEARNING_LANGUAGES) {
      const qs = buildPlacementQuiz(l.code, "en", 4);
      for (const level of levelsFor(l.code)) {
        const words = qs.filter((q) => q.level === level).map((q) => q.word);
        expect(new Set(words).size).toBe(words.length);
      }
    }
  });
});
