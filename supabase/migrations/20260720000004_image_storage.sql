-- Image storage (UX-OBJ-5, AR-BACKEND-1).
--
-- The bytes of an uploaded image live here, in Storage — NOT in room_state.
-- Only the reference (the object's `payload.path`) is room state, and it takes
-- the ordinary `create_object` path through the control plane (AR-SYNC-3). The
-- bytes are opaque and go straight to the bucket, gated by the RLS below.
--
-- Private bucket, deliberately: image access must ride the SAME room-membership
-- gate as every other object (see room_objects_select in
-- 20260719000005_state_rls.sql). A public bucket would let anyone holding the
-- URL fetch an image regardless of whether they may see the room — which would
-- make "a pending guest is refused room state and objects" quietly untrue for
-- the one object type whose content lives outside Postgres.
--
-- The path convention is `<room_id>/<uuid>`, so the FIRST path segment is the
-- room the caller must belong to. The `<uuid>` is minted client-side per upload
-- (media/image-upload.ts); it is not the object id, only a unique key.

-- The caps restate model/image.ts, which a migration cannot import — the same
-- cross-boundary duplication DEFAULT_CAPACITY lives with. Keep them in step:
--   MAX_IMAGE_BYTES = 2 * 1024 * 1024 = 2097152
--   ALLOWED_IMAGE_MIME = png, jpeg, webp, gif
-- Bytes and mime are enforced here (a patched client cannot beat the bucket);
-- pixel DIMENSIONS are not (Storage never decodes) — the zod schema caps those
-- at the mutate route. The per-ROOM image count (MAX_IMAGES_PER_ROOM) is a rule
-- engine fact, not a bucket one, since Storage cannot count a room's objects.
-- See model/image.ts for the full split.
--
-- 2 MB is deliberately tight: with no thumbnailing (image_transformation is
-- Pro-tier), every image is a full-bytes download for every viewer, so the cap
-- is what bounds room load.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
	'room-images',
	'room-images',
	false,
	2097152,
	array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
on conflict (id) do nothing;

-- storage.objects already has RLS enabled by the Storage extension; we only add
-- policies. Both are scoped to the bucket AND to membership of the room named by
-- the first path segment. `to authenticated` covers admitted guests too (they
-- are authenticated with an is_anonymous claim) — an image is content anyone
-- present may add, exactly like a note, so no RESTRICTIVE anonymous carve-out is
-- wanted here (contrast rooms INSERT, AR-AUTH-7).

create policy room_images_insert on storage.objects
	for insert to authenticated
	with check (
		bucket_id = 'room-images'
		and public.is_admitted_member(split_part(name, '/', 1)::uuid)
	);

create policy room_images_select on storage.objects
	for select to authenticated
	using (
		bucket_id = 'room-images'
		and public.is_admitted_member(split_part(name, '/', 1)::uuid)
	);

-- No UPDATE and no client DELETE, on purpose. An image is immutable once
-- uploaded (a new picture is a new object), and blob cleanup on delete_object
-- runs with the service role, which bypasses RLS. Orphaned blobs from a create
-- that never landed are an accepted MVP limitation (DESIGN.md UX-OBJ-5).
