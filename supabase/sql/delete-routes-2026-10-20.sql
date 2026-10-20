-- Run ONCE in Supabase's SQL editor (2026-10-20), before the app update.
--
-- Routes can now be deleted (a recording started by accident). The
-- keep-history trigger (keep-history-2026-10-09.sql) merges every saved
-- route back in, so on its own it would undo a delete. Now the app also
-- saves `deletedRoutes` - just {date, durationMs, distanceKm} for each route
-- deleted on purpose, no GPS path - and the trigger drops routes on that
-- list. A bad save (the 2026-10-09 wipe) never adds to the list, so it
-- still can't remove anything. The list itself is merged like history, so
-- an older phone's save can't bring a deleted route back either.

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
  old_gone jsonb := case when jsonb_typeof(old.data->'deletedRoutes') = 'array' then old.data->'deletedRoutes' else '[]'::jsonb end;
  new_gone jsonb := case when jsonb_typeof(new.data->'deletedRoutes') = 'array' then new.data->'deletedRoutes' else '[]'::jsonb end;
  gone jsonb;
begin
  new.data := jsonb_set(new.data, '{history}', (
    select coalesce(jsonb_agg(day order by day), '[]'::jsonb)
    from (select jsonb_array_elements(old_days) as day union select jsonb_array_elements(new_days)) days
  ));
  gone := (
    select coalesce(jsonb_agg(route), '[]'::jsonb)
    from (select jsonb_array_elements(old_gone) as route union select jsonb_array_elements(new_gone)) deleted
  );
  new.data := jsonb_set(new.data, '{deletedRoutes}', gone);
  new.data := jsonb_set(new.data, '{routes}', (
    select coalesce(jsonb_agg(route order by route->>'date'), '[]'::jsonb)
    from (select jsonb_array_elements(old_routes) as route union select jsonb_array_elements(new_routes)) routes
    where not exists (
      select 1 from jsonb_array_elements(gone) as g
      where g->'date' is not distinct from routes.route->'date'
        and g->'durationMs' is not distinct from routes.route->'durationMs'
        and g->'distanceKm' is not distinct from routes.route->'distanceKm'
    )
  ));
  return new;
end;
$$;

-- Check: should return one row, deletes_routes = true.
select position('deletedRoutes' in pg_get_functiondef('public.keep_progress_history'::regproc)) > 0 as deletes_routes;
