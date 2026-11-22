import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { zipSync } from "https://esm.sh/fflate@0.8.2";
import { providersFor, scoreEpisodeFilename } from "./providers.ts";
import {
  cleanSubtitleDialogue,
  decodeSubtitleBytes,
  extractSubtitleText,
  normalizeToCueText,
  scoreFilename,
} from "../_shared/subtitles.ts";

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

Deno.test("filename scoring prefers exact season/episode and ignores video codec tokens", () => {
  const s = (n: string) => scoreFilename(n, 1, 3);
  assert(s("Show.S01E03.de.srt") > s("Show.S01E04.de.srt"));
  assert(s("Show.E03.srt") > s("Show.srt"));
  assertEquals(s("Show.S01E03.mp4"), -1);

  // Codec/resolution tokens like [10bit], 1080p, x264, AAC2.0 must not false-match episode 10 or 264
  const ep5Release = "[SubGroup] Show - 05 [1080p][x264][10bit][Hi10p][AAC2.0][FLAC].srt";
  assertEquals(scoreEpisodeFilename(ep5Release, 1, 10), -1);
  assertEquals(scoreEpisodeFilename(ep5Release, 1, 264), -1);
  assert(scoreEpisodeFilename(ep5Release, 1, 5) > 0);
  assert(scoreFilename(ep5Release, 1, 5) > scoreFilename(ep5Release, 1, 10));
});

Deno.test("normalizeToCueText strips SRT numbering and timestamps", () => {
  const srt = "1\n00:00:01,000 --> 00:00:03,000\nGuten Morgen!\n\n2\n00:00:04,000 --> 00:00:06,000\nWie geht es dir?\n";
  assertEquals(normalizeToCueText(srt), "Guten Morgen!\nWie geht es dir?");
});

Deno.test("normalizeToCueText strips ASS markup", () => {
  const ass = "[Script Info]\nTitle: x\n[Events]\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\i1}Guten{\\i0}\\NMorgen\n";
  assertEquals(normalizeToCueText(ass), "Guten Morgen");
});

Deno.test("decodeSubtitleBytes handles UTF-8 and UTF-16 with umlauts and strips BOM", () => {
  const utf8WithBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("Schöne Grüße")]);
  assertEquals(decodeSubtitleBytes(utf8WithBom), "Schöne Grüße");

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

Deno.test("extractSubtitleText returns null for empty payloads and filters embedded fonts from zips", () => {
  assertEquals(extractSubtitleText(new Uint8Array([32, 10]), "x.srt", 1, 1), null);

  const archive = zipSync({
    "fonts/NotoSansJP.ttf": new Uint8Array(2048),
    "Subs/Show.S01E02.srt": new TextEncoder().encode("1\n00:00:01,000 --> 00:00:02,000\nこんにちは\n"),
  });
  const extracted = extractSubtitleText(archive, "bundle.zip", 1, 2);
  assert(extracted !== null);
  assertEquals(extracted.filename, "Subs/Show.S01E02.srt");
  assert(extracted.text.includes("こんにちは"));
});

Deno.test("extractSubtitleText passes raw subtitle files straight through", () => {
  const bytes = new TextEncoder().encode("1\n00:00:01,000 --> 00:00:02,000\nHallo\n");
  const out = extractSubtitleText(bytes, "x.srt", 1, 1)!;
  assert(out.text.includes("Hallo"));
  assertEquals(out.filename, "x.srt");
});

Deno.test("cleanSubtitleDialogue cleans VTT/ASS headers, vector drawings, ruby furigana, entities, speaker prefixes, and SFX cues", () => {
  const vtt = `\uFEFFWEBVTT

STYLE
::cue { color: yellow; }

NOTE translator note
second note line

cue-1
00:00:01.000 --> 00:00:03.000
<ruby>魔法<rp>(</rp><rt>まほう</rt><rp>)</rp></ruby>を&nbsp;使う！&lrm;

cue-2
00:00:04.000 --> 00:00:06.000
（フリーレン） 明日（あした）は&quot;早い&quot;よ。

cue-3
00:00:07.000 --> 00:00:08.000
（どうして…？）

cue-4
00:00:09.000 --> 00:00:10.000
（ドアの閉まる音）

cue-5
00:00:11.000 --> 00:00:12.000
♪♪〜
`;
  assertEquals(
    cleanSubtitleDialogue(vtt),
    '魔法を 使う！\n明日は"早い"よ。\n（どうして…？）',
  );

  const ass = `[Script Info]
Title: Test
[Events]
Dialogue: 0,0:00:01.00,0:00:02.00,Signs,,0,0,0,,{\\pos(100,100)\\p1}m 0 0 l 50 0 50 50 0 50{\\p0}
Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,（笑）
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,(フェルン) 行きましょう\\N早く！
`;
  assertEquals(cleanSubtitleDialogue(ass), "行きましょう 早く！");
});
