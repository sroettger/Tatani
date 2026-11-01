ALTER TABLE public.flashcard_push_deliveries ADD COLUMN quiz_options jsonb, ADD COLUMN quiz_correct_index integer, ADD COLUMN quiz_selected_index integer;
ALTER TABLE public.flashcard_push_deliveries ADD CONSTRAINT flashcard_quiz_valid CHECK (quiz_options IS NULL OR (jsonb_typeof(quiz_options) = 'array' AND jsonb_array_length(quiz_options) = 2 AND quiz_correct_index IN (0,1))), ADD CONSTRAINT flashcard_quiz_selection_valid CHECK (quiz_selected_index IS NULL OR quiz_selected_index IN (0,1));
CREATE OR REPLACE FUNCTION public.review_flashcard_delivery(delivery_id uuid, owner_id uuid, remembered boolean) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d public.flashcard_push_deliveries; intervals integer[] := ARRAY[1,3,7,14,30,60,120,240,480];
BEGIN
 UPDATE public.flashcard_push_deliveries SET reviewed_at=now() WHERE id=delivery_id AND user_id=owner_id AND reviewed_at IS NULL AND (quiz_options IS NULL OR quiz_selected_index IS NOT NULL) RETURNING * INTO d;
 IF NOT FOUND THEN RETURN false; END IF;
 INSERT INTO public.user_word_state(user_id,word,reading,level,learning_language,correct_streak,last_reviewed_at,state,known_source,srs_level,srs_due_at)
 VALUES(owner_id,d.word,d.reading,d.level,d.learning_language,CASE WHEN remembered THEN 1 ELSE 0 END,now(),CASE WHEN remembered THEN 'known'::public.word_state ELSE 'learning'::public.word_state END,'learned',0,now()+interval '1 day')
 ON CONFLICT(user_id,word,learning_language) DO UPDATE SET
 correct_streak=CASE WHEN remembered THEN user_word_state.correct_streak+1 ELSE 0 END,
 last_reviewed_at=now(),state=CASE WHEN remembered THEN 'known'::public.word_state ELSE 'learning'::public.word_state END,
 known_source='learned',srs_level=CASE WHEN remembered THEN LEAST(user_word_state.srs_level+1,8) ELSE 0 END,
 srs_due_at=now()+make_interval(days=>CASE WHEN remembered THEN intervals[LEAST(user_word_state.srs_level+1,8)+1] ELSE 1 END);
 RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.review_flashcard_delivery(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.review_flashcard_delivery(uuid,uuid,boolean) TO service_role;
CREATE OR REPLACE FUNCTION public.answer_flashcard_quiz(delivery_id uuid, owner_id uuid, selected_answer integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d public.flashcard_push_deliveries; correct boolean; recorded boolean;
BEGIN
 SELECT * INTO d FROM public.flashcard_push_deliveries WHERE id=delivery_id AND user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR d.quiz_options IS NULL THEN RETURN NULL; END IF;
 IF selected_answer NOT IN (0,1) OR selected_answer IS NULL THEN RAISE EXCEPTION 'Invalid answer'; END IF;
 IF d.reviewed_at IS NOT NULL THEN
   RETURN jsonb_build_object('recorded',false,'correct',d.quiz_selected_index=d.quiz_correct_index,'meaning',d.meaning);
 END IF;
 IF d.status NOT IN ('pending','sent') THEN RAISE EXCEPTION 'Quiz expired'; END IF;
 correct := selected_answer=d.quiz_correct_index;
 UPDATE public.flashcard_push_deliveries SET quiz_selected_index=selected_answer WHERE id=d.id;
 recorded := public.review_flashcard_delivery(d.id,owner_id,correct);
 RETURN jsonb_build_object('recorded',recorded,'correct',correct,'meaning',d.meaning);
END; $$;
REVOKE ALL ON FUNCTION public.answer_flashcard_quiz(uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.answer_flashcard_quiz(uuid,uuid,integer) TO service_role;