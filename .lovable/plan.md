## Anime Japanese Trainer — v1 Plan

A mobile-first app that turns anime episodes into personalized Japanese flashcards, adapting to what each user already knows.

### Auth & accounts

- Google Sign-In (via Lovable Cloud auth) — primary method.
- `profiles` table for display name + JLPT placement level + study stats.
- Per-user data is private (RLS).

### Onboarding: JLPT placement

- First-run quiz: ~20 adaptive questions spanning N5→N1 vocabulary/grammar.
- Result sets a baseline known-word list (e.g. all N5 + most N4 marked as "known"), seeding the skill model so cards for already-known words are skipped.
- Retakeable from settings.

### Main menu (home)

- Sorted list of **added anime** (most-recently-added first), each as a card with cover art + progress bar (episodes processed / total).
- Tap an anime → **Seasons list** → **Episodes list**.
- Each episode shows: status (Not processed / Processing / Ready), new-words count, and a "Study" button.
- "+ Add anime" opens a search powered by the AniList/Jikan API: results show poster, title (JP + EN), year, season/episode counts. Tap to add.

### Episode processing (on-demand)

When the user taps "Process episode":

1. **Auto-fetch subtitles** — edge function tries Jimaku/Kitsunekko by anime title + episode number.
2. **Fallback** — if not found, prompt user to upload `.srt`/`.ass`.
3. **AI extraction** (Lovable AI, Gemini) — sends the subtitle text to extract: unique vocabulary (with reading + meaning + part of speech), key grammar/expressions, and 1–3 example sentences pulled directly from the episode.
4. **Cache** — results stored per-episode so re-processing is instant and costs nothing.
5. **Filter against user's known words** → only new/uncertain items become cards for that user. But keep the list of removed words and give the user an option to quickly review them, sorted by likelihood that the user knows them.

### Study experience (Quick review + quiz)

- **Review mode**: flip cards (JP front → reading + meaning + sentence from the episode on back). "I know this" / "Still learning" buttons feed the skill model.
- **Quiz mode**: multiple choice (meaning → JP, JP → meaning, fill-in-the-blank from episode sentences).
- End-of-session summary: words mastered, words to revisit.

### Adaptive skill tracking

- Every word has a per-user state: `unknown` / `learning` / `known`.
- Updated by: placement baseline, "I know this" taps, repeated quiz correctness (3 right in a row → known), and incorrect answers (known → learning).
- Future episodes automatically skip words the user already knows.

### Per-episode dashboard

- New words / known words / mastery %, sentence list with audio playback (browser TTS using `ja-JP` voice for v1 — no extra API needed).

### Tech stack

- Lovable Cloud (Postgres + Auth + Edge Functions + Storage for uploaded subs).
- Lovable AI Gateway with `google/gemini-3-flash-preview` for extraction (cheap, fast, multilingual).
- Edge functions: `search-anime`, `fetch-subtitles`, `process-episode`, `placement-quiz-generate`.
- React + Tailwind + shadcn/ui, mobile-first layout with bottom nav (Home / Study / Stats / Settings).

### Database (high level)

- `profiles`, `user_roles`
- `anime`, `seasons`, `episodes` (shared catalog)
- `user_anime` (which anime each user added + ordering)
- `episode_vocab_cache` (AI extraction results, shared across users)
- `subtitles` (storage bucket + metadata)
- `user_word_state` (per-user word mastery)
- `study_sessions`, `quiz_results`

### Out of scope for v1 (suggested follow-ups)

- Native audio extraction from episode files
- Grammar deep-dives / SRS scheduling
- Social features / shared decks