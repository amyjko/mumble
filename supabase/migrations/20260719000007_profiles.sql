-- Avatar identity that follows the person (UX-ID-6, UX-ID-9, AR-AUTH-1).
--
-- Name and emoji are IDENTITY, not room state: the same person on a laptop and
-- a phone is one identity with one face (UX-ID-6). They lived in localStorage,
-- which made them per-browser — so signing in on a second machine gave you your
-- rooms and objects but a stranger's blank avatar.
--
-- One table for everyone, anonymous included. There is deliberately no branch
-- on `is_anonymous`: an anonymous user has a real auth id, so their profile
-- works exactly the same way — it simply does not roam, because the IDENTITY is
-- browser-bound (AR-AUTH-6), not because the storage is. That boundary is a
-- property of the account, and encoding it twice would be a second definition
-- of it.
create table profiles (
	id uuid primary key references auth.users (id) on delete cascade,
	name text not null check (length(trim(name)) > 0),
	emoji text not null check (length(emoji) > 0),
	updated_at timestamptz not null default now()
);

alter table profiles enable row level security;

-- Your own profile is one of the few things a client may write directly. It
-- carries no room semantics and authorises nothing — unlike room state, where
-- a client write would be a permission decision the server never saw.
revoke all on profiles from anon, authenticated;
grant select, insert, update on profiles to authenticated;
grant select, insert, update, delete on profiles to service_role;

-- Readable by anyone signed in: names and faces are shown to everyone in a
-- room already (they are copied onto the participant row), so hiding the
-- source would protect nothing while breaking prefill.
create policy profiles_select on profiles
	for select to authenticated using (true);

create policy profiles_insert_own on profiles
	for insert to authenticated with check (id = auth.uid());

create policy profiles_update_own on profiles
	for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
