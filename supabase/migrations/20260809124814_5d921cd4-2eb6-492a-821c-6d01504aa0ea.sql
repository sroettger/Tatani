ALTER TABLE public.user_word_state ALTER COLUMN jlpt_level TYPE text USING jlpt_level::text;
ALTER TABLE public.user_word_state RENAME COLUMN jlpt_level TO level;

ALTER TABLE public.study_chunk_words ALTER COLUMN jlpt_level TYPE text USING jlpt_level::text;
ALTER TABLE public.study_chunk_words RENAME COLUMN jlpt_level TO level;