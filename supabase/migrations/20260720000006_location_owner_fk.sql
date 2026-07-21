-- A remembered seat belongs to somebody who still exists (AR-CTRL-6).
--
-- `participant_locations` records where a person sits in a given room and
-- configuration (UX-AV-9). `identity_id` was declared `uuid not null` with no
-- foreign key, so deleting a user — which the anonymous-cleanup job will
-- eventually do in bulk (AR-AUTH-3) — left rows behind forever, keyed to an id
-- nothing can resolve. Nobody noticed because an orphan is invisible: it is
-- never read, since reads are keyed by the identity asking.
--
-- CONTRAST WITH `usage_ledger.identity_id`, which deliberately has NO such key
-- and must not gain one. That column records who was present in a room for the
-- billing trail, and an audit trail has to outlive the identity it describes —
-- cascading it away would delete the evidence along with the guest. The
-- distinction is what each column is FOR: the ledger is a record of the past,
-- a remembered seat is a convenience for the future, and a convenience for
-- somebody who no longer exists is only clutter.
--
-- Orphans are cleared before the constraint is added, because a project whose
-- local database predates this migration will have them and `alter table add
-- constraint` validates existing rows.

delete from participant_locations l
where not exists (select 1 from auth.users u where u.id = l.identity_id);

alter table participant_locations
	add constraint participant_locations_identity_fk
	foreign key (identity_id) references auth.users (id) on delete cascade;
