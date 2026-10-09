-- Run ONCE in Supabase's SQL editor (2026-10-09).
--
-- Saved progress (user_progress.data) is written as one whole blob by the
-- app. When a phone saved a blob with an empty history over a real one
-- (a failed load taken for a brand-new account), the heat map lost every
-- day. From now on the database itself keeps them: on every update, the
-- workout days (history) and saved routes are MERGED with what was already
-- there, so a save can add days and routes but never remove them.
-- (The app has no way to delete either; deleting an account removes the
-- whole row, which this doesn't touch.)

create or replace function public.keep_progress_history()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  old_days jsonb := case when jsonb_typeof(old.data->'history') = 'array' then old.data->'history' else '[]'::jsonb end;
  new_days jsonb := case when jsonb_typeof(new.data->'history') = 'array' then new.data->'history' else '[]'::jsonb end;
  old_routes jsonb := case when jsonb_typeof(old.data->'routes') = 'array' then old.data->'routes' else '[]'::jsonb end;
  new_routes jsonb := case when jsonb_typeof(new.data->'routes') = 'array' then new.data->'routes' else '[]'::jsonb end;
begin
  new.data := jsonb_set(new.data, '{history}', (
    select coalesce(jsonb_agg(day order by day), '[]'::jsonb)
    from (select jsonb_array_elements(old_days) as day union select jsonb_array_elements(new_days)) days
  ));
  new.data := jsonb_set(new.data, '{routes}', (
    select coalesce(jsonb_agg(route order by route->>'date'), '[]'::jsonb)
    from (select jsonb_array_elements(old_routes) as route union select jsonb_array_elements(new_routes)) routes
  ));
  return new;
end;
$$;

drop trigger if exists keep_progress_history on public.user_progress;
create trigger keep_progress_history
  before update on public.user_progress
  for each row execute function public.keep_progress_history();
