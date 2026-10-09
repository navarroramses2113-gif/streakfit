-- Run ONCE in Supabase's SQL editor (2026-10-09).
--
-- A separate database login that can only READ the app's tables, used by
-- Claude (dev-tools/db-read.mjs) to look at real data when something goes
-- wrong. The database itself refuses any change from it: every session
-- is read-only and it has no write grants. It can't see the auth schema
-- (emails, password hashes) - only the app's own tables in `public`.
--
-- BEFORE RUNNING: replace CHANGE_ME below with a long password made of
-- letters and numbers only (no symbols - it goes into a web address).

create role claude_readonly with login password 'CHANGE_ME' bypassrls;

-- Read-only, and no runaway queries.
alter role claude_readonly set default_transaction_read_only = on;
alter role claude_readonly set statement_timeout = '15s';

-- SELECT on the app's tables, now and on tables added later.
grant usage on schema public to claude_readonly;
grant select on all tables in schema public to claude_readonly;
alter default privileges in schema public grant select on tables to claude_readonly;

-- To remove this access at any time:
--   drop owned by claude_readonly; drop role claude_readonly;
