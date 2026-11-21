# Tatani Native Android App (Kotlin + Jetpack Compose)

True native Android client for Tatani backed directly by the shared Supabase database (`user_word_state`, `user_anime`, `episodes`, `episode_vocab_cache`, and Edge Functions).

## Architecture Highlights

- **Distraction-Free Sprint Boot (`SprintScreen.kt`):** Launches straight from Room SQLite (`tatani_local.db`) in `<16ms` with zero network spinner, horizontal swipe-to-grade gestures, native haptic feedback, pre-warmed `TextToSpeech` (`ja-JP`), Listening Mode, Undo, and a 1-tap `Library` switch.
- **Learn vs. Repeat Split (`LearnScreen.kt` & `SrsEngine.kt`):**
  - **Step 1 — Guided Contextual Encoding:** Introduces up to 6 unlearned anime words with full dialogue sentence context, kanji morphological breakdown chips, reading, meaning, and auto-played Japanese audio—plus instant *"Known (Skip SRS)"* triage.
  - **Step 2 — Short-Lag Recall Drill:** Cycles encoded words at expanding intraday lags until 2 successful recalls graduate the word into SRS (`srs_due_at` scheduled).
- **Offline-First Write-Ahead Outbox (`TataniRepository.kt`):** Every review updates Room SQLite synchronously (`<2ms`) and queues an idempotent mutation in `outbox_mutations`, synced asynchronously to Supabase PostgREST.
- **Graduated Contextual Booster Notifications (`DueBoosterWorker.kt` & `BoosterActionReceiver.kt`):** Periodic `WorkManager` sync surfaces native Android self-check notifications (*"I know"* / *"I don't know"*) strictly for graduated due SRS words, displaying the episode example sentence in the notification body and re-alerting with the translation.

## Building & Running

```bash
cd android
./gradlew testDebugUnitTest assembleDebug
```

The installable APK is generated at:
`android/app/build/outputs/apk/debug/app-debug.apk`

Every push touching `android/` also triggers `.github/workflows/android-apk.yml`, uploading `tatani-android-debug-apk` to GitHub Actions artifacts for direct phone installation.
