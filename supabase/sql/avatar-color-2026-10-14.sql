-- Profile colors (2026-10-14): everyone gets a colored circle with their
-- first letter. The color is saved per account - random to start, and each
-- person can change their own (the existing "Users can update their own
-- profile" policy covers that). Only these 12 names are allowed; the app
-- turns each into its shade.
--
-- Run this BEFORE pushing the app version that reads avatar_color.

create or replace function public.random_avatar_color() returns text
language sql volatile set search_path = '' as $$
  select (array['red', 'orange', 'amber', 'lime', 'green', 'teal', 'cyan', 'blue', 'indigo', 'violet', 'pink', 'graphite'])[1 + floor(random() * 12)::int]
$$;

alter table public.profiles add column if not exists avatar_color text;

-- Everyone who's already signed up gets their own random color.
update public.profiles set avatar_color = public.random_avatar_color() where avatar_color is null;

alter table public.profiles alter column avatar_color set default public.random_avatar_color();
alter table public.profiles alter column avatar_color set not null;

alter table public.profiles drop constraint if exists profiles_avatar_color_check;
alter table public.profiles add constraint profiles_avatar_color_check
  check (avatar_color in ('red', 'orange', 'amber', 'lime', 'green', 'teal', 'cyan', 'blue', 'indigo', 'violet', 'pink', 'graphite'));
