import { describe, it, expect } from "vitest";
import {
  LEARNING_LANGUAGES,
  DEFAULT_LEARNING_LANGUAGE,
  JLPT_LEVELS,
  CEFR_LEVELS,
  getLearningLanguage,
  isLearningLang,
  levelsFor,
  levelRank,
  levelFromRank,
  scaleLabel,
  formatLevel,
} from "@/lib/languages";
import { PLACEMENT_BANK } from "@/lib/placementBank";
import { SUPPORTED_LANGUAGES } from "@/i18n/strings";

describe("learning languages metadata", () => {
  it("every language has complete metadata", () => {
    for (const l of LEARNING_LANGUAGES) {
      expect(l.name, `${l.code} name`).toBeTruthy();
      expect(l.native, `${l.code} native`).toBeTruthy();
      expect(l.flag, `${l.code} flag`).toBeTruthy();
      expect(["jlpt", "cefr"]).toContain(l.scale);
      expect(typeof l.hasRuby).toBe("boolean");
    }
  });

  it("language codes are unique and include the default", () => {
    const codes = LEARNING_LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain(DEFAULT_LEARNING_LANGUAGE);
  });

  it("only Japanese uses ruby and the JLPT scale", () => {
    for (const l of LEARNING_LANGUAGES) {
      expect(l.hasRuby, `${l.code} hasRuby`).toBe(l.code === "ja");
      expect(l.scale, `${l.code} scale`).toBe(l.code === "ja" ? "jlpt" : "cefr");
    }
  });

  it("has placement words for every language and every level", () => {
    for (const l of LEARNING_LANGUAGES) {
      const bank = PLACEMENT_BANK[l.code];
      expect(bank, `no placement bank for ${l.code}`).toBeTruthy();
      for (const level of levelsFor(l.code)) {
        expect(bank[level]?.length ?? 0, `${l.code}/${level} has too few words`).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it("placement words carry a meaning in every UI language", () => {
    for (const l of LEARNING_LANGUAGES) {
      for (const [level, words] of Object.entries(PLACEMENT_BANK[l.code])) {
        for (const word of words) {
          for (const ui of SUPPORTED_LANGUAGES) {
            expect(
              (word.m as Record<string, string>)[ui.code],
              `${l.code}/${level}/${word.word} missing ${ui.code} meaning`,
            ).toBeTruthy();
          }
        }
      }
    }
  });
});

describe("level helpers", () => {
  it("returns the right scale per language", () => {
    expect(levelsFor("ja")).toEqual(JLPT_LEVELS);
    expect(levelsFor("de")).toEqual(CEFR_LEVELS);
    expect(scaleLabel("ja")).toBe("JLPT");
    expect(scaleLabel("de")).toBe("CEFR");
  });

  it("ranks levels easiest first", () => {
    expect(levelRank("ja", "N5")).toBe(1);
    expect(levelRank("ja", "N1")).toBe(5);
    expect(levelRank("de", "A1")).toBe(1);
    expect(levelRank("de", "C2")).toBe(6);
    expect(levelRank("ja", "none")).toBe(0);
    expect(levelRank("ja", null)).toBe(0);
    // a CEFR level is meaningless on the JLPT scale
    expect(levelRank("ja", "B1")).toBe(0);
  });

  it("round-trips rank <-> level and clamps out-of-range ranks", () => {
    for (const l of LEARNING_LANGUAGES) {
      for (const level of levelsFor(l.code)) {
        expect(levelFromRank(l.code, levelRank(l.code, level))).toBe(level);
      }
      expect(levelFromRank(l.code, 0)).toBe(levelsFor(l.code)[0]);
      expect(levelFromRank(l.code, 99)).toBe(levelsFor(l.code).at(-1));
    }
  });

  it("falls back to the default language for unknown codes", () => {
    expect(getLearningLanguage("klingon").code).toBe(DEFAULT_LEARNING_LANGUAGE);
    expect(isLearningLang("de")).toBe(true);
    expect(isLearningLang("klingon")).toBe(false);
  });

  it("formats unset levels as an em dash", () => {
    expect(formatLevel(null)).toBe("—");
    expect(formatLevel("none")).toBe("—");
    expect(formatLevel("B2")).toBe("B2");
  });
});
