

## Goal
Add spaced repetition to "known" words. Distinguish words known *before* studying (permanent) vs. words learned *through* study (time-limited). Future episodes auto-promote due words back into "to learn." Old episodes only re-evaluate when user hits "Rewatch."

## Data model changes (`user_word_state`)

Add columns:
- `known_source` text — `'prior'` (already knew it) or `'learned'` (studied here). Null = not known.
- `srs_level` int default 0 — current SRS box (0..8).
- `srs_due_at` timestamptz — when this word becomes due for re-review.
- `marked_known_at` timestamptz — when it was last marked known.

`state` field semantics stay the same (`known` / `learning` / `unknown`), but for `learned` words we now also check `srs_due_at` to decide if they should resurface in *new* episodes.

SRS intervals (days, Leitner-ish): `[1, 3, 7, 14, 30, 60, 120, 240, 480]`.

## UI changes — `EpisodeDetail.tsx`

**"Mark as known" gets two options** (small dropdown / two buttons):
1. **Already knew it** → `state='known'`, `known_source='prior'`, no due date. Permanent.
2. **Learned it** → `state='known'`, `known_source='learned'`, `srs_level=0`, `srs_due_at = now + 1 day`.

(Default click = "Learned it" since that's the common case after studying. "Already knew it" available via small secondary action / long-press / dropdown.)

**Rewatch button** on episode page header:
- Re-evaluates this episode's `known` words. For each `learned` word where `srs_due_at <= now`: demote back to `learning` (resets streak), increment `srs_level`, set new `srs_due_at = now + intervals[new_level]`. Show toast: "X words back in your queue."
- `prior` words are never demoted.

## Auto-promotion on episode load

When a new episode is opened (no chunks yet, or first time viewing), run the same due-check pass implicitly: any `learned` words appearing in this episode that are due get demoted into the queue automatically. This satisfies "when episode 2 is processed, check the time limit."

To prevent retro-resurfacing in *already-opened* episodes: track `last_seen_in_episode` per word OR simpler — only auto-demote if the user has never opened/chunked this episode before (check `study_chunks` for this episode). Old episodes require explicit Rewatch.

## Quiz wins (later, optional)

When user gets a `learned` word right in a quiz, bump `srs_level` and push `srs_due_at` further out. (Out of scope unless you want it now.)

## Files to edit
- New migration: add 4 columns to `user_word_state`.
- `src/pages/EpisodeDetail.tsx`: split mark-known into two actions, add Rewatch button, add auto-demote logic on first-open, filter `knownVocab` vs `queueVocab` accordingly.
- `src/pages/StudyChunk.tsx`, `StudySession.tsx`, `VoiceStudySession.tsx`: no behavior change (still don't auto-mark known). Optional later: SRS bump on quiz correct.

## Open questions

1. Default action for the "Mark as known" button — should clicking it assume "Learned it" (SRS) and require a secondary action for "Already knew it"? Or always show both buttons side by side?
2. Should getting a word right in a quiz advance its SRS level (push the due date out further), or only the explicit "mark known" action does that?

