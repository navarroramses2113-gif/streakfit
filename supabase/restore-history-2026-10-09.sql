-- Run ONCE in Supabase's SQL editor (2026-10-09), AFTER keep-history-2026-10-09.sql.
--
-- Puts workout days back into each player's heat map (user_progress
-- history) from the server's own record: every logged day since the
-- camera update (2026-10-05) also made a 'day' post in feed_events, kept
-- for 30 days. Only ADDS days - nothing is removed - so it's safe to run
-- for everyone, and safe to run twice.

update public.user_progress u
set data = jsonb_set(u.data, '{history}', (
      select coalesce(jsonb_agg(day order by day), '[]'::jsonb)
      from (
        select jsonb_array_elements_text(case when jsonb_typeof(u.data->'history') = 'array' then u.data->'history' else '[]'::jsonb end) as day
        union
        select to_char(f.day, 'YYYY-MM-DD') from public.feed_events f where f.user_id = u.user_id and f.kind = 'day'
      ) days
    )),
    updated_at = now()
where exists (select 1 from public.feed_events f where f.user_id = u.user_id and f.kind = 'day');

-- What everyone's heat map holds now, next to their streak.
select p.username,
       jsonb_array_length(u.data->'history') as days_saved,
       s.streak,
       s.last_logged_date,
       u.data->'history' as history
from public.user_progress u
left join public.profiles p on p.user_id = u.user_id
left join public.player_stats s on s.user_id = u.user_id
order by u.updated_at desc;
