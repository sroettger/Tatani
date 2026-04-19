

## Goal
Replace AI-guessed JLPT levels with the **official JLPT vocab list** when the word is on it. Fall back to the AI's level only if the word isn't found.

## Approach

1. **Source data**: Use a public JLPT vocabulary dataset. The cleanest one is [jonowo/jlpt-resources](https://github.com/jonowo/jlpt-resources) or [elzup/jlpt-word-list](https://github.com/elzup/jlpt-word-list) — both list ~8000 words across N5–N1 with kanji + reading.
2. **Storage**: Build a single JSON file `supabase/functions/_shared/jlpt-vocab.json` keyed by `"word|reading"` (or just `word` with array fallback) → `"N5"|"N4"|"N3"|"N2"|"N1"`. Roughly 200–400 KB gzipped, fine to bundle into the edge function.
3. **Lookup priority**:
   - Exact match on `word + reading` → official level.
   - Fallback: exact match on `word` alone (handles cases where AI gave a different reading) → official level.
   - No match → keep AI's `jlpt_level`.
4. **Where to apply**: In `process-episode` edge function, right after Gemini returns the vocab list, run each item through the lookup and overwrite `jlpt_level` if found. This means: future processing → official levels. Already-cached episodes → unchanged unless re-processed.
5. **Optional**: Add a one-shot "re-tag levels" pass that walks `episode_vocab_cache`, applies the lookup, and updates rows in place. Cheap, no AI calls.

## Files to change

- New: `supabase/functions/_shared/jlpt-vocab.json` (built from the public dataset; I'll fetch it and trim to `{word, reading, level}` rows).
- New: `supabase/functions/_shared/jlpt-lookup.ts` — exports `getOfficialJlptLevel(word, reading)`.
- Edit: `supabase/functions/process-episode/index.ts` — call the lookup after AI extraction.
- Edit: `supabase/functions/_shared/jlpt-vocab.json` is read via Deno's `import ... assert { type: "json" }`.

## Open questions

1. **Re-tag existing cached episodes?** Two options:
   - (a) Only apply to *future* processing — old caches keep AI levels until re-processed.
   - (b) Add a one-time backfill that re-tags every row in `episode_vocab_cache` right now (no AI cost, just a SQL update powered by the lookup table).

2. **Reading mismatch policy** — if the AI gave reading "じなん" but the official list has "次男" with reading "じなん" (matches) vs. an entry with a different reading (e.g. okurigana variant), should we:
   - (a) Strict: only match when reading matches exactly → safer, fewer matches.
   - (b) Lenient: match by surface word alone if reading mismatch → more coverage, occasional wrong level for homographs.

