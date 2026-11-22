-- Remove unconfirmed empty bot / Google Play Pre-Launch Robo test accounts from auth.users
-- so password-reset endpoints cannot trigger bounced emails to synthetic addresses.
DELETE FROM auth.users u
WHERE u.email_confirmed_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.user_anime ua WHERE ua.user_id = u.id)
  AND NOT EXISTS (SELECT 1 FROM public.user_word_state uws WHERE uws.user_id = u.id);
