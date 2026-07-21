-- The ledger and the weekly time budget (AR-COST-2, AR-COST-3, AR-COST-4,
-- AR-COST-6, UX-ECON-2).
--
-- The MVP has almost nothing to meter for money: P2P media generates no egress
-- bill, so the only spend at ship is the TURN tail. What this table bounds is
-- therefore not cost but ABUSE — a free product with no meter is a free product
-- somebody parks a bot in. Time is the meter, it is transport-agnostic, and it
-- keeps working unchanged when the SFU arrives (UX-ECON-2).
--
-- WHO PAYS: the room's owner, always, for everybody in the room. A guest holds
-- no account by design (UX-ID-4, "hosts hold accounts; guests need not"), so
-- there is no other coherent answer for their seconds — and splitting the bill
-- between a host and their signed-in participants would mean one meeting debits
-- several ledgers and the join gate has to explain WHICH budget refused you.
-- `rooms.owner_id` is already a non-null FK to auth.users, so this costs no new
-- relationship.
--
-- Written whole now and populated in two waves, as AR-COST-2 asks, so that V2
-- fills columns rather than migrating tables. `billing_cycle` is NOT here: it
-- is V2 entirely, and nothing bills by the gigabyte until an SFU exists.

-- ---------------------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------------------
-- One row per identity, anonymous included. No branch on `is_anonymous`, for
-- the reason profiles gives: an anonymous user has a real auth id and works the
-- same way. An anonymous account simply never owns a room (AR-AUTH-7), so its
-- counter stays at zero — which is a consequence of the rule, not a second
-- statement of it.
create table accounts (
	id uuid primary key references auth.users (id) on delete cascade,
	weekly_seconds_used int not null default 0 check (weekly_seconds_used >= 0),
	-- 10 hours. Per plan, once plans exist; a column rather than a constant so
	-- raising one account's budget is an UPDATE and not a deployment.
	weekly_cap_seconds int not null default 36000 check (weekly_cap_seconds >= 0),
	week_resets_at timestamptz not null default date_trunc('week', now()) + interval '1 week'
);

-- ---------------------------------------------------------------------------
-- usage_ledger
-- ---------------------------------------------------------------------------
-- The append-only audit trail behind the counter. `accounts` answers "may this
-- room admit anyone else this week"; this answers "where did the week go", and
-- the second question is the one that makes a disputed first answer checkable.
--
-- `identity_id` is an addition to AR-COST-2's sketch, and deliberate: with only
-- account_id the trail can say how much the owner spent but never who was in
-- the room, and the guest-attribution rule above is exactly what makes those
-- different questions.
create table usage_ledger (
	id uuid primary key default gen_random_uuid(),
	account_id uuid not null references accounts (id) on delete cascade,
	room_id uuid not null references rooms (id) on delete cascade,
	-- Not an FK to auth.users: an anonymous identity may be cleaned up
	-- (AR-AUTH-3) and taking the audit trail with it would defeat the point of
	-- keeping one. Same reasoning `participant_locations.identity_id` records.
	identity_id uuid not null,
	joined_at timestamptz not null default now(),
	-- Null while the interval is open. It stays null forever when a tab crashes
	-- rather than leaves, which is not a defect: `seconds` is already correct,
	-- because seconds are credited by the beat and never by the difference
	-- between these two timestamps.
	left_at timestamptz,
	seconds int not null default 0 check (seconds >= 0),
	-- V2, null at MVP: [{mode:'p2p'|'sfu', start, end, max_av, est_gb}].
	transport_intervals jsonb,
	-- V2, null at MVP: SFU-interval estimates only.
	est_gb numeric
);

-- The open interval for a person in a room is looked up on every beat, which is
-- the hottest read this table has. Partial, because closed rows are history and
-- are never searched this way.
create unique index usage_ledger_open_idx
	on usage_ledger (room_id, identity_id)
	where left_at is null;

create index usage_ledger_account_idx on usage_ledger (account_id, joined_at);

-- ---------------------------------------------------------------------------
-- An account exists before anyone can be metered
-- ---------------------------------------------------------------------------
-- A trigger rather than an application call, for the reason join_room is a
-- function: the rule is small, entirely about rows, and a metering path that
-- has to remember to create its own account row is a metering path that will
-- one day silently meter nothing.
create or replace function public.create_account_for_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
	insert into accounts (id) values (new.id) on conflict (id) do nothing;
	return new;
end $$;

create trigger users_create_account
	after insert on auth.users
	for each row execute function public.create_account_for_user();

-- Every user who already exists. Without this the trigger only serves accounts
-- created from now on, and every local and CI database — plus every existing
-- room owner — would be unmeterable until they signed up again.
insert into accounts (id) select id from auth.users on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- roll_account — the weekly reset (AR-COST-6)
-- ---------------------------------------------------------------------------
-- AR-COST-6 asks for a scheduled job. This is lazy-on-read instead, and the
-- requirement is amended rather than met — see DESIGN.md. pg_cron is not
-- enabled, and a weekly scan of every account in the service to find that
-- almost none of them used any time is work proportional to the wrong number.
-- Whoever reads an account rolls it, which is the same "whoever is here does
-- the work" logic the heartbeat sweep already chose over a scheduler.
--
-- It is also self-healing in a way a job is not: a cron that fails to fire
-- leaves every account holding last week's total, while a lazy roll cannot be
-- skipped, because nothing can read a stale counter without rolling it first.
--
-- Advances by WHOLE WEEKS to the current one, not by a single week: an account
-- untouched for a month must land on this week's boundary, or the next four
-- reads each roll it once and the budget resets four times in a row.
--
-- `floor(...) + 1`, and the difference from `ceil` is not cosmetic — it was a
-- bug here first. An account exactly N weeks stale is the case ceil gets wrong:
-- it advances the boundary to precisely `now()`, which still satisfies
-- `now() >= week_resets_at`, so the NEXT read rolls it again and zeroes a week
-- of real usage. floor+1 always lands strictly in the future, which is the
-- property this function actually needs and ceil only usually has.
create or replace function public.roll_account(p_account uuid)
returns accounts
language plpgsql
security definer
set search_path = public
as $$
declare
	result accounts%rowtype;
begin
	update accounts set
		weekly_seconds_used = 0,
		week_resets_at = week_resets_at
			+ interval '1 week' * (floor(
				extract(epoch from (now() - week_resets_at)) / extract(epoch from interval '1 week')
			) + 1)
	where id = p_account and now() >= week_resets_at;

	select * into result from accounts where id = p_account;
	return result;
end $$;

-- ---------------------------------------------------------------------------
-- meter_seconds — the credit (AR-COST-3)
-- ---------------------------------------------------------------------------
-- Called by the heartbeat, once per beat per participant. Credits the ROOM
-- OWNER and extends the caller's open ledger row in ONE statement pair, which
-- is the point of putting it here: the counter and its audit trail are written
-- together or not at all. Two round-trips from a route could drift, and a
-- ledger that disagrees with the counter it explains is worse than no ledger.
--
-- Clamping is the CALLER's job, not this function's — the heartbeat knows what
-- a believable interval is (three missed beats), and this knows only how to add.
create or replace function public.meter_seconds(
	p_room uuid,
	p_identity uuid,
	p_seconds int
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
	owner uuid;
begin
	if p_seconds <= 0 then
		return;
	end if;

	select owner_id into owner from rooms where id = p_room;
	if owner is null then
		return;
	end if;

	-- Roll first: seconds earned after a reset boundary belong to the new week,
	-- and crediting before rolling would zero them again on the next read.
	perform public.roll_account(owner);

	update accounts
		set weekly_seconds_used = weekly_seconds_used + p_seconds
		where id = owner;

	insert into usage_ledger (account_id, room_id, identity_id, seconds)
		values (owner, p_room, p_identity, p_seconds)
	on conflict (room_id, identity_id) where left_at is null
		do update set seconds = usage_ledger.seconds + excluded.seconds;
end $$;

-- ---------------------------------------------------------------------------
-- close_ledger_rows — the clean-departure stamp
-- ---------------------------------------------------------------------------
-- Called when someone leaves or is reaped. Purely for the audit trail: it moves
-- no seconds, because the seconds are already credited beat by beat. An
-- interval that never closes is a crash, not a leak.
create or replace function public.close_ledger_rows(p_room uuid, p_identities uuid[])
returns void
language sql
security definer
set search_path = public
as $$
	update usage_ledger set left_at = now()
	where room_id = p_room and identity_id = any(p_identities) and left_at is null;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
alter table accounts enable row level security;
alter table usage_ledger enable row level security;

-- Both halves stated explicitly, as service_grants insists: a privilege model
-- you have to infer from what someone did NOT revoke is one nobody can review.
revoke all on accounts, usage_ledger from anon, authenticated;
grant select on accounts to authenticated;

grant select, insert, update on accounts to service_role;
grant select, insert, update on usage_ledger to service_role;

-- Nobody may write either table from a client, and there is no policy that
-- would let them — metering is a control-plane fact. A client that could add to
-- its own counter could also subtract.
create policy accounts_select_own on accounts
	for select to authenticated
	using (id = auth.uid());

-- No select policy on usage_ledger at all. Nothing renders it, and a room's
-- attendance history is considerably more than reading a budget requires.

-- The metering functions are the control plane's, not the client's. They are
-- SECURITY DEFINER, so leaving them executable by `public` would hand every
-- signed-in browser the ability to credit seconds to somebody else's account.
revoke all on function public.roll_account(uuid) from public;
revoke all on function public.meter_seconds(uuid, uuid, int) from public;
revoke all on function public.close_ledger_rows(uuid, uuid[]) from public;
grant execute on function public.roll_account(uuid) to service_role;
grant execute on function public.meter_seconds(uuid, uuid, int) to service_role;
grant execute on function public.close_ledger_rows(uuid, uuid[]) to service_role;
