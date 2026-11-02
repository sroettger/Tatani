# Architecture rules
- Web notifications use Firebase messaging in a dedicated service worker; do not treat it as an offline app-shell worker.
- Forward foreground Firebase messages to the dedicated messaging worker on startup and after enabling notifications, so test and scheduled pushes use the same quiz display even while the app is visible.
- Notification subscriptions and deliveries are managed by authenticated edge functions; device tokens stay server-side.
- Flashcard pushes are data-only two-choice quizzes plus an "I don't know" action (answer -1, always graded incorrect); server-side answer keys grade via per-delivery tokens and atomically update recall and existing Leitner intervals, with the same quiz page as fallback. Legacy Reveal/grade handling remains only for older deliveries.
- Notification quiz answers are first persisted in a dedicated IndexedDB outbox, then synchronized by the messaging worker with bounded requests and Background Sync/push/app-visit retries; grading remains server-side and idempotent so offline saving never claims a grade or advances SRS early.
- Notification selection honors srs_due_at even for known words, so automatic grading spaces future reviews rather than permanently excluding correct answers.
- Minute-based notification callbacks use single-use database job IDs with five-minute expiry; local hourly frequency slots prevent catch-up bursts.
- A database insert trigger serializes deliveries per user and blocks unreviewed cards; the sender first expires cards older than two hours, and test sends expire all open cards, because dismissed notifications are undetectable.
- Dependencies are pinned by the bun lockfile; install failures with DNS errors are transient registry outages, not code issues.
<!-- rebuild trigger 3 -->
