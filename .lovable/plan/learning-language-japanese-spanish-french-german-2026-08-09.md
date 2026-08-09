# Learning language: Japanese, Spanish, French, German

Today Tatani is Japanese-only end to end: JLPT levels, furigana/kanji UI, a Japanese tokenizer, and Jimaku as the only subtitle source. This plan generalizes the app so a user can pick which language they are learning, with progress tracked separately per language.

## What the user gets

- A "Language I'm learning" setting (Japanese, Spanish, French, German), separate from the existing "language I speak" setting.
- Everything downstream follows the choice: subtitle fetching, vocabulary extraction, flashcards, quizzes, episode summary, discussion, tutor chat, recommendations.
- Progress is per language. Switching to Spanish shows an empty Spanish library/word list; switching back to Japanese restores all existing Japanese data untouched.
- Proficiency levels adapt: JLPT N5-N1 for Japanese, CEFR A1-C2 for Spanish/French/German. Placement/onboarding asks in the right scale.
- Japanese-specific UI (furigana, kanji-only word preference, reading field) only appears when learning Japanese.

## Data model

- `learning_language` column on `profiles` (default `ja`) — the active choice.
- New `user_language_progress` table keyed by (user_id, learning_language): proficiency level, placement_done, total_words_known, study_streak. Existing profile values migrate into a `ja` row so nothing is lost.
- Add `learning_language` to `user_word_state`, `study_chunks`, `study_sessions`, `quiz_results`, `user_anime`, `episode_summaries`; backfill existing rows to `ja`. Unique constraint on words becomes (user_id, word, learning_language).
- `episode_vocab_cache` and `subtitles` get a `language` dimension so one episode can be processed in several languages.
- Proficiency stored as a plain text code (`N5`..`N1`, `A1`..`C2`) rather than the Japanese-only enum, with a shared mapping table in code.

## Pipeline generalization

- Subtitle sources become pluggable per language: Jimaku stays for Japanese; for Spanish/French/German the fetcher uses OpenSubtitles-style/manual upload, with upload as the guaranteed fallback. Manual `.srt`/`.ass` upload works for every language.
- Tokenization becomes a per-language adapter: the existing kuromoji path for Japanese, a whitespace + lemma-normalizing path for the European languages.
- Level tagging: JLPT lookup for Japanese; AI-assigned CEFR levels for the others, cached in `episode_vocab_cache`.
- All AI edge functions receive both `learning_language` and the user's UI language, and are told which language to teach and which to explain in.

## UI changes

- Settings: new "Learning" card with the four languages; switching reloads library/progress for that language.
- Onboarding: language pick first, then placement in the matching level scale.
- Level chips, Stats labels, and study screens read the level scale from the active language instead of hardcoding JLPT.
- Furigana rendering and the "kanji only" word preference are gated to Japanese.
- New i18n keys for all added strings in both `en` and `ja`.

## Scope note

This is a large change touching schema, all edge functions, and most screens. Suggested build order: (1) schema + per-language progress, (2) setting + UI gating, (3) subtitle/tokenizer adapters, (4) AI functions. Each stage stays working for Japanese throughout.
