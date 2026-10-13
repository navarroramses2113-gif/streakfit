-- Walk and run posts in the Feed show the route's shape (2026-10-12).
-- Run once in Supabase's SQL editor, BEFORE deploying the new log-activity
-- (it writes this column; until it exists, walk and run posts would fail).
--
-- `route` is an encoded polyline written only by log-activity, with the
-- first and last 200 m cut off so where a walk starts and ends (usually
-- home) is never stored here. Friends read it through the existing Feed
-- policy, like the rest of the post. Older posts simply have none.
alter table public.feed_events add column if not exists route text check (char_length(route) <= 20000);
