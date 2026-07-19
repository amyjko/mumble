-- The claims helper works (AR-TEST-6). Defined in supabase/seed.sql.
--
-- These three assertions are the foundation every other RLS test stands on, so
-- they are checked before anything trusts them.

begin;
select plan(5);

select tests.auth_as('11111111-1111-1111-1111-111111111111'::uuid, true);
select is(auth.uid(), '11111111-1111-1111-1111-111111111111'::uuid, 'auth.uid() reads the claims blob');
-- The one that catches the documented-but-wrong pattern: setting
-- request.jwt.claim.sub satisfies auth.uid() while leaving auth.jwt() NULL, so
-- every is_anonymous policy would evaluate against NULL and pass for the wrong
-- reason. This assertion fails if the helper ever regresses to that form.
select is((auth.jwt() ->> 'is_anonymous')::boolean, true, 'auth.jwt() is ALIVE, not NULL');
select is(current_setting('role'), 'authenticated', 'not running as postgres, so RLS applies');

select tests.auth_as('22222222-2222-2222-2222-222222222222'::uuid);
select is((auth.jwt() ->> 'is_anonymous')::boolean, false, 'permanent users are is_anonymous false');

-- Signing out is NOT "become anonymous": an anonymous Supabase user holds the
-- `authenticated` role. `anon` is an unauthenticated request. Conflating them
-- would void every anonymous test in the suite.
select tests.logout();
select is(current_setting('role'), 'anon', 'logout lands on anon, which is a different thing');

select * from finish();
rollback;
