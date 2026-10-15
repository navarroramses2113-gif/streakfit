-- In-app nudges (2026-10-15): a nudge is saved even when the friend has
-- no notifications set up, and the pet on their Today says who nudged
-- them. For that the app has to read the nudges sent TO you, not just the
-- ones you sent. Run once in Supabase's SQL editor, BEFORE deploying the
-- new `nudge` function.
--
-- Still read-only for the app: only the server writes nudges.
drop policy if exists "Users can view nudges sent to them" on public.nudges;
create policy "Users can view nudges sent to them" on public.nudges
  for select to authenticated using ((select auth.uid()) = receiver_id);

-- Today's nudges for you: receiver + day.
create index if not exists nudges_receiver_day on public.nudges (receiver_id, day);
