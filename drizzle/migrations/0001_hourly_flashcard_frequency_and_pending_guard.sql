ALTER TABLE public.flashcard_push_devices ADD COLUMN cards_per_hour integer NOT NULL DEFAULT 1 CHECK (cards_per_hour BETWEEN 1 AND 60);
COMMENT ON COLUMN public.flashcard_push_devices.cards_per_day IS 'DEPRECATED: replaced by cards_per_hour; retained for deployed client compatibility';
CREATE OR REPLACE FUNCTION public.guard_unhandled_flashcard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text, 0));
 IF EXISTS (SELECT 1 FROM public.flashcard_push_deliveries WHERE user_id = NEW.user_id AND reviewed_at IS NULL AND status IN ('pending','sent')) THEN
  RAISE EXCEPTION 'Previous flashcard is unhandled' USING ERRCODE = 'P0001';
 END IF;
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.guard_unhandled_flashcard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_unhandled_flashcard() TO service_role;
CREATE TRIGGER guard_unhandled_flashcard BEFORE INSERT ON public.flashcard_push_deliveries FOR EACH ROW EXECUTE FUNCTION public.guard_unhandled_flashcard();
CREATE INDEX flashcard_push_unhandled_by_user ON public.flashcard_push_deliveries(user_id) WHERE reviewed_at IS NULL AND status IN ('pending','sent');
DO $$ DECLARE j record; BEGIN FOR j IN SELECT jobid FROM cron.job WHERE jobname = 'flashcard-notifications-hourly' LOOP PERFORM cron.alter_job(j.jobid, schedule := '* * * * *'); END LOOP; END $$;