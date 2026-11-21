# Google Play Store Setup & Publishing Guide (`com.tsuro.tatani`)

Everything in the repository and GitHub Actions is standalone and configured for Google Play Store delivery:

- **Package Name:** `com.tsuro.tatani`
- **SDK Targets:** `minSdk = 24`, `targetSdk = 36` (Android 16), `compileSdk = 36`
- **Release Optimization:** R8 shrinking + embedded deobfuscation `mapping.txt` + native symbol tables (`SYMBOL_TABLE`)
- **Upload Keystore Secrets:** `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` *(already configured in GitHub Secrets on `sroettger/Tatani`!)*
- **Store Graphics Ready in This Folder:**
  - App Icon (`512 × 512` 32-bit PNG): `play-store/icon-512.png`
  - Feature Graphic (`1024 × 500` 24-bit PNG): `play-store/feature-graphic-1024x500.png`
- **Privacy Policy & Data Deletion URL (GitHub Pages):** `https://sroettger.github.io/Tatani/privacy`

---

## Full Google Play Internal Testing Track + Auto-Deploy on Every Push

### 1. One-Time App Initialization in Play Console
Google Play's API requires the **very first** `.aab` of a new app to be uploaded manually in the web console:
1. Go to **[Google Play Console](https://play.google.com/console)** → **Create app**:
   - **App name:** `Tatani`
   - **Default language:** `English (United States)`
   - **App or game:** `App` · **Free or paid:** `Free`
2. Under **Policy and programs → App content → Privacy policy**, enter:
   - `https://sroettger.github.io/Tatani/privacy`
3. Go to **Test and release → Testing → Internal testing**:
   - Under **Testers**, create an email list containing your Google Play email address and save.
   - Click **Create new release** → upload **`tatani-android-release.aab`** (downloaded from GitHub Actions) → **Next** → **Save and publish**.
   - Copy the **Join on the web / Copy link** opt-in URL under **Testers**, open it on your phone, tap **Accept invite**, and install straight from Google Play! *(Internal testing releases bypass multi-day production review and go live in minutes.)*

### 2. Enable Automated CI Uploads (`PLAY_SERVICE_ACCOUNT_JSON`)
Once the first `.aab` is uploaded above, `.github/workflows/android-apk.yml` will automatically push every new `main` build to Google Play Internal Testing as soon as you add `PLAY_SERVICE_ACCOUNT_JSON`:
1. In **Google Cloud Console**, create (or select) a project → enable **Google Play Android Developer API**.
2. Go to **IAM & Admin → Service Accounts → Create Service Account** → create a JSON key (`service-account.json`).
3. In **Google Play Console → Users and permissions → Invite new users**, paste the service account's email, grant **Release to testing tracks** (and **View app information**) for `Tatani`, and click **Invite user**.
4. In GitHub (`sroettger/Tatani` → **Settings → Secrets and variables → Actions**), add a new repository secret named **`PLAY_SERVICE_ACCOUNT_JSON`** containing the raw JSON contents of `service-account.json`.

---

## Copy-Paste Store Listing & App Content Answers

- **Title (≤30 chars):** `Tatani — Anime Japanese SRS`
- **Short description (≤80 chars):** `Learn Japanese vocabulary in anime context and retain it with instant SRS sprints.`
- **Full description:**
  > Master Japanese vocabulary from the anime you watch. Tatani splits initial contextual learning from high-speed spaced repetition so you never get quizzed on words you haven't encoded yet.
  >
  > • Distraction-Free SRS Sprint: Launches instantly offline from local storage with swipe-to-grade gestures, native Japanese audio, and contextual dialogue lines that rotate across unlocked episodes.
  > • Learn in Context First: Encode 6 new episode words at a time with full scene dialogue, kanji component breakdowns, readings, and short-lag recall drills before graduating words to spaced repetition.
  > • Episode Readiness & Triage: Automatically extract vocabulary from episodes, skip words you already know, and track comprehension coverage before watching.
  > • Contextual Booster Notifications: Receive daytime self-check reminders strictly for graduated due words—complete with the anime example sentence.
- **Privacy Policy URL:** `https://sroettger.github.io/Tatani/privacy`
- **Account / Data Deletion URL:** `https://sroettger.github.io/Tatani/privacy#delete-data` *(also built in-app under `Library → Account & Privacy → Delete my study & account data`)*
- **Data Safety Summary:**
  - *Collects data?* **Yes** · *Encrypted in transit?* **Yes** · *Users can request data deletion?* **Yes**
  - *Personal info → Email address & User IDs:* Collected, required for account authentication/sync, **not shared** with third parties.
  - *App activity → In-app study/progress data:* Collected for flashcard scheduling, **not shared**.
  - *Device or other IDs:* Optional push notification token if notifications are enabled, **not shared**.
- **Ads:** No ads · **Target Audience:** 13+ · **App Access:** Create a test email/password account in Supabase Auth and list it under *App content → App access* for Google reviewers.
