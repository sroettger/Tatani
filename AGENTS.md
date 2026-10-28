# Architecture rules
- Web notifications use Firebase messaging in a dedicated service worker; do not treat it as an offline app-shell worker.
- Notification subscriptions and deliveries are managed by authenticated edge functions; device tokens stay server-side.
- Notification review links use delivery IDs and retain their destination through sign-in so review always reads authorized data.
- Minute-based notification callbacks use single-use database job IDs with five-minute expiry; local hourly frequency slots prevent catch-up bursts.
- A database insert trigger serializes deliveries per user and blocks pending or sent unreviewed cards across all devices, including test sends.
- Dependencies are pinned by the bun lockfile; install failures with DNS errors are transient registry outages, not code issues.
<!-- rebuild trigger 3 -->
