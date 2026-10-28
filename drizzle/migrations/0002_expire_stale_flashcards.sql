UPDATE public.flashcard_push_deliveries SET status = 'expired' WHERE reviewed_at IS NULL AND status IN ('pending','sent') AND created_at < now() - interval '2 hours';
