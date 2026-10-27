# Architecture rules
- Web notifications use Firebase messaging in a dedicated service worker; do not treat it as an offline app-shell worker.
- Notification subscriptions and deliveries are managed by authenticated edge functions; device tokens stay server-side.
- Notification review links use delivery IDs and retain their destination through sign-in so review always reads authorized data.
- Hourly notification callbacks are authenticated by single-use database job IDs with five-minute expiry, not publicly reusable scheduler credentials.
- Dependencies are pinned by the bun lockfile; install failures with DNS errors are transient registry outages, not code issues.