-- LOCAL AND CI ONLY. Seeds are applied by `supabase db reset`; they are not
-- migrations and never reach production.
--
-- The pgTAP claims helper lives here rather than in a test file because each
-- test file runs in its own transaction and is ROLLED BACK — a function created
-- in one file does not exist in the next. It must not live in a migration
-- either: test scaffolding in production schema is how a test-only backdoor
-- ships.

create schema if not exists tests;

-- Two rules, both verified against the local stack (TESTING.md §7):
--
-- 1. Set the FULL request.jwt.claims blob, never request.jwt.claim.sub.
--    auth.uid() reads coalesce(request.jwt.claim.sub, request.jwt.claims->>'sub')
--    — either source. auth.jwt() reads coalesce(request.jwt.claim,
--    request.jwt.claims) — ONLY the blob. So the pattern in Supabase's own docs
--    makes auth.uid() work while auth.jwt() returns NULL, and a policy reading
--    auth.jwt()->>'is_anonymous' then evaluates against NULL and passes for the
--    wrong reason. That is the worst kind of green.
--
-- 2. Set `role` explicitly. pgTAP runs as `postgres`, which BYPASSES RLS
--    entirely, so a test that forgets this passes while testing nothing.
create or replace function tests.auth_as(uid uuid, anon boolean default false)
returns void language plpgsql as $$
begin
	perform set_config('role', 'authenticated', true);
	perform set_config('request.jwt.claims', json_build_object(
		'sub',          uid::text,
		'role',         'authenticated',
		'is_anonymous', anon
	)::text, true);
end $$;

-- Signing OUT is not "become anonymous": an anonymous Supabase user holds the
-- `authenticated` role with is_anonymous true. `anon` is an UNAUTHENTICATED
-- request. Two unrelated concepts that share a word, and conflating them would
-- quietly void every anonymous test.
create or replace function tests.logout()
returns void language plpgsql as $$
begin
	perform set_config('role', 'anon', true);
	perform set_config('request.jwt.claims', null, true);
end $$;

-- The helper switches the session to `authenticated`, so every call AFTER the
-- first is made by that role — which has no rights on this schema by default.
-- Without these grants a test can authenticate exactly once and then fails with
-- "permission denied for schema tests", which reads like an RLS problem and is
-- not one.
grant usage on schema tests to anon, authenticated, service_role;
grant execute on all functions in schema tests to anon, authenticated, service_role;
