-- Forja friend challenges, part 2: turn on the 15-minute check.
-- Run once in Supabase's SQL editor, AFTER challenges-2026-10-09.sql and
-- AFTER the challenge-tick function is deployed.
--
-- Every 15 minutes, challenge-tick starts challenges, saves finished days,
-- puts people out and ends challenges. This reuses the call your hourly
-- reminders job already makes (same project address and key), pointed at
-- challenge-tick instead - so no key is written in this file.
select cron.schedule(
  'challenge-tick',
  '*/15 * * * *',
  (select replace(command, 'send-reminders', 'challenge-tick') from cron.job where command like '%send-reminders%' limit 1)
);
