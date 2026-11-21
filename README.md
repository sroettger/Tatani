# Tatani — Contextual Anime Japanese SRS

Tatani is a standalone Japanese vocabulary & comprehension trainer built around **splitting initial contextual learning from high-speed spaced repetition**, available as both a **native Kotlin + Jetpack Compose Android app** (`android/`) and a **React + TypeScript web app** (`src/`).

- **Web App (GitHub Pages):** https://sroettger.github.io/Tatani/
- **Privacy Policy & Data Deletion:** https://sroettger.github.io/Tatani/privacy
- **Google Play Package ID:** `app.tatani.android` (`minSdk = 24`, `targetSdk = 36`)

---

## Architecture

1. **Sprint Mode (Zero-Latency Spaced Retrieval):**
   - Boots straight into due flashcards from local storage (`Room` SQLite on Android, `localStorage` + write-ahead outbox on web) with `<50ms` card transitions, swipe gestures, native TTS, and sentence context diversity across unlocked episodes.
2. **Learn in Context Mode (Guided Encoding + Short-Lag Drill):**
   - Encodes 6 new episode words at a time with full subtitle scene context, kanji character breakdowns, readings, and immediate short-lag recall before graduating words (`srs_due_at`) into spaced repetition.
3. **Standalone Backend (Supabase + Direct Google Gemini API):**
   - **Database & Auth:** Self-owned Supabase project (`supabase/migrations/`), with standard Supabase Email/Password + Google OAuth.
   - **AI Extraction & Tutoring:** Direct calls to Google Gemini's OpenAI-compatible endpoint (`gemini-2.5-flash`) via `GEMINI_API_KEY` in `supabase/functions/_shared/ai.ts`.
   - **Notifications:** Native Android `WorkManager` booster notifications (`DueBoosterWorker.kt`) + direct Firebase Cloud Messaging HTTP v1 (`supabase/functions/_shared/fcm.ts`) for web push.

---

## GitHub Actions Secrets for Standalone Deployment

Configure these in **Settings → Secrets and variables → Actions**:

| Secret Name | Purpose |
| --- | --- |
| `SUPABASE_PROJECT_ID` | Your 20-char Supabase project reference ID (e.g. `abcdefghijklmopqrstu`) |
| `SUPABASE_URL` | `https://<SUPABASE_PROJECT_ID>.supabase.co` (used by Android & GitHub Pages builds) |
| `SUPABASE_ANON_KEY` | Your Supabase project's public `anon` / publishable key |
| `SUPABASE_ACCESS_TOKEN` | Personal access token from https://supabase.com/dashboard/account/tokens (for CI deploys) |
| `SUPABASE_DB_PASSWORD` | Your Supabase Postgres database password (for `supabase db push` migrations) |
| `GEMINI_API_KEY` | Google AI Studio API key from https://aistudio.google.com/apikey |
| `ANDROID_KEYSTORE_BASE64` | Base64-encoded Android upload keystore *(already set)* |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password *(already set)* |
| `ANDROID_KEY_ALIAS` | Upload key alias *(already set)* |
| `ANDROID_KEY_PASSWORD` | Upload key password *(already set)* |
| `PLAY_SERVICE_ACCOUNT_JSON` | *(Optional)* Google Play Developer API service account JSON for auto-publishing to Internal Testing |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | *(Optional)* Firebase service account JSON if using browser web push notifications |

---

## Local Development

### Web App
```sh
cp .env.example .env.local
# Fill in VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.local
bun install
bun run dev
```

### Native Android App (`android/`)
```sh
export SUPABASE_URL="https://<your-project-ref>.supabase.co"
export SUPABASE_ANON_KEY="<your-anon-key>"
cd android
./gradlew testDebugUnitTest assembleDebug
```
