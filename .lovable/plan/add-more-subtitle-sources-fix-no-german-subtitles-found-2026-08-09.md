# Add more subtitle sources (fix "no German subtitles found")

Today `fetch-subtitles` only knows one provider: Jimaku, which hosts Japanese subtitles only. For any non-Japanese learning language it returns `{ found: false, reason: "unsupported_language" }` immediately — that's why Romantic Killer in German fails. The fix is to turn the function into a provider chain that supports all learning languages.

## Provider chain

Try each in order, first hit wins, per-provider failures are logged and skipped:

1. **Jimaku** — Japanese only, keep as-is, first for `ja`.
2. **OpenSubtitles.com** — the largest multi-language source (German, Spanish, French included). REST API v1, needs a free API key plus a user login for download tokens.
3. **SubDL** — free API key, good anime coverage, returns zip archives.
4. **Podnapisi** — no key required, useful last-resort fallback.

Matching uses the anime title (romaji and English), season number, episode number, and the target language code from `_shared/languages.ts` (`subtitleLang`), scoring candidates so `S01E05`-style names win over a blind first-file pick.

## Handling the downloads

Providers return `.srt`, `.ass`, or a `.zip` containing one of those. A new `_shared/subtitles.ts` module will:
- unzip archives in-memory and pick the best subtitle entry,
- decode Latin-1/UTF-16 files correctly (German umlauts break otherwise),
- normalize SRT/ASS to plain cue text for the processing pipeline.

## Better feedback in the UI

Instead of one generic "no subtitles found" toast, the response carries which providers were tried and why each missed. The episode page shows a short reason and keeps the manual-upload path clearly offered as the fallback. New i18n keys go into both `en` and `ja`.

## What I need from you

OpenSubtitles and SubDL both require free accounts:
- **OpenSubtitles**: register at opensubtitles.com, then create an API consumer to get an API key; the download endpoint also needs your account username + password.
- **SubDL**: register at subdl.com and copy the API key from your profile.

Once you confirm, I'll open the secure form to collect `OPENSUBTITLES_API_KEY`, `OPENSUBTITLES_USERNAME`, `OPENSUBTITLES_PASSWORD`, and `SUBDL_API_KEY`. Podnapisi needs nothing, so German will work at least partially even before you add keys.

## Technical notes

- New file `supabase/functions/_shared/subtitles.ts`: zip handling, encoding detection, SRT/ASS normalization, filename scoring.
- New file `supabase/functions/fetch-subtitles/providers.ts`: one async function per provider with a shared `SubtitleProvider` signature returning `{ content, filename, provider } | null`.
- `fetch-subtitles/index.ts` drops the `unsupported_language` early return and instead iterates the ordered provider list for the resolved learning language, returning `{ found, content, filename, provider, attempts }`.
- OpenSubtitles requires a descriptive `User-Agent` header and a `/login` call to obtain the download token; the token is cached per invocation.
- `src/pages/EpisodeDetail.tsx`: surface `attempts` in the failure toast, no change to `startProcess`.

## Verification

- Call the deployed function directly for Romantic Killer episode 1 with a German learner and confirm a provider hit and readable cue text.
- Repeat for a Japanese learner to confirm Jimaku still wins first.
