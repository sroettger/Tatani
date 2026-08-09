import { describe, it, expect } from "vitest";
import { en, ja, DICTS, SUPPORTED_LANGUAGES } from "@/i18n/strings";

const keys = (o: Record<string, string>) => Object.keys(o).sort();

describe("i18n dictionaries", () => {
  it("en and ja have identical key sets", () => {
    const enKeys = keys(en as Record<string, string>);
    const jaKeys = keys(ja as Record<string, string>);
    const missingInJa = enKeys.filter((k) => !jaKeys.includes(k));
    const missingInEn = jaKeys.filter((k) => !enKeys.includes(k));
    expect({ missingInJa, missingInEn }).toEqual({ missingInJa: [], missingInEn: [] });
  });

  it("has a dictionary for every supported language", () => {
    for (const l of SUPPORTED_LANGUAGES) {
      expect(DICTS[l.code], `missing dictionary for ${l.code}`).toBeTruthy();
    }
  });

  it("has no empty values", () => {
    for (const [code, dict] of Object.entries(DICTS)) {
      for (const [key, value] of Object.entries(dict)) {
        expect(value.trim(), `${code}.${key} is empty`).not.toBe("");
      }
    }
  });

  it("uses the same interpolation variables in both locales", () => {
    const vars = (s: string) => (s.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort();
    for (const key of keys(en as Record<string, string>)) {
      const a = vars((en as Record<string, string>)[key]);
      const b = vars((ja as Record<string, string>)[key]);
      expect(b, `variable mismatch for "${key}"`).toEqual(a);
    }
  });
});
