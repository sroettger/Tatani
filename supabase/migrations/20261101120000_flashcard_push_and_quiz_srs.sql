-- Consolidated standalone migration for flashcard push notifications, serialized unhandled
-- delivery guards, per-delivery review tokens, and server-side Leitner SRS grading.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE TABLE IF NOT EXISTS public.flashcard_push_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  token text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  timezone text NOT NULL DEFAULT 'Asia/Tokyo',
  start_hour integer NOT NULL DEFAULT 9 CHECK (start_hour BETWEEN 0 AND 23),
  end_hour integer NOT NULL DEFAULT 21 CHECK (end_hour BETWEEN 0 AND 23),
  cards_per_day integer NOT NULL DEFAULT 4 CHECK (cards_per_day BETWEEN 1 AND 12),
  cards_per_hour integer NOT NULL DEFAULT 1 CHECK (cards_per_hour BETWEEN 1 AND 60),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_hour > start_hour),
  CHECK (cards_per_day <= end_hour - start_hour + 1)
);

ALTER TABLE public.flashcard_push_devices
  ADD COLUMN IF NOT EXISTS cards_per_hour integer NOT NULL DEFAULT 1 CHECK (cards_per_hour BETWEEN 1 AND 60);

COMMENT ON COLUMN public.flashcard_push_devices.cards_per_day IS
  'DEPRECATED: replaced by cards_per_hour; retained for client compatibility';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.flashcard_push_devices TO service_role;
ALTER TABLE public.flashcard_push_devices ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.flashcard_push_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  device_id uuid NOT NULL REFERENCES public.flashcard_push_devices(id) ON DELETE CASCADE,
  slot text NOT NULL,
  learning_language text NOT NULL,
  word text NOT NULL,
  reading text,
  meaning text,
  example_sentence text,
  level text,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  review_token uuid NOT NULL DEFAULT gen_random_uuid(),
  quiz_options jsonb,
  quiz_correct_index integer,
  quiz_selected_index integer,
  UNIQUE (device_id, slot)
);

ALTER TABLE public.flashcard_push_deliveries
  ADD COLUMN IF NOT EXISTS review_token uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS quiz_options jsonb,
  ADD COLUMN IF NOT EXISTS quiz_correct_index integer,
  ADD COLUMN IF NOT EXISTS quiz_selected_index integer;

ALTER TABLE public.flashcard_push_deliveries
  DROP CONSTRAINT IF EXISTS flashcard_quiz_valid,
  DROP CONSTRAINT IF EXISTS flashcard_quiz_selection_valid;

ALTER TABLE public.flashcard_push_deliveries
  ADD CONSTRAINT flashcard_quiz_valid CHECK (
    quiz_options IS NULL OR (
      jsonb_typeof(quiz_options) = 'array'
      AND jsonb_array_length(quiz_options) = 2
      AND quiz_correct_index IN (0, 1)
    )
  ),
  ADD CONSTRAINT flashcard_quiz_selection_valid CHECK (
    quiz_selected_index IS NULL OR quiz_selected_index = ANY (ARRAY[-1, 0, 1])
  );

GRANT ALL ON public.flashcard_push_deliveries TO service_role;
ALTER TABLE public.flashcard_push_deliveries ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.flashcard_push_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz
);

GRANT ALL ON public.flashcard_push_jobs TO service_role;
ALTER TABLE public.flashcard_push_jobs ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.guard_unhandled_flashcard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text, 0));
  IF EXISTS (
    SELECT 1
    FROM public.flashcard_push_deliveries
    WHERE user_id = NEW.user_id
      AND reviewed_at IS NULL
      AND status IN ('pending', 'sent')
  ) THEN
    RAISE EXCEPTION 'Previous flashcard is unhandled' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_unhandled_flashcard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_unhandled_flashcard() TO service_role;

DROP TRIGGER IF EXISTS guard_unhandled_flashcard ON public.flashcard_push_deliveries;
CREATE TRIGGER guard_unhandled_flashcard
  BEFORE INSERT ON public.flashcard_push_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.guard_unhandled_flashcard();

CREATE INDEX IF NOT EXISTS flashcard_push_unhandled_by_user
  ON public.flashcard_push_deliveries(user_id)
  WHERE reviewed_at IS NULL AND status IN ('pending', 'sent');

CREATE OR REPLACE FUNCTION public.review_flashcard_delivery(delivery_id uuid, owner_id uuid, remembered boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d public.flashcard_push_deliveries;
  intervals integer[] := ARRAY[1, 3, 7, 14, 30, 60, 120, 240, 480];
BEGIN
  UPDATE public.flashcard_push_deliveries
  SET reviewed_at = now()
  WHERE id = delivery_id
    AND user_id = owner_id
    AND reviewed_at IS NULL
    AND (quiz_options IS NULL OR quiz_selected_index IS NOT NULL)
  RETURNING * INTO d;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO public.user_word_state(
    user_id, word, reading, level, learning_language,
    correct_streak, last_reviewed_at, state, known_source, srs_level, srs_due_at
  )
  VALUES (
    owner_id, d.word, d.reading, d.level, d.learning_language,
    CASE WHEN remembered THEN 1 ELSE 0 END,
    now(),
    CASE WHEN remembered THEN 'known'::public.word_state ELSE 'learning'::public.word_state END,
    'learned',
    0,
    now() + interval '1 day'
  )
  ON CONFLICT (user_id, word, learning_language) DO UPDATE SET
    correct_streak = CASE WHEN remembered THEN user_word_state.correct_streak + 1 ELSE 0 END,
    last_reviewed_at = now(),
    state = CASE WHEN remembered THEN 'known'::public.word_state ELSE 'learning'::public.word_state END,
    known_source = 'learned',
    srs_level = CASE WHEN remembered THEN LEAST(user_word_state.srs_level + 1, 8) ELSE 0 END,
    srs_due_at = now() + make_interval(
      days => CASE WHEN remembered THEN intervals[LEAST(user_word_state.srs_level + 1, 8) + 1] ELSE 1 END
    );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.review_flashcard_delivery(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_flashcard_delivery(uuid, uuid, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.answer_flashcard_quiz(delivery_id uuid, owner_id uuid, selected_answer integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  d public.flashcard_push_deliveries;
  correct boolean;
  recorded boolean;
BEGIN
  SELECT * INTO d
  FROM public.flashcard_push_deliveries
  WHERE id = delivery_id AND user_id = owner_id
  FOR UPDATE;

  IF NOT FOUND OR d.quiz_options IS NULL THEN
    RETURN NULL;
  END IF;
  IF selected_answer NOT IN (-1, 0, 1) OR selected_answer IS NULL THEN
    RAISE EXCEPTION 'Invalid answer';
  END IF;
  IF d.reviewed_at IS NOT NULL THEN
    RETURN jsonb_build_object('recorded', false, 'correct', d.quiz_selected_index = d.quiz_correct_index, 'meaning', d.meaning);
  END IF;
  IF d.status NOT IN ('pending', 'sent') THEN
    RAISE EXCEPTION 'Quiz expired';
  END IF;

  correct := selected_answer = d.quiz_correct_index;
  UPDATE public.flashcard_push_deliveries SET quiz_selected_index = selected_answer WHERE id = d.id;
  recorded := public.review_flashcard_delivery(d.id, owner_id, correct);
  RETURN jsonb_build_object('recorded', recorded, 'correct', correct, 'meaning', d.meaning);
END;
$function$;

REVOKE ALL ON FUNCTION public.answer_flashcard_quiz(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.answer_flashcard_quiz(uuid, uuid, integer) TO service_role;

-- Optional helper to wire minute-based web push dispatch on a standalone Supabase project:
-- SELECT public.configure_flashcard_push_cron('https://<project-ref>.supabase.co');
CREATE OR REPLACE FUNCTION public.configure_flashcard_push_cron(project_url text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  j record;
  endpoint text := rtrim(project_url, '/') || '/functions/v1/flashcard-notifications';
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE jobname = 'flashcard-notifications-hourly' LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;

  PERFORM cron.schedule(
    'flashcard-notifications-hourly',
    '* * * * *',
    format(
      $cmd$
      WITH new_job AS (
        INSERT INTO public.flashcard_push_jobs DEFAULT VALUES RETURNING id
      )
      SELECT net.http_post(
        url := %L,
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body := jsonb_build_object('action', 'dispatch', 'job_id', id)
      )
      FROM new_job;
      $cmd$,
      endpoint
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.configure_flashcard_push_cron(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.configure_flashcard_push_cron(text) TO service_role;
