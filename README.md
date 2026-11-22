# Tatani — Contextual Anime Japanese SRS for Android

Tatani is a native Kotlin + Jetpack Compose Android vocabulary & comprehension trainer (`android/`) built around **evidence-based contextual encoding, 3-stage scaffolded graduation, and zero-latency spaced repetition**.

- **Google Play Package ID:** `com.tsuro.tatani` (`minSdk = 24`, `targetSdk = 36`, Flexible Play In-App Updates enabled)
- **Privacy Policy & Data Deletion:** https://sroettger.github.io/Tatani/privacy

---

## Architecture

1. **Learn in Context Mode (Guided Encoding + 3-Stage Scaffolded Graduation):**
   - Encodes 8 new episode words per micro-batch with full subtitle scene context, kanji character breakdowns, readings, and pronunciation audio.
   - Graduates words through a 3-stage desirable-difficulty ladder (**1/3 Speed Blitz recognition → 2/3 Kana-assisted active recall → 3/3 Kanji-first active recall**) with a working-memory spacer cushion so tail words are never tested back-to-back.
   - Schedules newly graduated words to a **4-hour intraday consolidation step** before advancing across `1d → 3d → 7d → 14d → 30d → 60d → 120d → 240d → 480d`.
2. **Sprint Mode (Zero-Latency Spaced Retrieval):**
   - Boots straight into due flashcards from local `Room` SQLite storage with `<50ms` card transitions, swipe gestures, 1-tap `かな · Peek reading`, native TTS, and sentence context diversity across unlocked episodes.
3. **Watch Mode (Live Anime Bingo & Comprehension Meter):**
   - Tracks per-episode lexical comprehension toward the `85%+ Watch-Ready` threshold and generates an interactive 3×3 Watch Bingo board for active noticing while watching.
4. **Standalone Backend (Supabase + Direct Google Gemini API):**
   - **Database & Auth:** Self-owned Supabase project (`supabase/migrations/`), with Supabase Email/Password + Google OAuth PKCE.
   - **AI Extraction:** Direct calls to Google Gemini (`gemini-3.5-flash-lite` with automatic fallback across `3.1` / `2.5` Flash-Lite) via `GEMINI_API_KEY` in `supabase/functions/_shared/ai.ts`.
   - **Notifications:** Native Android `WorkManager` daytime booster notifications (`DueBoosterWorker.kt`).

---

## GitHub Actions Secrets for Standalone Deployment

[scripts/provision-supabase.mjs](scripts/provision-supabase.mjs) automatically discovers/provisions the `Tatani` Supabase project, applies SQL migrations, and resolves `SUPABASE_URL` and `SUPABASE_ANON_KEY` on every Android build:

| Secret Name | Purpose |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | **Required.** Unscoped Personal Access Token from https://supabase.com/dashboard/account/tokens |
| `GEMINI_API_KEY` | **Required.** Google AI Studio API key from https://aistudio.google.com/apikey |
| `ANDROID_KEYSTORE_BASE64` | Base64-encoded Android upload keystore |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Upload key alias |
| `ANDROID_KEY_PASSWORD` | Upload key password |
| `PLAY_SERVICE_ACCOUNT_JSON` | Google Play Developer API service account JSON for auto-publishing to Internal Testing |

---

## Local Development (`android/`)

```sh
export SUPABASE_URL="https://<your-project-ref>.supabase.co"
export SUPABASE_ANON_KEY="<your-anon-key>"
cd android
./gradlew testDebugUnitTest assembleDebug
```
