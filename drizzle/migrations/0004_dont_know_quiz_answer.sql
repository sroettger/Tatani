ALTER TABLE public.flashcard_push_deliveries DROP CONSTRAINT flashcard_quiz_selection_valid;
ALTER TABLE public.flashcard_push_deliveries ADD CONSTRAINT flashcard_quiz_selection_valid
  CHECK (quiz_selected_index IS NULL OR quiz_selected_index = ANY (ARRAY[-1, 0, 1]));

CREATE OR REPLACE FUNCTION public.answer_flashcard_quiz(delivery_id uuid, owner_id uuid, selected_answer integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE d public.flashcard_push_deliveries; correct boolean; recorded boolean;
BEGIN
 SELECT * INTO d FROM public.flashcard_push_deliveries WHERE id=delivery_id AND user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR d.quiz_options IS NULL THEN RETURN NULL; END IF;
 IF selected_answer NOT IN (-1,0,1) OR selected_answer IS NULL THEN RAISE EXCEPTION 'Invalid answer'; END IF;
 IF d.reviewed_at IS NOT NULL THEN
   RETURN jsonb_build_object('recorded',false,'correct',d.quiz_selected_index=d.quiz_correct_index,'meaning',d.meaning);
 END IF;
 IF d.status NOT IN ('pending','sent') THEN RAISE EXCEPTION 'Quiz expired'; END IF;
 correct := selected_answer=d.quiz_correct_index;
 UPDATE public.flashcard_push_deliveries SET quiz_selected_index=selected_answer WHERE id=d.id;
 recorded := public.review_flashcard_delivery(d.id,owner_id,correct);
 RETURN jsonb_build_object('recorded',recorded,'correct',correct,'meaning',d.meaning);
END; $function$;