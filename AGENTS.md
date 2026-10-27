# Architecture rules
- Web notifications use Firebase messaging in a dedicated service worker; do not treat it as an offline app-shell worker.
- Notification subscriptions and deliveries are managed by authenticated edge functions; device tokens stay server-side.
- Notification review links use delivery IDs and retain their destination through sign-in so review always reads authorized data.