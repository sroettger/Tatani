import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { providersFor } from "./providers.ts";
import { scoreFilename, normalizeToCueText, decodeSubtitleBytes, extractSubtitleText } from "../_shared/subtitles.ts";

Deno.test("Japanese prefers jimaku first, then the generic providers", () => {
  const names = providersFor("ja").map((p) => p.name);
  assertEquals(names[0], "jimaku");
  assert(names.includes("opensubtitles"));
});

Deno.test("non-Japanese languages never hit the Japanese-only provider", () => {
  for (const lang of ["de", "es", "fr"]) {
    const names = providersFor(lang).map((p) => p.name);
    assert(!names.includes("jimaku"), `${lang} should not use jimaku`);
    assert(names.length > 0, `${lang} has no providers`);
    assertEquals(names[0], "opensubtitles");
  }
});

Deno.test("every language has at least two fallbacks", () => {
  for (const lang of ["ja", "de", "es", "fr"]) {
    assert(providersFor(lang).length >= 2, `${lang} has too few providers`);
  }
});

Deno.test("filename scoring prefers the exact season/episode", () => {
  const s = (n: string) => scoreFilename(n, 1, 3);
  assert(s("Show.S01E03.de.srt") > s("Show.S01E04.de.srt"));
  assert(s("Show.E03.srt") > s("Show.srt"));
  assertEquals(s("Show.S01E03.mp4"), -1);
});

Deno.test("normalizeToCueText strips SRT numbering and timestamps", () => {
  const srt = "1\n00:00:01,000 --> 00:00:03,000\nGuten Morgen!\n\n2\n00:00:04,000 --> 00:00:06,000\nWie geht es dir?\n";
  assertEquals(normalizeToCueText(srt), "Guten Morgen!\nWie geht es dir?");
});

Deno.test("normalizeToCueText strips ASS markup", () => {
  const ass = "[Script Info]\nTitle: x\n[Events]\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\i1}Guten{\\i0}\\NMorgen\n";
  assertEquals(normalizeToCueText(ass), "Guten Morgen");
});

Deno.test("decodeSubtitleBytes handles UTF-8 and UTF-16 with umlauts", () => {
  const utf8 = new TextEncoder().encode("Schöne Grüße");
  assertEquals(decodeSubtitleBytes(utf8), "Schöne Grüße");

  const s = "Schöne Grüße";
  const u16 = new Uint8Array(2 + s.length * 2);
  u16[0] = 0xff;
  u16[1] = 0xfe;
  for (let i = 0; i < s.length; i++) {
    u16[2 + i * 2] = s.charCodeAt(i) & 0xff;
    u16[3 + i * 2] = s.charCodeAt(i) >> 8;
  }
  assertEquals(decodeSubtitleBytes(u16), s);
});

Deno.test("extractSubtitleText returns null for empty payloads", () => {
  assertEquals(extractSubtitleText(new Uint8Array([32, 10]), "x.srt", 1, 1), null);
});

Deno.test("extractSubtitleText passes raw subtitle files straight through", () => {
  const bytes = new TextEncoder().encode("1\n00:00:01,000 --> 00:00:02,000\nHallo\n");
  const out = extractSubtitleText(bytes, "x.srt", 1, 1)!;
  assert(out.text.includes("Hallo"));
  assertEquals(out.filename, "x.srt");
});
