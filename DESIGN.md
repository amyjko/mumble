# mumble.studio — a custom-room meeting platform

Mumble is a custom, persistent video room for small group remote or hybrid meetings. The plateform supports a freeform infinite canvas where every element — video tiles, notes, chat, timers, images, drawings — is a movable, resizable, shape-clippable object, backed by a media layer that is peer-to-peer first: small rooms send media directly between participants and cost the operator essentially nothing. An SFU is the paid scale-out path for rooms P2P cannot carry; it arrives later, behind the same transport seam, so that adding scale — or swapping one SFU provider for another — never touches the canvas, the stage, or the control plane.

This document is the consolidated design, restructured as **requirement checklists**: Part I states what the product must be (user experience), Part II states how it is built (architecture). Architecture exists only in service of Part I, and every architecture requirement declares which UX requirements it serves.

---

## How to read this document

- **Requirement format:** `- [ ] **ID** (phase) — statement`. Each is a single testable claim about the product or system.
- **IDs are stable.** Never renumber. Retire a requirement by striking it through with a note; add new ones at the end of their section. Future sessions reference work by ID (e.g., "implement UX-STAGE-2 and its serving AR items").
- **Checkbox = implemented AND covered by a test.** Nothing weaker earns an `[x]` — code with no test is `_PARTIAL_`, because a claim nobody verifies is exactly how `permission` shipped fully implemented and unreachable. Reviewing or editing requirement text does not involve the checkbox.
- **Status tags on unchecked items**, so "not done" carries information:
  - `- [x]` — **done**: implemented and tested.
  - `- [ ] … _PARTIAL: why._` — partly there, or built with no test. The tag says exactly what is missing.
  - `- [ ] … _BLOCKED: needs X._` — waiting on the A/V plane, the Supabase backend, or auth/host role. Not actionable today.
  - `- [ ]` with no tag — **not started**, and nothing external is stopping it.
- **Keep these current as you work.** They were all left unchecked for the first ~30 commits, which made the document say nothing was done when a third of it was. Status re-audited 2026-07-19 after the control plane landed: **77 done · 34 partial · 48 blocked · 11 not started** (170 total).
- **Phases:** `(MVP)` — the shippable single-room product, P2P-only; `(V2)` — next wave (SFU scale-out and its economics, full gallery discipline, emotes, guest upgrade); `(Later)` — houses, proximity audio, whisper.
- **Linking:** architecture requirements end with _serves:_ and a list of UX IDs. This is the alignment check: if an AR item can't name the UX it serves, it's tagged **[NO-UX-LINK]** with a reason (usually developer-experience or operator-facing). A NO-UX-LINK tag means _review this_: either a UX requirement is missing from Part I, or the architecture is speculative.

---

## Vocabulary

- **Room** — a persistent custom space on the canvas with objects, configurations, and capacity limits. Addressed by a globally unique name at `mumble.studio/hey/<name>` (UX-ROOM-8).
- **House** — a collection of rooms on one shared canvas; participants move freely between room regions.
- **Configuration** — a named snapshot of a room's layout (object transforms, defaults, capacity numbers, default location, background, title/description), switchable mid-meeting.
- **Object** — any element on the canvas (video tile, note, chat, timer, image, screen share, drawing); one unified schema.
- **Publisher / subscriber** — a participant currently sending media / receiving it.
- **Slot** — a unit of publish capacity, **not a place and not a type**. A configuration grants `max_av` video slots and `max_audio` audio-only slots; holding one authorizes the corresponding media. Slots have no position, no occupant ordering, and no bearing on where anyone appears on the canvas. Participants take a free slot on demand and queue when none is free (UX-STAGE-3).
- **Stage** — who is currently publishing. There are no named policy categories: the active configuration's capacity numbers define the caps (`max_av = 1` is a turn-taking "conch"; a large `max_av` is a gallery; a small `max_av` with a large `max_participants` is a panel with an audience).
- **Pose** — one object's `{transform, hidden}` within a configuration: where it sits, how big it is, and whether it is shown. A layout is the set of poses (plus background, title, description, capacity, and placers). Distinct from *shape*, which is the object's clip silhouette, and from `SolverShape`, the polygon the overlap solver tests.
- **Newcomer placer** — a numbered, transformable spot in a configuration saying where an arrival appears AND what they look like when they do: whoever lands in one adopts its size, rotation, and clip shape. A host tool, invisible to the people it places, and NOT an object — it holds no space, carries no permission, and never enters an object layout. Arrivals fill the lowest-numbered free placer; occupancy is derived from where people actually are, so leaving frees a spot. ~~Default location~~ — the single unlabelled drop-in point this replaced (2026-07-19): where a participant appeared when they had no remembered location in that configuration (UX-AV-2). It is a draggable marker, not an object, and there is exactly one per configuration.
- **Transport** — P2P (direct peer connections, the MVP) or SFU (server-side forwarding, V2); a room flips between them. Both sit behind one provider-agnostic adapter (AR-TRANSPORT-10).
- **Participant** — someone present in a room, with an avatar on the canvas. Distinct from a *member*: membership is the `room_members` row that persists between visits, presence is being here now. UX-STAGE-11's `max_participants` counts people present, not rows.
- **Guest** — a participant without a permanent account, signed in anonymously (AR-AUTH-1). Guests may do everything in a room except create one (UX-ID-4, AR-AUTH-7); their identity is browser-bound and lost with its storage (AR-AUTH-6).
- **Host** — a participant with the host role; typically the account holder who owns the room, but also any other participant given host privileges.
- **Identity** — stable per-identity id referenced as `creator_id` (Supabase auth user id; anonymous or permanent — see AR-AUTH).
- **Ledger / cap** — per-account time tracking (MVP) and, once the SFU exists, a global egress cap (V2); both enforced at the token endpoint.

---

# Part I — User experience requirements

## 1. The canvas (UX-CANVAS)

A single conceptually-infinite 2D plane; the presentation surface for everything.

- [x] **UX-CANVAS-1** (MVP) — The canvas is an infinite, pannable, zoomable freeform plane; objects sit at arbitrary coordinates.
- [x] **UX-CANVAS-2** (MVP) — The viewport is per-viewer: one person panning/zooming never moves anyone else's view. "Where things are" is shared; "what I'm looking at" is mine.
- [x] **UX-CANVAS-3** (MVP) — Auto-zoom (fit-all) keeps all objects visible and is on by default; any manual pan/zoom disables it until the viewer re-enables it; it recomputes when objects are added, moved, or resized.
- [x] **UX-CANVAS-4** (MVP) — Any object can be scaled to fill the viewer's screen as a per-viewer view state: it mutates nothing for anyone else and does not change the object's fidelity (a fullscreen video renders at its existing resolution). Exiting restores the prior view configuration. This is typically used for making a shared screen full screen
- [x] **UX-CANVAS-5** (MVP) — The canvas background is any CSS background (color, gradient, pattern, image), shared room state persisted per configuration; it is a canvas property, not an object.
- [x] **UX-CANVAS-6** (MVP) — A dot grid sits behind room content as a spatial reference, anchored in world coordinates so it pans and scales with the camera, with level-of-detail so spacing stays legible at any zoom. Decorative: it is exempt from contrast requirements and never announced. — _serves: UX-CANVAS-1..3._

## 2. Objects (UX-OBJ)

Every element in a room is an object with the same interactions, permissions, and persistence, but with different content.

- [x] **UX-OBJ-1** (MVP) — All object types support the same manipulations: move, resize, rotate, shape-clip, delete — one interaction model for a sticky note and a video tile alike.
- [x] **UX-OBJ-2** (MVP) — Notes are shared markdown, collaboratively edited live by multiple participants in real time.
- [x] **UX-OBJ-3** (MVP) — Chat objects hold a message log; messages are room state and retained. A room may have more than one. _Stub deviation (2026-07-18): the in-memory store caps a log at 500 messages because the whole room lives in localStorage, which is finite. The cap is a property of the STUB, not of this requirement — the real backend must not inherit it. Truncation is counted and surfaced rather than silent._
- [x] **UX-OBJ-4** (MVP) — Timers (countdown/count-up) show the same running state and target time to all viewers.
- [ ] **UX-OBJ-5** (MVP) — Images are uploadable with a size cap (dimensions and bytes) and stored by reference.
- [ ] **UX-OBJ-6** (MVP) — Screen shares are objects like A/V tiles, sourced from a screen-capture track; each share is its own object and consumes a video slot from `max_av` (UX-STAGE-1), its source a screen-capture track rather than a camera. _BLOCKED: needs the A/V plane._
- [x] **UX-OBJ-7** (MVP) — Objects can be clipped to shapes: rect, rounded, circle, ellipse, polygon. _Arbitrary path clipping was struck 2026-07-18: because the sticker border width IS the overlap tolerance (UX-OBJ-12), an arbitrary path clip needs an arbitrary-path COLLIDER, not just a renderer — it is a collision-geometry requirement wearing a rendering costume, and it blocked the shape work it was bundled with._
- [x] **UX-OBJ-8** (MVP) — The default them gives every object has a sticker border — a cutout-style edge following its clip shape (a circle-clipped video gets a circular sticker border); room/theme default with per-object override, subject to edit permission.
- [x] **UX-OBJ-9** (MVP) — Objects can be added at any time during a meeting by any participant permitted to create; creation permission is a room setting (default: all may create, hosts may restrict).
- [ ] **UX-OBJ-10** (MVP) — Objects are persistent room state: they survive the meeting and reconnects, retained until deleted. _PARTIAL: reload-survival tested against the stub; durable persistence awaits Supabase._
- [x] **UX-OBJ-11** (MVP) - Drawings are colored SVG paths.
- [x] **UX-OBJ-12** (MVP) — Objects and participants may overlap **only by their sticker borders** (UX-OBJ-8) and no further: content never covers content, so layering never has to be reasoned about. Dragging is constrained to legal positions — the dragged object stops at contact and slides along the boundary rather than being blocked outright. One exemption, which exists to sit on top of content deliberately: drawings (UX-OBJ-11). ~~Anchored objects were a second exemption~~ — struck 2026-07-19: anchoring is dropped, and a drawing that should follow moved content is moved by hand. An object whose border is overridden off (UX-OBJ-8) has zero tolerance: it may touch but not overlap.
- [x] **UX-OBJ-13** (MVP) — Direct manipulation has modifier and reachability affordances: holding Shift while dragging or resizing snaps to a 16px lattice and while rotating snaps to 15°; a transient on-screen hint says so during the gesture. Keyboard arrows use Shift for a FINE 1px step instead, since snapping is meaningless when every press is already a fixed increment. — _serves: UX-OBJ-1, UX-A11Y-2._
- [x] **UX-OBJ-14** (MVP) — Each object type has a minimum size large enough to keep its own controls usable; a hovered or focused object rises above other content, including avatars, so its controls are always reachable. Both exist because overlap is legal up to the sticker border (UX-OBJ-12), which means a control can otherwise sit under something else. — _serves: UX-OBJ-1, UX-OBJ-12, UX-A11Y-2._
- [x] **UX-OBJ-15** (MVP) — Posting to a chat is open participation, not layout editing: anyone present may post regardless of the object's `permission`, which continues to govern moving, resizing, and deleting it. Same spirit as self-initiated emotes (UX-AV-7). — _serves: UX-OBJ-3, UX-PERM-1._

## 3. Permissions (UX-PERM)

- [x] **UX-PERM-1** (MVP) — Each object carries `permission ∈ {host, all, none}` gating who besides the creator may edit/move/resize/clip/delete it: `host` = hosts only, `all` = anyone, `none` = locked to the creator.
- [x] **UX-PERM-2** (MVP) — The creator can always edit or delete their own object, regardless of `permission`. `creator_id` is immutable. Holds for drawings too.
- [x] **UX-PERM-3** (MVP) — Hosts may edit room configurations, admit participants, set creation permissions, and edit/delete `host`-permission objects. Host role is room state, typically the account holder who owns the room.
- [x] **UX-PERM-4** (MVP) — Unauthorized changes never stick: a participant who lacks permission sees their attempted change reverted; other participants never see it as settled state.

## 4. Participants, A/V tiles, and emotes (UX-AV)

Participants have many controls over their avatar.

- [ ] **UX-AV-1** (MVP) — Every admitted participant has an A/V object on the canvas. Whether it streams is governed by which slots they hold (UX-STAGE-3) and the ≥2-present rule (UX-ROOM-1). _PARTIAL: avatar-as-object done and tested; streaming governance and the two-person rule need the A/V plane._
- [x] **UX-AV-2** (MVP) — A participant appears at their remembered location for the active configuration (UX-AV-9). With none — a first visit, or a configuration they've not been in — they appear at that configuration's **default location**: a single draggable marker (not an object) that hosts position like any other element. If the default location is taken, they are placed at the nearest legal position that satisfies UX-OBJ-12. Placement is shared state, as with all objects — everyone sees participants in the same spots. Nothing about placement depends on arrival order, and arriving never displaces anyone.
- [x] **UX-AV-3** (MVP) — Each participant has a custom camera-off emoji shown in their A/V object when their camera is off; audio continues if they hold an audio slot.
- [x] **UX-AV-4** (MVP) — Transient emotes broadcast to everyone, animate, and vanish — never stored. The set is six, each an emoji that floats above the participant's A/V object, and three of which also animate the object itself: **tada** 🎉, **heart** 💜, **laugh** 😂 (float only); **bounce** ⬆️ — a bounce for excitement; **bored** 😴 — a "laying down" tip-over for boredom; **spin** 🌀 — a coin spin for delight. _Amended 2026-07-18: `heart` and `laugh` were shipped but undocumented, and the original text described both bounce and coin-spin as "excitement". Reactions are a burst medium — several may be in flight at once, per participant and across participants._
- [x] **UX-AV-5** (MVP) — Persistent emotes include 1) raise-hand animation that stretches the A/V slot's corner like a hand being raised and makes the corner glow, and 6) a greyscale blur state that indicates that someone stepped away. Persistent emotes persist, even after someone leaves the room. _Amended 2026-07-18: raise-hand is now queue membership (UX-AV-6), and a departing participant is DEQUEUED — so unlike stepped-away it does not survive leaving. A queue holding people who have left would hand slots to absent participants._
- [x] **UX-AV-6** (MVP) — Raise-hand is a presence state that _is_ the slot-request queue entry (UX-STAGE-4): raising enqueues you for the next slot to free up, lowering dequeues. It appears only when the slot you want is unavailable — when one is free you simply take it (UX-STAGE-3), so the queue exists strictly for contention.
- [x] **UX-AV-7** (MVP) — Emotes are always self-initiated: a participant controls only their own A/V object's emotes, independent of object permissions (which govern layout/content, not a person's own expression).
- [ ] **UX-AV-8** (MVP) - As an alternative to emojis, participants can design cute, flat color aesthetics avatars, and emotions on the faces match the emotions conveyed by transient emotes.
- [x] **UX-AV-9** (MVP) — A participant's location is remembered per (identity, room, configuration): returning to a room puts you back where you were the last time you were in that configuration, across sessions and reconnects. Because it is keyed per configuration, your spot in "Standup" is independent of your spot in "Retro". For anonymous participants this rides the per-browser identity (UX-ID-5) and inherits its boundary (AR-AUTH-6).

## 5. Stage: capacity and turn-taking (UX-STAGE)

There are no named stage-policy categories, and slots are not places. A configuration carries three numbers — how many people may be here, how many may send video, how many may send audio — and those numbers alone define the stage. Capacity (a number), placement (a remembered coordinate, UX-AV-2/9), and authorization (an explicit list of who holds what, UX-STAGE-9) are three separate things that must not be fused: fusing them is what made arrival order decide who could speak and made late arrivals displace people.

- [x] **UX-STAGE-1** (MVP) — A configuration defines three capacity numbers: `max_participants`, `max_av` (simultaneous video publishers), and `max_audio` (simultaneous audio-only publishers), with `max_av ≤ max_participants` and `max_audio ≤ max_participants`. Hosts set them live like any configuration state (UX-ROOM-6). They are counts, not positions — nothing about them says where anyone appears.
- [x] **UX-STAGE-2** (MVP) — The numbers _are_ the stage policy; there is no policy enum. `max_av = 1` is a turn-taking "conch" that structurally prevents talking over each other; a large `max_av` is a gallery; a small `max_av` with a large `max_participants` is a panel with an audience. Every arrangement the old Floor/Panel/Gallery categories expressed, and any mix between them, is a choice of three integers.
- [x] **UX-STAGE-3** (MVP) — **Take a free slot; queue when none is free.** Turning the camera on takes a free video slot; unmuting takes a free audio slot. When none is free, raise-hand (UX-AV-6) enqueues you. Holding a video slot also authorizes audio — video implies audio, and never consumes an audio slot to do so. Holding no slot is the ordinary resting state, not an allocation: you are present via avatar and emotes and publish nothing.
- [ ] **UX-STAGE-4** (MVP) — The queue is FIFO. Releasing a slot passes it to the head of the queue: muting releases your audio slot (UX-STAGE-10), turning the camera off releases your video slot, and leaving releases both. A host may grant, revoke, or preempt any slot directly, which is the escape hatch when the queue needs overriding. _PARTIAL: the FIFO queue and handoff are done and tested, and host grant/revoke is now REACHABLE (the role exists) — but it has no UI, so it is exercised only by tests._
- [ ] **UX-STAGE-5** (MVP) — Audio publishers are the video-slot holders **plus** the audio-slot holders, and are further capped to the top 1–3 active speakers, so crosstalk is prevented even when capacity is generous. _PARTIAL: the union rule is done and tested; the "top 1-3 active speakers" cap does not exist._
- [ ] **UX-STAGE-6** (MVP) — Participants holding no slot cannot be seen or heard: publish authorization derives from appearing in a holder list and is a server-enforced fact, not a UI convention; a participant not in a holder list cannot publish by any means. _BLOCKED: needs the A/V plane._
- [ ] **UX-STAGE-7** (V2) — When `max_av` is large and many publishers are active, layouts default to "most tiles small or paused most of the time" (active-speaker focus, thumbnails, paging). A deliberate product constraint (see AR-COST-1 rationale), not incidental styling. _BLOCKED: needs the A/V plane._
- [ ] **UX-STAGE-8** (MVP) — Taking a slot feels instant: the incoming publisher's media appears without a visible connection delay. _BLOCKED: needs the A/V plane._
- [x] **UX-STAGE-9** (MVP) — Who holds what is explicit, never inferred. Each participant's A/V object is annotated with whether they hold a video slot, an audio slot, or neither; the room surfaces the live counts (e.g. "2/3 video · 4/6 audio") and the queue with its order. Scarcity is legible before you bump into it.
- [x] **UX-STAGE-10** (MVP) — Every participant has a mute/unmute control. Unmuting takes a free audio slot (or enqueues per UX-STAGE-3); **muting releases the audio slot**, passing it to the head of the queue. In a room with room to spare this is invisible — you re-take a slot the instant you unmute. In a scarce room it is the point: muting is how the conch gets passed. One exception, following from video-implies-audio (UX-STAGE-3): a participant whose audio comes from a **video** slot has no audio slot to release, so muting silences them and releases nothing — they keep their video slot until the camera goes off. Muting is how you give up audio; camera-off is how you give up video.
- [ ] **UX-STAGE-11** (MVP) — Admission is refused once the room holds `max_participants`; guests awaiting admission (UX-ID-3) do not count against it until admitted. _PARTIAL: full-room refusal done and tested; "guests awaiting admission" stays vacuous until AR-CTRL-5._

## 6. Identity, join, and login (UX-ID)

Low-friction joining; accounts held by hosts, not guests.

- [x] **UX-ID-1** (MVP) — Joining may be anonymous — no account required — but a name is required.
- [ ] **UX-ID-2** (MVP) — A join request includes a short free-text hello message.
- [ ] **UX-ID-3** (MVP) — A host must admit each participant (reviewing name + hello) before they enter; the host may chat with the waiting guest pre-admission via a lightweight channel distinct from in-room chat. The guest waits in a pending state until admitted or declined. _BLOCKED: needs auth and the host role._
- [x] **UX-ID-4** (MVP) — Hosts hold accounts; guests need not. Anonymous guests accrue usage against the host's/room's limits per room policy.
- [x] **UX-ID-5** (MVP) — An anonymous participant's identity is stable per browser: object/drawing ownership survives reconnects in the same browser, and their objects remain theirs if they return (leave-behavior default: objects persist, hosts may always remove).
- [ ] **UX-ID-6** (MVP) — Logging in carries identity and avatars across machines — the same person on laptop and phone is one identity with one set of owned objects. _PARTIAL: signing in on two machines gives ONE identity (the auth user id), which is the hard half — but avatar name and emoji still live in localStorage per browser, so they do not roam yet._
- [ ] **UX-ID-7** (MVP; passkeys Later) — Login offers diverse low-friction options suited to both laptops and phones: email magic link and OAuth at minimum; passkeys when the provider's support is production-ready (AR-AUTH-5). _PARTIAL: magic link is done and tested offline; OAuth providers are configured but untested locally (AR-TEST-8 says the handshake is a prod-only truth)._
- [ ] **UX-ID-8** (V2) — A guest can upgrade to an account without losing anything: their identity, owned objects, and history carry over. _BLOCKED: needs auth and the host role._
- [ ] **UX-ID-9** (MVP) — Avatar data (including the camera-off emoji) works without login (per-browser) and roams with login. _PARTIAL: works without login; the id roams with login, the avatar name/emoji do not — they are still per-browser._

## 7. Rooms and configurations (UX-ROOM)

- [ ] **UX-ROOM-1** (MVP) — Rooms are always open: a room persists and can be entered (subject to admission) at any time. A lone occupant sees the room and its persisted state, but A/V does not stream unless ≥2 people are present. _PARTIAL: the persistent always-enterable room is done; the two-person A/V rule has no implementation._
- [x] **UX-ROOM-2** (MVP) — Rooms and each configuration have their own title and description; switching configuration can re-label the space.
- [x] **UX-ROOM-3** (MVP) — A room may have multiple configurations — named snapshots of layout — switchable during a meeting as a room-state swap all participants see. **A layout is one pose per object — position, size, and visibility**, plus the room's background and title/description. Every object exists in every configuration; configurations differ only in where objects sit, how big they are, and whether they are shown. A hidden object is not deleted — it stays visible to its creator (and, once the role exists, a host) so hiding is reversible, and it holds no space while hidden. _Landed 2026-07-18: a configuration carries its capacity numbers (UX-STAGE-1) AND its default location (UX-AV-2), both re-applied on switch — at which point every participant is re-placed by AR-CTRL-4's rule, so a configuration restores where PEOPLE were in it, not only where objects were._
- [x] **UX-ROOM-4** (MVP) — Editing a configuration requires being switched to it: what you're editing and what participants see are the same thing.
- [x] **UX-ROOM-5** (MVP) — Reset restores all objects in the active configuration to their per-configuration default transforms — a one-action room reset affecting only layout, never content (notes, chat logs persist).
- [x] **UX-ROOM-6** (MVP) — Hosts may edit rooms and configurations at any time, including live during a meeting, synchronized to all participants.
- [ ] **UX-ROOM-7** (MVP) — There is no A/V recording. The only record of a meeting is persisted state (layout, notes, chat logs, drawings); A/V streams are ephemeral and never captured. _PARTIAL: trivially true (no capture code exists) but unverifiable until the A/V plane lands._
- [ ] **UX-ROOM-8** (MVP) — Every room has a **name** that is a valid URL path segment and globally unique across the service, and the room is reachable at `mumble.studio/hey/<name>` — e.g. `mumble.studio/hey/lci`. The name is the room's address: short enough to say out loud, stable enough to put in a recurring calendar invite. _PARTIAL: route and addressability done and tested; global uniqueness needs the database._
- [x] **UX-ROOM-9** (MVP) — Name rules: lowercase letters, digits, `-` and `_`; length 2–32; compared case-insensitively so `LCI` and `lci` are the same room and cannot both exist; and a small reserved list. Because rooms live under the `/hey/` prefix rather than at the root, no room name can ever collide with a top-level route (`/login`, `/api`) — the reserved list only has to cover names used directly under `/hey/`. That containment is the reason to keep the prefix.
- [ ] **UX-ROOM-10** (MVP) — Renaming a room frees the old name immediately for anyone to claim, and old URLs stop resolving. Hosts are warned before renaming that existing links will break. _PARTIAL: the rename warning is done and tested; freeing the old name is NOT implemented — rename copies and the old URL still resolves._
- [x] **UX-ROOM-11** (MVP) — The service has a **landing page** at `/` making one claim — _communication is more than words_ — with a short list of what the room lets people do and exactly ONE prominent action: make a room. It states that joining needs no account, because the person following an invitation is the common case and must not think they have to sign up. Making a room is its own route (`/new`), so account creation has a single place to intercept (AR-AUTH-1); a link to an existing room never passes through either page.

## 8. Houses (UX-HOUSE) — all (Later)

- [ ] **UX-HOUSE-1** (Later) — A house is a single larger canvas on which rooms are bounded regions; participants move freely between rooms — movement is repositioning, never a leave-and-rejoin.
- [ ] **UX-HOUSE-2** (Later) — Which room a participant is "in" is derived from which region contains their position; admission applies at the house boundary on initial entry (per-room admission inside is an open item).
- [ ] **UX-HOUSE-3** (Later) — Visual awareness is continuous: all rooms share one canvas, so nearby-room activity is visible subject to viewport/zoom.
- [ ] **UX-HOUSE-4** (Later) — A house has its own title and description; each room retains its own title, description, configurations, objects, and slots. (Whether houses have house-level configuration snapshots is open.)

## 9. Audio experience (UX-AUDIO)

Three regimes that must compose predictably. Regime 1 (focused stage audio) is UX-STAGE-5/6.

- [ ] **UX-AUDIO-1** (Later) — Proximity audio (houses): audio is audible between rooms, attenuated proportional to canvas distance — ambient awareness that grows on approach and is full when co-located. _BLOCKED: needs the A/V plane._
- [ ] **UX-AUDIO-2** (Later) — Whisper (directed audio): a participant may temporarily direct their audio to one other participant. The group stops hearing the whisperer; for both whisper parties the group's audio ducks (dampened, not silenced) and other voices visually fade; everyone else is unaffected. Releasing restores normal routing and levels. _BLOCKED: needs the A/V plane._
- [ ] **UX-AUDIO-3** (Later) — Whispers are never covert: the target is clearly notified. A consent/abuse model applies (mutual presence required, host disable, opt-out — details open). _BLOCKED: needs the A/V plane._
- [ ] **UX-AUDIO-4** (Later) — Precedence: whisper overrides stage and proximity audio for its participants while active; on release, each returns to the regime their context dictates. Who-is-whispering-to-whom is synchronized while active and never persisted. _BLOCKED: needs the A/V plane._

## 10. Economics as experience (UX-ECON)

The business model is a product feature: cheap modes are genuinely cheap, so the free tier is sustainable rather than subsidized.

- [ ] **UX-ECON-1** (MVP) — The low-bandwidth modes (`max_av = 1` turn-taking rooms, avatar/audio-first rooms, small rooms) are free to use, sustainably for the operator. This is not aspiration deferred to a later phase: the MVP is P2P-only (AR-TRANSPORT-1), so its media carries no egress cost at all beyond the TURN tail (AR-TRANSPORT-8). _BLOCKED: needs the A/V plane._
- [ ] **UX-ECON-2** (MVP) — Each account has a weekly time budget; joining is refused when it's exhausted, and usage is metered reliably even across crashes. Time is transport-agnostic — it is the MVP's only meter, and it keeps working unchanged when SFU arrives. _BLOCKED: needs the Supabase backend._
- [ ] **UX-ECON-3** (V2) — As global spending limits approach, rooms degrade gracefully in escalating steps (lower `max_av` → capped quality → aggressive pausing → audio-only → refuse new expensive rooms) before any hard stop; P2P rooms keep working throughout, and audio-only / `max_av = 1` modes are legitimate standing product options, not just failure states. V2 because there is no spending to limit until SFU exists (AR-TRANSPORT-2). _BLOCKED: needs the A/V plane._
- [ ] **UX-ECON-4** (Later) — Expensive multi-video modes are priced on usage (reference: ~$0.15/participant-hour at 3× markup; per-room monthly tiers). _BLOCKED: needs the Supabase backend._

## 11. Responsiveness and reliability (UX-QOS)

The platform is realtime by nature; distributed participants must experience it as live and continuous.

- [x] **UX-QOS-1** (MVP) — A participant's own actions (moving an object, drawing, reacting) apply instantly — no perceptible round-trip wait; rejected actions revert visibly (UX-PERM-4).
- [ ] **UX-QOS-2** (MVP) — Remote canvas updates feel live: another participant's drags render smoothly and promptly (target: well under ~200 ms perceived end-to-end for same-continent participants; measure intercontinental — AR-BACKEND-7). _PARTIAL: ephemeral deltas are throttled, but the transport is BroadcastChannel, so no latency target is meaningful yet._
- [ ] **UX-QOS-3** (MVP) — Presence-type events (reactions, raise-hand, expressive states) appear near-instantly for everyone. _PARTIAL: reactions propagate and are tested; same stub-transport caveat._
- [ ] **UX-QOS-4** (V2) — Transport flips are invisible: promoting a room from P2P to SFU never shows a subscriber a gap, freeze, or drop. (Stage handoffs have their own MVP requirement — UX-STAGE-8 — because they exist from day one, while flips only exist once there is something to flip to.) _BLOCKED: needs the A/V plane._
- [ ] **UX-QOS-5** (V2) — When a publisher's connection degrades, the room adapts (transport promotion) rather than the call failing or stuttering indefinitely. _BLOCKED: needs the A/V plane._
- [ ] **UX-QOS-6** (MVP) — Joining works on restrictive networks (NATs/firewalls that block direct P2P) — the ~10–15% of connections needing a relay still connect. MVP because the MVP is P2P (AR-TRANSPORT-1): the relay tail is the one media cost the free tier carries, not a V2 concern. _BLOCKED: needs the A/V plane._

## 12. Accessibility (UX-A11Y)

Accessibility is user experience, not compliance paperwork: a meeting product that some participants cannot operate is failing UX-CANVAS/UX-OBJ/UX-STAGE for those people, not merely a checklist. Conformance target: **WCAG 2.2 Level AA**.

- [x] **UX-A11Y-1** (MVP) — The product conforms to WCAG 2.2 AA. Conformance is mechanically enforced where automatable — axe scans in CI (both themes), computed contrast on every design-token pair, compiler accessibility warnings as build failures — and convention-enforced otherwise via STYLE.md's per-component checklist. A criterion neither machine- nor checklist-covered is a bug in the checklist.
- [x] **UX-A11Y-2** (MVP) — Every canvas operation is keyboard-operable: objects and participants are focusable with real names, arrow keys move them **through the same solver and permission gate as dragging** (UX-OBJ-12 and UX-PERM apply identically), and create/edit/delete need no pointer. Keyboard is a first-class input, not a fallback.
- [x] **UX-A11Y-3** (MVP) — The canvas is legible to screen readers: objects expose content as their accessible name (a note reads as its text, a participant as who they are), and transient outcomes — rejected changes (UX-PERM-4's revert), creations, deletions — are announced via a live region. What sighted users see happen, screen-reader users hear happen.
- [x] **UX-A11Y-4** (MVP) — Visual preferences are respected: system/light/dark theme applied before first paint and persisted per browser; `prefers-reduced-motion` disables all non-essential motion. Canvas legibility (auto-zoom state, zoom level) is visible mode, never hidden state.

---

# Part II — Architecture requirements

## 13. Stack (AR-STACK)

- [ ] **AR-STACK-1** (MVP) — Front end and control plane are SvelteKit (latest, Svelte 5) + TypeScript; SvelteKit server routes host the token endpoint, signaling, and all server-authoritative logic. — _serves: foundation for all of Part I (delivery vehicle; see AR-CTRL, AR-SYNC)._ _PARTIAL: SvelteKit and TS are in place, but no server route holds authority — it all lives client-side._
- [x] **AR-STACK-2** (MVP) — The codebase stays compatible with the native TypeScript 7 compiler: plain TS, no compiler plugins, no decorators, no enums or runtime namespaces — erasable syntax only, enforced mechanically by `erasableSyntaxOnly` + `verbatimModuleSyntax` rather than by discipline. **TypeScript 7.0 shipped 2026-07-08**, so this is no longer futureproofing: `tsc --noEmit` runs the native compiler now. The constraint was always on us, not on TypeScript, and we already meet it. The lag is `svelte-check`, which needs the TS6 programmatic API and **crashes outright under TS7** (verified 2026-07-16: `ts.sys` is undefined, because the Go binary does not expose it) — so TS6 and TS7 are installed side by side until 7.1, one for `svelte-check` and one for `tsc`. Node converged on the same rule independently: v26 removed `--experimental-transform-types`, settling permanently on erasable-syntax-only. **[NO-UX-LINK — developer experience/futureproofing.]**
- [x] **AR-STACK-3** (MVP) — Node (Active LTS) is the development, test, and build runtime — **not Bun and not Deno**. The reason is about our stack rather than theirs: AR-TEST-1 commits us to Vitest and Playwright, which are precisely the two tools with the worst Bun support (Vitest's Bun issue has been open ~3 years; Playwright closed Bun compatibility as *not planned*), and we compound them by running Vitest browser mode with the Playwright provider. Deno is ruled out for a different reason — it would mean a prod runtime our tests never exercise, which AR-TEST-10 says we cannot afford. Track the LTS line; the current version and bump date live in `STACK.md`. **[NO-UX-LINK — developer experience.]**
- [x] **AR-STACK-4** (MVP) — pnpm is the package manager, chosen for supply-chain defaults rather than speed: a dependency cooldown on by default (raised to 7 days — 24h is short against real detection windows), blocked exotic sub-dependencies, and symlinked `node_modules` that makes phantom dependencies fail loudly. A small team cannot audit its transitive tree, so the defaults have to do that work. **Do not depend on Corepack** — it is unbundled from Node 25 onward; pin via the `packageManager` field plus the CI action instead. **[NO-UX-LINK — developer experience; supply-chain risk.]**

## 14. Backend platform: Supabase (AR-BACKEND)

**Decision (July 2026):** Supabase is the application backend — Postgres for persisted state and the ledger, Supabase Realtime for sync, Supabase Auth for identity, Supabase Storage for images. Chosen over Firebase primarily on realtime latency for ephemeral fan-out, relational fit for the ledger, first-party SvelteKit support, and the anonymous→permanent identity upgrade path. Full rationale and evidence: [Appendix A](#appendix-a--backend-decision-record-supabase-vs-firebase-july-2026). The backend never carries media (Part I of the media architecture, AR-MEDIA/AR-TRANSPORT, handles A/V).

- [ ] **AR-BACKEND-1** (MVP) — Supabase provides the four backend surfaces: Postgres (objects, rooms, configurations, ledger), Realtime (sync channels), Auth (all identity), Storage (image objects). — _serves: UX-OBJ-10, UX-OBJ-5, UX-ID-1..9, UX-ECON-2._ _PARTIAL: Postgres and Auth are real; Realtime and Storage are not._
- [ ] **AR-BACKEND-2** (MVP) — All ephemeral shared traffic rides Supabase Realtime **Broadcast** (pure WebSocket relay, no database in the hot path): drag-in-progress transform deltas, transient reactions, expressive states, raise-hand, whisper routing state, WebRTC signaling, transport-flip coordination. (Vendor benchmark: median 6 ms, p95 28 ms; independent production reports <50 ms.) — _serves: UX-QOS-1..3, UX-AV-4..6, UX-AUDIO-4._ _PARTIAL: the seam exists and carries the right traffic classes, backed by BroadcastChannel rather than Supabase Broadcast._
- [ ] **AR-BACKEND-3** (MVP) — Supabase **Postgres Changes is never used** for high-frequency sync: it is single-threaded (ordering guarantee) with a throughput ceiling around 64 changes/sec — orders of magnitude below drag rates. This is a standing guardrail. — _serves: UX-QOS-2 (protects it)._ _PARTIAL: trivially honoured (no Supabase data path); nothing enforces it._
- [ ] **AR-BACKEND-4** (MVP) — Persisted mutations flow: client → SvelteKit server route (permission check, AR-SYNC-3) → Postgres write → fan-out to room subscribers via **Broadcast from Database** (`realtime.broadcast_changes()` trigger; vendor benchmark median 46 ms). Ephemeral-first, persist-on-settle: drags stream over Broadcast (AR-BACKEND-2) and commit the final transform on drop. — _serves: UX-OBJ-9..10, UX-ROOM-3..6, UX-PERM-4, UX-QOS-2._ _PARTIAL: the client -> server route -> Postgres half is done and tested; the Broadcast-from-Database fan-out is not written._
- [ ] **AR-BACKEND-5** (MVP) — Drag broadcasts are throttled to ~15–20 Hz with client-side interpolation between updates — both for perceived smoothness and to stay inside Realtime quotas (project ceiling ~2,500 msgs/sec; Free tier 2M msgs/mo & 200 concurrent, Pro 5M & 500 — re-verify, and confirm whether a broadcast to N subscribers bills as 1 or N messages). — _serves: UX-QOS-2, UX-ECON-1._ _BLOCKED: needs the Supabase backend._
- [ ] **AR-BACKEND-6** (MVP) — One private Realtime channel per room (plus a pre-admission channel per waiting guest). Channel-join authorization via RLS _is_ the room admission gate: Supabase checks RLS once at join, not per message, keeping the hot path untaxed. — _serves: UX-ID-3, UX-STAGE-6, UX-QOS-2/3._ _BLOCKED: needs the Supabase backend._
- [ ] **AR-BACKEND-7** (MVP) — The Supabase project region is chosen for the expected participant geography, and intercontinental Broadcast fan-out latency is measured early (Realtime is pinned to the project region; distributed participants pay RTT to it). If measurements violate UX-QOS-2, revisit with edge relays or AR-BACKEND-8. — _serves: UX-QOS-2._ _BLOCKED: needs the Supabase backend._
- [ ] **AR-BACKEND-8** (V2, contingency) — Reserve option: hot `room_state` (capacity numbers, holder lists, queue, transport state) may move to a Cloudflare Durable Object if slot-change latency through Postgres/Broadcast proves inadequate for UX-STAGE-8. Decision deferred until measured. — _serves: UX-STAGE-8, UX-QOS-4._ _BLOCKED: needs the Supabase backend._
- [x] **AR-BACKEND-9** (MVP) — TypeScript types are generated from the Postgres schema (`supabase gen types typescript`) and used end-to-end; local dev runs the full Supabase stack via the CLI. **[NO-UX-LINK — developer experience.]**
- [ ] **AR-BACKEND-10** (MVP) — Room names are enforced in the schema, not just in application code: `rooms.name` is `citext` with a unique index (giving case-insensitive uniqueness for free) plus a `CHECK` constraint for the charset and length rule; reserved names live in a table the same constraint path consults. The room route is `src/routes/hey/[room]/+page.svelte`; a name that does not resolve 404s. — _serves: UX-ROOM-8..10._ _PARTIAL: citext, the unique index, the CHECK and the reserved-names table all exist and are tested; the room route still 404s from the client rule rather than from the database, which lands with the Supabase store._

## 15. Authentication and identity (AR-AUTH)

- [x] **AR-AUTH-1** (MVP) — Supabase Auth is the single identity system. Anonymous guests use `signInAnonymously()` — replacing the previously-planned hand-rolled local-storage identity token — so `creator_id` = the auth user id for guests and account holders alike, one code path. — _serves: UX-ID-1, UX-ID-5._
- [x] **AR-AUTH-2** (MVP) — Anonymous vs. permanent distinctions use the `is_anonymous` JWT claim, and policies that restrict anonymous users are written as **RESTRICTIVE** RLS policies (permissive policies OR together — a documented footgun). — _serves: UX-ID-4, UX-PERM-1._
- [ ] **AR-AUTH-3** (V2) — Guest→account upgrade uses `updateUser()` (email/phone) or `linkIdentity()` (OAuth, requires manual-linking enabled); the user id is preserved, so ownership continuity (UX-ID-8) is free. Conflicts with an existing account require explicit data reassignment; stale anonymous users need a cleanup job (not auto-cleaned). — _serves: UX-ID-8._ _BLOCKED: needs auth and the host role._
- [x] **AR-AUTH-4** (MVP) — Host login: magic link + OAuth through `@supabase/ssr` cookie sessions (server client created in `hooks.server.ts`; session available across load functions, layouts, and server routes). Route guards and permission enforcement are ours to write — the package wires clients, it does not enforce. — _serves: UX-ID-6, UX-ID-7, UX-PERM-3._
- [x] **AR-CTRL-7** (MVP) — Room membership and roles are a table: one `room_members` row per (room, identity), carrying `role ∈ {host, participant}` and `status ∈ {pending, admitted, declined}`. The row is simultaneously the authorization fact UX-PERM-3's host gate reads and the admission fact AR-BACKEND-6's channel-join RLS will consult — one table, so admission and authority cannot disagree. The room's owner receives the first `host` row in the same transaction that creates the room, because a room with no host is unadministrable. `status` is carried at `'admitted'` until AR-CTRL-5 lands, so admission becomes a behaviour change rather than a migration. Joining is a `SECURITY DEFINER` function, not a client insert: clients hold no write privilege on the table. — _serves: UX-PERM-3, UX-ID-3..4, UX-ROOM-6._
- [x] **AR-AUTH-7** (MVP) — Creating a room requires a permanent account; joining does not. Enforced twice, deliberately: as a RESTRICTIVE policy on `rooms` INSERT reading `is_anonymous` (AR-AUTH-2), and as a route guard on `/new` (AR-AUTH-4). The SQL half is the gate — it would still refuse if the guard were deleted; the route half exists to give a good error rather than a database rejection. — _serves: UX-ID-4, UX-ROOM-11._
- [ ] **AR-AUTH-5** (Later) — Adopt passkeys when Supabase's support leaves beta (beta since May 2026: first-factor, discoverable credentials; requires explicit client opt-in; anonymous users must link email/phone before registering one). — _serves: UX-ID-7._
- [ ] **AR-AUTH-6** (MVP) — Accepted limitation, surfaced in UX copy: an anonymous identity is browser/device-bound (lost on sign-out, cleared storage, or another device); cross-device continuity requires upgrading to an account first. — _serves: UX-ID-5, UX-ID-6 (defines their boundary)._ _PARTIAL: true and enforced, but still not surfaced in UX copy._

## 16. Synchronization model (AR-SYNC)

- [ ] **AR-SYNC-1** (MVP) — Shared state is classified into exactly four classes, each with one sync path: _PARTIAL: the four-class split is honoured structurally; every path is the stub rather than the declared one._

  | Class                  | Path                                        | Contents                                                                                                                                                                                                                                                                                                                                                                                    |
  | ---------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Persisted shared       | Postgres + Broadcast-from-DB (AR-BACKEND-4) | object fields (transform, permission, clip, border, payload), drawings, chat logs, timer state, background, configurations, room name, default location, participant locations (AR-CTRL-6), host roles, admission state, titles/descriptions, capacity numbers & slot holders & queue (room_state), ledger/cap state; house metadata, regions, positions (Later) |
  | Ephemeral shared       | Broadcast (AR-BACKEND-2)                    | expressive states, raise-hand, active whisper routing, transport-flip transitional state, drag-in-progress deltas                                                                                                                                                                                                                                                                           |
  | Fire-and-forget events | Broadcast, no ack                           | transient reactions (floating emoji, bounce)                                                                                                                                                                                                                                                                                                                                                |
  | Local, never synced    | client only                                 | camera pan/zoom, auto-zoom flag, scale-to-fill, theme choice, proximity-audio attenuation, ducking levels, selection/hover                                                                                                                                                                                                                                                                                |

  — _serves: UX-CANVAS-2, UX-OBJ-10, UX-AV-4..6, UX-AV-9, UX-ROOM-7, UX-QOS-1..3._

- [x] **AR-SYNC-2** (MVP) — Clients apply optimistic updates and reconcile on authoritative confirmation or rejection (revert on reject). — _serves: UX-QOS-1, UX-PERM-4._
- [ ] **AR-SYNC-3** (MVP) — Every persisted-state mutation goes through the control plane (SvelteKit server route using the service-role client), which enforces UX-PERM before writing; clients hold no write path that bypasses it. Client-side checks exist only for responsiveness. — _serves: UX-PERM-1..4._ _PARTIAL: the route, the rule engine, and the privilege model are done and tested end to end (a guest gets 403 from the SERVER on a host-only mutation); it is not yet the path the UI uses, which is the store swap._
- [x] **AR-SYNC-4** (MVP) — Notes (UX-OBJ-2) use **Yjs**, with updates carried over the room's Broadcast channel and the document persisted into the object payload (base64 alongside a materialized `text` copy for rendering and accessible names). Edits are DELTAS, not whole-text writes, and the receive path MERGES rather than replaces — replacing is what made concurrent editing lossy. Compaction is an open item. — _serves: UX-OBJ-2._

## 17. Media model and stage enforcement (AR-MEDIA)

A room has publishers and subscribers; slot count bounds publishers, subscription rules bound what subscribers receive. Everything below the media plane is transport- and stage-agnostic.

- [x] **AR-MEDIA-1** (MVP) — Publish caps are read directly from the active configuration's capacity numbers, not derived from slot objects and not a policy enum: `MAX_VIDEO_PUBLISHERS` = `max_av`, `MAX_AUDIO_PUBLISHERS` = `max_av + max_audio` (a video-slot holder publishes audio without consuming an audio slot — UX-STAGE-3). Re-read on configuration switch; when a switch lowers a cap, holders beyond the new limit are released to the queue in reverse acquisition order. Publisher count is bounded by capacity, never by room size. — _serves: UX-STAGE-1..6._
- [ ] **AR-MEDIA-2** (MVP) — Publisher authorization is server-authoritative at the token/signaling gate: holding a slot authorizes publishing on whichever transport is active; unauthorized publish attempts are refused on every transport. This single gate enforces the caps, the no-crosstalk guarantee, and (Later) directed-audio routing. Because it sits above the transport adapter (AR-TRANSPORT-10), it is written once and never reimplemented per provider. — _serves: UX-STAGE-6, UX-STAGE-5, UX-AUDIO-2._ _BLOCKED: needs the A/V plane._
- [ ] **AR-MEDIA-3** (MVP) — A single transport-agnostic layer ladder; recommended defaults (tune per product): _BLOCKED: needs the A/V plane._

  ```
  HIGH  ~0.6  Mbps   active speaker / large tile (~480–540p)
  MED   ~0.25 Mbps   medium visible tile
  LOW   ~0.10 Mbps   thumbnail
  AUDIO ~0.02–0.035 Mbps  Opus voice, active speakers only
  ```

  The ladder is the shared vocabulary; each transport expresses it differently, and conflating the two is a real cost bug. **SFU (V2): simulcast** — the publisher uploads every layer once and the SFU picks per subscriber. **P2P (MVP): per-peer encoding** — the publisher sends each peer only the one layer that peer needs. Sending a full simulcast ladder over P2P would multiply the binding constraint (per-publisher uplink, AR-TRANSPORT-1) by the number of layers for no benefit, since there is no forwarder to choose between them. — _serves: UX-ECON-1, UX-STAGE-7._

- [ ] **AR-MEDIA-4** (V2) — Subscribers subscribe only to streams their current layout displays, at the layer matching each tile's rendered size (the canvas↔media seam: tile render size drives the requested layer). Off-screen/backgrounded/idle tiles are paused — a paused stream costs zero egress. Mandatory for any configuration with `max_av > 1` once SFU is live: omitting this raises cost ~5–8×. V2 with the SFU, since the MVP's P2P rooms cap out around `max_av = 2` (AR-TRANSPORT-4) and have little to pause. — _serves: UX-ECON-1, UX-STAGE-7, UX-CANVAS-4._ _BLOCKED: needs the A/V plane._
- [ ] **AR-MEDIA-5** (MVP) — A subscriber never receives more than their layout shows, at no higher quality than tiles render; scale-to-fill requests no higher layer. — _serves: UX-CANVAS-4, UX-ECON-1._ _BLOCKED: needs the A/V plane._
- [ ] **AR-MEDIA-6** (MVP) — Audio is capped to the top 1–3 active speakers. **Selection** is control-plane and transport-agnostic — one implementation, one source of truth (in houses, generalizes to distance-and-count-bounded selection — AR-MEDIA-7). **Enforcement** is per-transport, and is exactly the kind of difference AR-TRANSPORT-10 exists to absorb: on SFU (V2) the forwarder simply doesn't forward unselected speakers; on P2P (MVP) there is no forwarder, so unselected publishers gate their own track at the source. Both refuse at the AR-MEDIA-2 gate, so neither is a UI convention. — _serves: UX-STAGE-5._
- [ ] **AR-MEDIA-7** (Later) — Proximity audio selects contributing streams server-side with an audible-distance cutoff and max-contributing-speakers cap per listener, plus voice-activity gating — distant inaudible streams are never sent (client-side attenuation alone still pays egress). Client applies the distance→volume curve. — _serves: UX-AUDIO-1._ _BLOCKED: needs the A/V plane._
- [ ] **AR-MEDIA-8** (Later) — Whisper is a routing/mix change, not an extra stream (bandwidth-neutral): A's audio routes to B only; A and B's receive mixes duck the group. Authorized at the AR-MEDIA-2 gate; state synchronized while active per AR-SYNC-1. — _serves: UX-AUDIO-2..4._ _BLOCKED: needs the A/V plane._

## 18. Transport (AR-TRANSPORT)

Two interchangeable WebRTC backends carry the same layer ladder (AR-MEDIA-3); a room flips between them. **P2P is the MVP and ships alone; the SFU is the V2 scale-out.** Both live behind one adapter (AR-TRANSPORT-10), which is what makes the SFU additive rather than a rewrite — and what makes one SFU provider replaceable by another.

- [ ] **AR-TRANSPORT-1** (MVP) — P2P path: publishers open direct peer connections and send per-peer encoded copies (AR-MEDIA-3); media never touches service infrastructure (~zero cost except the TURN tail, AR-TRANSPORT-8). Viable only when both stage and room are small — binding constraint is per-publisher uplink (`layer_bitrate × subscribers`). This is the whole MVP media plane: it is why UX-ECON-1 is a fact at ship rather than a promise. — _serves: UX-ECON-1, UX-STAGE-2._ _BLOCKED: needs the A/V plane._
- [ ] **AR-TRANSPORT-2** (V2) — SFU path: each publisher uploads its simulcast layers once and the SFU fans out per-subscriber layers, decoupling publisher uplink from room size. **The requirement is an SFU, not a vendor.** Cloudflare Realtime is the first intended implementation of AR-TRANSPORT-10, chosen on price (see AR-COST-1), not an assumption the rest of the system may encode. — _serves: UX-STAGE-2, UX-QOS-5, UX-ECON-4._ _BLOCKED: needs the A/V plane._
- [ ] **AR-TRANSPORT-3** (MVP) — **The seam.** Capacity and stage logic, slot authorization, signaling, subscription logic, active-speaker selection, ledger, and caps are written once against the AR-TRANSPORT-10 interface and know nothing about which transport is live; the flip is a localized media-plane operation. This is the requirement that has to hold from the first commit even though its payoff (the SFU) is V2 — retrofitting a seam after provider specifics have spread through the control plane is the failure this exists to prevent. — _serves: UX-QOS-4 (flip invisibility depends on the seam being narrow), UX-ECON-1._
- [ ] **AR-TRANSPORT-4** (V2) — Size/stage promotion trigger (predictive), evaluated on publisher changes: _BLOCKED: needs the A/V plane._

  ```
  worst_publisher_uplink = HIGH_layer_mbps * (room_size - 1)      # conservative
  promote_on_size = worst_publisher_uplink > MAX_P2P_UPLINK_MBPS  # default 6
     OR active_video_publishers > MAX_P2P_PUBLISHERS              # default 2
  ```

  P2P is only for `max_av = 1` or `max_av ≈ 2` configurations in small rooms. Until this ships, the MVP has no promotion path — see the Open item on whether `max_participants` should be bounded by the same uplink math. — _serves: UX-QOS-5, UX-ECON-1._

- [ ] **AR-TRANSPORT-5** (V2) — Connection-quality promotion trigger (reactive) via `getStats()` (sample ~2 s, evaluate ~6 s); promote if any publisher sustains: packet loss >5%, RTT >300 ms, send bitrate <70% of target >4 s, encoder drops >10%, or ICE disconnected/looping. — _serves: UX-QOS-5._ _BLOCKED: needs the A/V plane._
- [ ] **AR-TRANSPORT-6** (V2) — Flip state machine `P2P → PROMOTING → SFU` is make-before-break: publishers establish SFU sends while P2P stays live; subscribers switch render source per stream once SFU media is confirmed; only then tear down P2P. If promotion stalls, keep P2P and retry — never tear down the working path first. — _serves: UX-QOS-4._ _BLOCKED: needs the A/V plane._
- [ ] **AR-TRANSPORT-7** (V2) — Promote-and-stay is the default (one-directional flip). Demotion, if ever, requires hysteresis (fit with margin, sustained >60 s, ≤1–2/session). — _serves: UX-QOS-4 (stability over thrash)._ _BLOCKED: needs the A/V plane._
- [ ] **AR-TRANSPORT-8** (MVP) — TURN relay (Cloudflare TURN at $0.05/GB sharing the free pool, or self-hosted coturn ~$5/mo) serves the ~10–15% of connections that can't go direct; budgeted as a cushion on both paths. With a P2P-only MVP this is the _only_ media spend the product carries at ship, which makes the relay fraction the single number worth watching early. — _serves: UX-QOS-6, UX-ECON-1._ _BLOCKED: needs the A/V plane._
- [ ] **AR-TRANSPORT-9** (MVP) — Taking a slot pre-warms the incoming publisher's connection a beat before the visible grant; handoff renegotiation is independent of the transport flip, and on P2P means establishing peer connections to current subscribers before the grant lands. — _serves: UX-STAGE-8._ _BLOCKED: needs the A/V plane._
- [ ] **AR-TRANSPORT-10** (MVP) — **The media-provider adapter.** One interface, implemented per transport: publish/unpublish a track at a given layer, subscribe/unsubscribe at a layer, pause/resume a subscription, per-peer connection lifecycle, and a normalized connection-stats surface (feeding AR-TRANSPORT-5). P2P is the first implementation; an SFU is the second; a different SFU is a third that changes nothing above the line. **The standing rule: no consumer of this interface may name a provider.** Provider identifiers, SDKs, and vendor-shaped concepts live inside an implementation and nowhere else — that constraint is what AR-TRANSPORT-3 means operationally and what makes "swap the SFU" a contained change instead of an audit. — _serves: UX-ECON-1, UX-QOS-4, UX-ECON-4._

## 19. Control plane (AR-CTRL)

- [ ] **AR-CTRL-1** (MVP) — SvelteKit server routes own the control plane: token endpoint, publisher authorization, signaling, admission, ledger and caps. Transport- and stage-agnostic; none of it moves to P2P. — _serves: UX-STAGE-6, UX-ECON-2..3, UX-ID-3._ _BLOCKED: needs the Supabase backend._
- [ ] **AR-CTRL-2** (MVP) — Room state is authoritative and shaped as: _PARTIAL: the room_state shape is implemented exactly and heavily tested, but it is client state, not authoritative Postgres._

  ```
  room_state {
    room_id
    max_participants  int               -- from the active configuration (UX-STAGE-1)
    max_av            int               -- ≤ max_participants
    max_audio         int               -- ≤ max_participants; audio-only slots
    video_holders     participant_id[]  -- |video_holders| ≤ max_av
    audio_holders     participant_id[]  -- |audio_holders| ≤ max_audio
    queue             participant_id[]  -- raise-hand / slot-request queue, FIFO
    transport         'p2p' | 'promoting' | 'sfu' | 'demoting'   -- non-'p2p' values V2
  }
  ```

  Holder lists are **explicit, not derived** — they are the authorization fact (AR-MEDIA-2) and the thing UX-STAGE-9 renders. The one subtle rule, worth stating because it is easy to get backwards: a video-slot holder publishes audio too, so audio publishers = `video_holders ∪ audio_holders`, and `max_audio` bounds only `audio_holders` — the audio-only crowd. Capacity comes from the active configuration; **position lives nowhere in this structure** (see AR-CTRL-6) — that separation is the point. Stored in Postgres (AR-BACKEND-1), with AR-BACKEND-8 as the latency contingency. — _serves: UX-STAGE-1..6, UX-STAGE-9..11, UX-AV-6._

- [ ] **AR-CTRL-3** (MVP) — The ≥2-present rule is enforced by the control plane: no media session is established for a lone occupant (per room region in a house). — _serves: UX-ROOM-1, UX-ECON-1._ _BLOCKED: needs the A/V plane._
- [ ] **AR-CTRL-4** (MVP) — Placement resolution runs server-side (authoritative) to avoid arrival races, in one order: remembered location for this configuration (AR-CTRL-6) → the configuration's default location → nearest legal position satisfying UX-OBJ-12. A remembered location is re-validated on entry, not trusted: the layout may have changed since, so an illegal remembered spot falls through to the same search. The search algorithm (strategy, spacing) is an open item. — _serves: UX-AV-2, UX-AV-9._ _PARTIAL: the three-step rule, re-validation, and re-placement are done and thoroughly tested; "runs server-side (authoritative)" is not true — it runs in each client._
- [ ] **AR-CTRL-5** (MVP) — The admission flow (pending state, hello message, pre-admission chat, admit/decline) is control-plane state with its own Broadcast channel per waiting guest (AR-BACKEND-6). Admission also enforces the `max_participants` gate (UX-STAGE-11). — _serves: UX-ID-2..3, UX-STAGE-11._ _BLOCKED: needs auth and the host role._
- [ ] **AR-CTRL-6** (MVP) — Remembered participant locations are a table keyed on the triple, separate from both objects and room_state: _PARTIAL: the keyed record is done and tested; not a table, no updated_at, no cleanup._

  ```
  participant_locations {
    identity_id, room_id, configuration_id   -- composite PK
    x, y
    updated_at
  }
  ```

  Written on drop alongside the object transform (AR-BACKEND-4), read at entry and on configuration switch (AR-CTRL-4). Keyed per configuration so a spot that suits one layout never leaks into another (UX-AV-9). Rows for anonymous identities are subject to the same cleanup as their auth users (AR-AUTH-3). — _serves: UX-AV-9, UX-AV-2._

## 20. Cost model and enforcement (AR-COST)

**The MVP has almost nothing to meter for money.** P2P media (AR-TRANSPORT-1) generates no egress bill; the only media spend at ship is the TURN tail (AR-TRANSPORT-8). So this section splits along the transport phase: **the weekly _time_ budget is MVP** (transport-agnostic, and the thing that actually bounds abuse of a free product), while **everything measured in gigabytes is V2**, arriving with the SFU that makes gigabytes cost money. The schema below is written whole up front so V2 populates columns rather than migrating tables.

Once the SFU exists: the media provider bills purely on usage and never hard-caps spend; the in-app ledger and caps are the real ceiling.

- [ ] **AR-COST-1** (V2) — Egress is always computed from the rendered layout, never from publisher count. **The standing rule applies from day one even though the arithmetic is V2:** any cost reasoning that starts from "N publishers × full bitrate" is wrong by ~5–8× and must never reach a plan or a pricing page. _BLOCKED: needs the Supabase backend._

  ```
  per_subscriber_down_mbps = Σ over visible tiles (layer_bitrate for that tile)
                             + received_audio_streams * audio_bitrate
  room_egress_mbps         = subscriber_count * per_subscriber_down_mbps
  room_egress_gb_per_hour  = room_egress_mbps * 3600 / 8 / 1000
  ```

  Reference (12 people, retail $0.05/GB): naive 12×1 Mbps ≈ $3.35/room-hr — never plan with this; tiered gallery (1 high + 4 med + 6 low) ≈ $0.60; active-speaker focus ≈ $0.43; speaker view ≈ $0.47. The ~5.5× gap _is_ AR-MEDIA-4. Only SFU-mode intervals cost money — which is why the MVP's bill is the TURN tail and nothing else. — _serves: UX-ECON-1, UX-ECON-4._

- [ ] **AR-COST-2** (MVP for `accounts`; V2 for the GB surfaces) — The ledger lives in Postgres. Written whole now, populated in two waves, so V2 is additive: _BLOCKED: needs the Supabase backend._

  ```
  accounts {                     -- MVP
    id
    weekly_seconds_used   int
    weekly_cap_seconds    int   default 36000 (10 h; per plan)
    week_resets_at        timestamp
  }
  usage_ledger {                 -- append-only audit trail; MVP writes time, V2 fills the rest
    id, account_id, room_id
    joined_at, left_at, seconds           -- MVP
    transport_intervals   jsonb  -- V2: [{mode:'p2p'|'sfu', start, end, max_av, est_gb}]
    est_gb                numeric -- V2: SFU-interval estimates only
  }
  billing_cycle {                -- V2 entirely: nothing bills by the gigabyte until the SFU exists
    gb_used_this_cycle    numeric
    gb_cap                numeric -- budget/0.05 + free tier; e.g. $10 → 1200
    cycle_resets_at       timestamp
  }
  ```

  — _serves: UX-ECON-2 (MVP), UX-ECON-3 (V2)._

- [ ] **AR-COST-3** (MVP for seconds; V2 for `est_gb`) — Metering on join and on leave plus a ~15 s heartbeat for crash safety. The heartbeat is MVP: seconds must survive a crash regardless of transport. `est_gb` computed for SFU intervals from a per-room representative layout profile (conservative by design) is V2. — _serves: UX-ECON-2._ _BLOCKED: needs the Supabase backend._
- [ ] **AR-COST-4** (MVP for the time gate; V2 for the GB gate) — Gates at the token endpoint: **(MVP)** refuse a join when `weekly_seconds_used ≥ weekly_cap_seconds`; **(V2)** refuse new SFU-bound rooms and promotions when projected `gb_used_this_cycle` would exceed `gb_cap`. Guests accrue against host/room limits (UX-ID-4). — _serves: UX-ECON-2..3._ _BLOCKED: needs the Supabase backend._
- [ ] **AR-COST-5** (V2) — Degradation ladder as the cap approaches, in escalating severity: (1) lower `max_av`, then `max_audio`, releasing surplus holders to the queue in reverse acquisition order (AR-MEDIA-1); (2) cap layers at MED; (3) more aggressive pausing / fewer visible tiles; (4) audio-only (~30× cheaper); (5) refuse new SFU rooms/promotions (P2P rooms unaffected); (6) hard stop at the true ceiling. — _serves: UX-ECON-3._ _BLOCKED: needs the Supabase backend._
- [ ] **AR-COST-6** (MVP for the weekly roll; V2 for the cycle roll) — Scheduled jobs (pg*cron or Supabase scheduled functions) roll `weekly_seconds_used` (MVP) and `gb_used_this_cycle` (V2) at their reset times. — \_serves: UX-ECON-2.* _BLOCKED: needs the Supabase backend._
- [ ] **AR-COST-7** (V2) — Monthly, reconcile ledger `est_gb` against the provider invoice and tune the safety margin and layout profiles. V2 because there is no egress invoice to reconcile against until the SFU ships. **[NO-UX-LINK — operator-facing accuracy loop.]** _BLOCKED: needs the Supabase backend._
- [ ] **AR-COST-8** (V2) — An out-of-band provider budget alert (~80% of budget) acts as a drift tripwire — it notifies but never enforces. **[NO-UX-LINK — operator-facing tripwire.]** _BLOCKED: needs the Supabase backend._
- [ ] **AR-COST-9** (MVP) — Watch the TURN relay fraction and its GB from the first week (AR-TRANSPORT-8). It is the MVP's only media spend, it is assumed at ~10–15% of connections (UX-QOS-6) on no evidence yet, and it is the one number that could falsify "P2P is near-free" before the SFU ever lands. **[NO-UX-LINK — operator-facing tripwire; protects UX-ECON-1.]** _BLOCKED: needs the Supabase backend._

## 21. Front-end canvas implementation (AR-CANVAS)

- [x] **AR-CANVAS-1** (MVP) — Every object is a normal DOM node on a single transformed "world" layer inside a container; pan/zoom mutate the container transform (`translate` + `scale`), never the objects. A `<video>` bound to a MediaStream is just another node. — _serves: UX-CANVAS-1..3, UX-OBJ-1, UX-AV-1._
- [x] **AR-CANVAS-2** (MVP) — Move/resize/rotate are CSS transforms on the node; shape clipping is CSS `clip-path`. The sticker border follows the clip shape by carrying the SAME percentage clip-path on both the sticker layer and the content layer: percentages resolve against each element's own box, and the content sits inside the sticker's padding, so one string describes both silhouettes and the visible border is the ring between them. — _serves: UX-OBJ-1, UX-OBJ-7..8._
- [ ] **AR-CANVAS-3** (MVP) — One polymorphic schema for all objects; type-specific data in `payload`: _PARTIAL: the schema is implemented as specified and now persisted as rows; the av/screenshare/image variants await the A/V plane and image storage._

  ```
  CanvasObject {
    id                 string        stable unique id
    type               'av' | 'note' | 'chat' | 'timer' | 'screenshare' | 'image' | 'drawing'
    creator_id         identity_id   immutable (AR-AUTH-1)
    permission         'host' | 'all' | 'none'
    transform          { x, y, width, height, rotation, z }
    clip               { shape: 'rect'|'rounded'|'circle'|'ellipse'|'polygon', params }
    border             { style }     sticker border (every object has one)
    payload            object        type-specific
    created_at, updated_at
  }
  ```

  — _serves: UX-OBJ-1..11, UX-PERM-1..2, UX-ROOM-5._

- [ ] **AR-CANVAS-4** (MVP) — DOM-on-a-transformed-canvas is scoped to room-scale content (tens to low-hundreds of objects, several live videos). Define and measure the object-count/drawing-complexity budget on target devices; virtualize or rasterize static layers past the ceiling. — _serves: UX-QOS-1..2 (keeps interactions smooth at target scale)._ _PARTIAL: one frame-budget test exists; no object-count budget is defined, measured, or virtualized._
- [x] **AR-CANVAS-5** (MVP) — The overlap constraint (UX-OBJ-12) is solved in two places for two different reasons. **Client, every frame of a drag:** a legal-position solver runs locally so the constraint feels like contact rather than lag (UX-QOS-1) — the dragged node stops at the boundary and slides along it. **Server, on drop:** the committed transform is re-validated with the same rule (AR-SYNC-3) and an illegal position is rejected, reverting per UX-PERM-4. The server pass is not redundant: two participants dragging into the same gap can both pass their own client check, and only the server sees both. Collision tests the clip shape's geometry rather than the raw bounding rect — a circle-clipped tile must not reserve its corners, or round objects would repel each other at a distance. Drawings skip the solver entirely (UX-OBJ-12). — _serves: UX-OBJ-12, UX-AV-2, UX-QOS-1._

## 22. Design system (AR-STYLE)

- [x] **AR-STYLE-1** (MVP) — All color, type, spacing, radius, and elevation values are design tokens defined once in `src/app.css` (CSS custom properties; colors via `light-dark()` so each token carries both themes in one declaration). **No raw color literals outside app.css** — mechanically enforced by a test that scans every component. The canvas-background token is the *default* that UX-CANVAS-5's per-configuration background will override; the sticker and note colors are deliberately theme-invariant (the cutout aesthetic is the product — UX-OBJ-8). — _serves: UX-A11Y-1, UX-A11Y-4, UX-OBJ-8._
- [x] **AR-STYLE-2** (MVP) — Theme choice is local-only state (AR-SYNC-1 class 4): `data-theme` on the document root (absent = follow the system via `color-scheme`), persisted per browser, applied by a pre-paint inline script so no flash of the wrong theme is ever visible. — _serves: UX-A11Y-4._
- [x] **AR-STYLE-3** (MVP) — The accessibility enforcement stack runs in CI: WCAG contrast ratios computed from the token file for every declared pair in both themes; axe (wcag2a/wcag2aa/wcag22aa) against real pages in both themes; Svelte's compiler accessibility warnings promoted to failures. What automation cannot judge is owned by STYLE.md's per-component checklist. — _serves: UX-A11Y-1..3 (protects them)._

## 23. Testing (AR-TEST)

**There is no staging environment** — only local and prod, deliberately, to control cost. The local Supabase stack therefore _is_ the pre-production environment, which loads more weight onto local fidelity than a three-environment project would carry. The corollary is AR-TEST-10: what local cannot prove has to be named out loud, because a green suite that is silent about its blind spots reads as confidence it has not earned.

Test requirements mostly _protect_ UX rather than deliver it, so they use the `(protects it)` idiom already established by AR-BACKEND-3. Mechanics — versions, config, commands, and the gotchas behind each rule — live in `TESTING.md`, which is expected to churn; these requirements are what must stay true.

- [x] **AR-TEST-1** (MVP) — Vitest is the test runner, configured as two projects: a **client** project matching `*.svelte.{test,spec}.ts` and a **server** project (node) matching `*.{test,spec}.ts`. The filename convention _is_ the routing mechanism between them. **[NO-UX-LINK — developer experience.]**
- [x] **AR-TEST-2** (MVP) — The whole stack runs offline against the Supabase CLI (`supabase start`) with no network connection after the first image pull: Postgres, Auth, Realtime, Storage, and a local SMTP catcher. **Supabase CLI ≥ 2.108.0 is a hard floor** — earlier versions fetch a remote Deno import on every start and simply do not work offline. **[NO-UX-LINK — developer experience.]**
- [x] **AR-TEST-3** (MVP) — Component tests run in a **real browser** (Vitest browser mode, Playwright provider) and never in jsdom. This is not a style preference: jsdom has no layout engine, returns **zeros** from `getBoundingClientRect()`, and never computes CSS transforms. Since AR-CANVAS-1 puts every object on a CSS-transformed world layer, jsdom would test every drag delta, hit-test, and screen↔world conversion against zeros — passing while proving nothing about the arithmetic most likely to be wrong. — _serves: UX-OBJ-12, UX-CANVAS-1..4, UX-QOS-1 (protects them)._
- [x] **AR-TEST-4** (MVP) — Coordinate and capacity logic is tested as pure rune logic in `.svelte.ts` modules, with no DOM. This constrains the source, not just the tests: screen↔world conversion, hit-testing, the legal-position solver (AR-CANVAS-5), and the capacity/queue rules (AR-MEDIA-1, AR-CTRL-2) must stay extractable from the components that render them. — _serves: UX-OBJ-12, UX-CANVAS-1..3, UX-STAGE-1..5 (protects them)._
- [x] **AR-TEST-5** (MVP) — RLS is tested **behaviorally** with pgTAP via `supabase test db`, covering the matrix of `permission × role × creator × anonymous` (UX-PERM-1..2). Behavior, not metadata: pgTAP can assert which policies exist, but the AR-AUTH-2 footgun is a fact about how policies _combine_ — a permissive policy silently OR-ing away a restriction is invisible to any metadata assertion and visible only to a query that should have returned nothing and didn't. — _serves: UX-PERM-1..4, UX-ID-4..5 (protects them)._
- [x] **AR-TEST-6** (MVP) — The pgTAP claims helper is **ours and vendored**, and sets the **full `request.jwt.claims` JSON blob** — never `request.jwt.claim.sub`, which satisfies `auth.uid()` while leaving `auth.jwt()` NULL and would make every `is_anonymous` policy pass for the wrong reason. It sets `role` explicitly, and every RLS test asserts its own effective role before asserting anything else: pgTAP runs as `postgres`, which **bypasses RLS entirely**, so a test that forgets this passes while testing nothing. We deliberately do **not** depend on `basejump/supabase-test-helpers` — dormant since Dec 2023, and structurally unable to set `is_anonymous` — despite Supabase's own docs recommending it. — _serves: UX-PERM-1..4 (protects them)._
- [x] **AR-TEST-7** (MVP) — A thin real-JWT suite (Vitest + supabase-js against local Supabase) proves that **Auth actually emits the `is_anonymous` claim** on a real `signInAnonymously()`. AR-TEST-5's pgTAP matrix asserts our _assumption_ about the claim; only a real sign-in proves the assumption holds. This seam — between what we believe the token contains and what it contains — is precisely where a silent failure of the whole anonymous permission model would live, and it is structurally invisible to pgTAP. — _serves: UX-ID-1, UX-ID-4..5, UX-PERM-1 (protects them)._
- [ ] **AR-TEST-8** (MVP) — Auth flows are tested offline: `signInAnonymously()` directly; magic link by generating the link server-side and verifying the token hash, needing no email scraping; and one test through the local SMTP catcher covering the email template path itself. **OAuth is not tested locally** — no mock provider exists in the CLI and real providers require network. Instead the callback handler is unit-tested in isolation and OAuth identities are admin-minted so downstream code sees a realistic session; the provider handshake itself is a prod-only truth (AR-TEST-10). — _serves: UX-ID-1..3, UX-ID-6..7 (protects them)._ _PARTIAL: signInAnonymously and the magic-link/token-hash path are done and run in CI (e2e/support/auth.ts mints a real link); the Mailpit template pass and the isolated OAuth callback unit test are not written._
- [ ] **AR-TEST-9** (MVP) — End-to-end tests use Playwright, driven against **the built worker running in workerd** (`wrangler dev`), never against the Node dev server. That target is not incidental: per AR-DEPLOY-4 it is the only place the production runtime gets exercised, so pointing E2E at `vite dev` for convenience would quietly void the parity guarantee. Multi-participant is one browser with fake-media-device flags plus **one context per participant**: two peers join a room and both video elements are asserted live. This is the only layer that exercises the P2P path (AR-TRANSPORT-1) and Realtime signaling together, and the only one that can catch a stage handoff that renders but never connects. **Chromium only** — fake media devices are unsupported on WebKit. — _serves: UX-QOS-1..3, UX-STAGE-3..6, UX-STAGE-8, UX-ROOM-1 (protects them)._ _PARTIAL: Playwright against wrangler dev is done; multi-participant shares one browser context, and there are no fake media devices yet._
- [ ] **AR-TEST-10** (MVP) — **What local cannot prove is written down.** With no staging, a green local suite is not evidence for: NAT traversal or the TURN relay fraction (loopback between local contexts never leaves the machine — AR-TRANSPORT-8, AR-COST-9, UX-QOS-6); intercontinental Broadcast latency (AR-BACKEND-7, UX-QOS-2); Realtime quota and message-counting semantics (AR-BACKEND-5); real OAuth provider handshakes (AR-TEST-8); and real egress cost (AR-COST-1, V2). Each carries a named owner and a first-week-in-prod measurement, and the list is reviewed whenever a requirement it touches is checked off. Every item here is already an Open item — this requirement exists so they are read as _untested_ rather than merely unfinished. **[NO-UX-LINK — protects UX-ECON-1 and UX-QOS-2/6 from false confidence.]** _PARTIAL: the blind-spot list exists in Open items and CI comments; no owners and no measurement plan._

## 24. Deployment (AR-DEPLOY)

The host is chosen on the same criterion as the media plane: **the free tier has to be genuinely free, or UX-ECON-1 is a slogan rather than an economic fact.** Cloudflare wins on cost and on consolidation — it already carries TURN (AR-TRANSPORT-8), the V2 SFU (AR-TRANSPORT-2), and the Durable Object contingency (AR-BACKEND-8) — but it is a bet with two measurable limits, and AR-DEPLOY-3 exists so the bet is settled early and cheaply rather than late and expensively.

- [x] **AR-DEPLOY-1** (MVP) — The app deploys to Cloudflare Workers via the SvelteKit Cloudflare adapter. The runtime is **workerd, not Node** — Node APIs exist only under a compatibility flag with a current compatibility date. Verified 2026-07-16 against a real worker: both Supabase client libraries load and serve under workerd, with SSR and an API route returning 200. Chosen because the free tier is genuinely free at our scale and permits commercial use, and because it collapses four Cloudflare dependencies into one vendor and one bill. — _serves: UX-ECON-1 (the free tier is the product's economics)._
- [ ] **AR-DEPLOY-2** (MVP) — Push to `main` deploys to production; pull requests get preview deployments. Deploys are gated on the full CI suite: a red suite never reaches prod. With no staging (AR-TEST-10), this gate is the only thing standing between a bad commit and users. — **[NO-UX-LINK — developer experience.]** _PARTIAL: CI gates on the full suite; the deploy job is inert until secrets exist, and there are no preview deployments._
- [x] **AR-DEPLOY-3** (MVP) — **The Workers ceilings stay budget constraints, tracked in CI.** The free tier allows a 3 MB compressed bundle and 10 ms CPU per invocation. **Measured 2026-07-16: a SvelteKit worker carrying `@supabase/supabase-js` and `@supabase/ssr` uploads at 234 KiB gzipped — 7.6% of the cap.** The bundle is therefore not a risk, and this requirement exists to keep it one: CI asserts the compressed size and a regression fails the build, exactly as egress is computed from rendered layout rather than hoped about (AR-COST-1). CPU time excludes waiting on the network — a slow Postgres query costs nothing here; only real JS execution does. — _serves: UX-ECON-1 (protects it)._
- [x] **AR-DEPLOY-4** (MVP) — **The tests run in workerd, even though the dev server does not.** AR-TEST-10 makes local the only pre-production environment, so nothing may ship on a runtime no test has exercised. SvelteKit's Cloudflare path gives no way to run the HMR dev server in workerd — verified 2026-07-16: `@cloudflare/vite-plugin` officially supports only TanStack Start and React Router, and the SvelteKit scaffold's `vite dev` runs on Node. So the seam is drawn where it can actually hold: `vite dev` on Node is an inner-loop convenience and **nothing is verified there**, while E2E (AR-TEST-9) and CI run against the built worker under `wrangler dev` in real workerd. Every claim this project makes about production behavior comes from the workerd path. — _serves: UX-QOS-1..3 (protects them from a class of bug that would otherwise only appear in prod)._
- [ ] **AR-DEPLOY-5** (MVP) — **The host is swappable, and nothing above the adapter may name it.** This is AR-TRANSPORT-10's provider-neutrality rule applied to hosting: Workers-specific concepts — KV, Durable Object bindings, `platform.env` — live behind a boundary, and the control plane knows only that it has a request and an environment. The named fallback is a Node server (~$2/mo, no bundle or CPU ceiling, exact local/prod parity), and switching to it must stay a change of adapter and boundary implementation, never an audit. — _serves: UX-ECON-1._ _PARTIAL: vacuously satisfied — no platform.env usage anywhere — but no boundary module enforces it._
- [ ] **AR-DEPLOY-6** (MVP) — Production secrets live in the host's secret store and in CI, never in the repository. Local and production use the same API-key style (publishable/secret, not the legacy anon/service-role names) — with no staging, a key-shape difference between environments is a bug that can only surface in front of users. — _serves: UX-ID-4, UX-PERM-3 (protects them)._ _PARTIAL: naming and .env.example are right; no host secret store or CI secrets configured yet._

---

## Build order (by requirement ID)

> **Deviation (2026-07-17):** canvas core (step 2) proceeds ahead of the control plane (step 1), behind a `RoomStore` seam — the third application of the AR-TRANSPORT-10 provider-neutrality idiom, after transport and host. The in-memory store models latency, rejection, permission checks, and the commit-side overlap pass, so AR-SYNC-2/UX-PERM-4/AR-CANVAS-5 behavior is real from day one; the Supabase-backed store is the seam's second implementation and lands with step 1. Nothing stub-backed checks a checkbox.

0. **Harness and the hosting bet** — AR-STACK-3..4 (runtime, package manager), AR-TEST-1..2 (the runner and the offline Supabase stack), and **AR-DEPLOY-3's spike, which gates AR-DEPLOY-1**: measure the compressed bundle against 3 MB and SSR against 10 ms CPU *before* the host is committed to. A failed spike selects AR-DEPLOY-5's fallback and costs a day; the same discovery after the control plane is written costs a rewrite. Confirm AR-DEPLOY-4 here too — if the dev server won't run in workerd, the parity argument for this host is gone and the answer changes. Everything after this step is built and tested against these choices.
1. **Control plane core** _(largely landed 2026-07-19: schema, RLS + pgTAP, auth, the host role, and the rule-engine extraction that lets the server enforce the same rules as the client. Outstanding: the Supabase-backed store and the mutation route, which carry canvas state — AR-BACKEND-4/6, AR-SYNC-3.)_ — AR-CTRL-1..2, AR-COST-2..3 skeleton (time only), AR-BACKEND-1, AR-BACKEND-10 (rooms are addressable before anything else can be visited), AR-AUTH-1..2, and **AR-TEST-5..7 in the same step**: RLS policies and the tests that prove they combine correctly are one deliverable, not two — AR-AUTH-2's footgun is invisible to review and visible only to a behavioral test. Testable without media.
2. **Canvas core** — AR-CANVAS-1..3, AR-SYNC-1..3, AR-BACKEND-2..6; non-media objects first (UX-OBJ-2..5, UX-OBJ-11, UX-PERM-1..4, UX-CANVAS-1..5). Land AR-CANVAS-5 (UX-OBJ-12) here, with the first draggable object — the overlap rule is a property of dragging, and retrofitting it after layouts exist means relitigating every one. AR-TEST-3..4 land with it: the first drag is also the spike that proves browser-mode can drive pointer capture at all.
3. **Transport seam, then P2P** — AR-TRANSPORT-3 and AR-TRANSPORT-10 **first**, then AR-TRANSPORT-1 as the first implementation behind it, plus AR-TRANSPORT-8 (TURN) and AR-MEDIA-3/AR-MEDIA-5. The seam precedes its first implementation deliberately: an interface written after the fact is shaped by whatever leaked through it. Measure the TURN relay fraction (AR-COST-9) as soon as real connections exist.
4. **Capacity & turn-taking** — AR-MEDIA-1..2 with `max_av = 1` first (UX-STAGE-2 — the conch is the simplest real stage and exercises the whole gate), then larger caps, the FIFO queue, and mute-releases-slot (UX-STAGE-3..4, UX-STAGE-10); wire UX-AV-6 (raise-hand = queue entry) and UX-STAGE-9 (holders are visible) as one fact each.
5. **A/V objects, placement, identity/join** — UX-AV-1..3, UX-AV-9, AR-CTRL-4..6, UX-ID-1..7, UX-STAGE-11, AR-AUTH-4, AR-AUTH-6, AR-TEST-8..9 (auth flows; two-peer E2E once step 3's P2P path exists).
6. **Time metering and the join gate** — AR-COST-3..4 (time halves), AR-COST-6 (weekly roll), AR-MEDIA-6, UX-ECON-2, AR-DEPLOY-6 (production secrets). **This closes the MVP** — with AR-TEST-10's list written down and owned, so the prod-only truths are known unknowns rather than surprises.
7. **SFU + promotion + flip** (V2) — AR-TRANSPORT-2 as the _second_ implementation of AR-TRANSPORT-10, then AR-TRANSPORT-4, AR-TRANSPORT-6..7, starting with promote-and-stay. Validate AR-COST-1 against real egress on a test room before more UX. If this step touches anything above the seam, AR-TRANSPORT-3 has failed and that is the bug to fix first.
8. **Egress accounting and degradation** (V2) — AR-COST-1, the GB halves of AR-COST-2..4/6, AR-COST-5, AR-COST-7..8, UX-ECON-3.
9. **Configurations** — UX-ROOM-3..5 (if not landed in step 2).
10. **Quality trigger** (V2) — AR-TRANSPORT-5; demotion only if needed.
11. **Later phase** — UX-HOUSE-_, UX-AUDIO-_, AR-MEDIA-7..8, AR-AUTH-5. Prototype audio-regime interactions early even though they ship late; audio-routing bugs are subtle.

**MVP definition:** every requirement tagged (MVP) checked — a P2P-only product whose media costs the operator nothing but the TURN tail. **V2:** SFU scale-out and everything that only matters once gigabytes cost money (egress accounting, GB caps, the degradation ladder), plus disciplined gallery, emotes, guest upgrade. **Later:** houses, proximity audio, whisper, passkeys.

---

## Open items

**Backend/platform:**

- Measure real-world Broadcast latency from target regions, especially intercontinental (AR-BACKEND-7); decide whether AR-BACKEND-8 (Durable Object for hot room_state) is needed.
- Verify Supabase Realtime message-counting semantics (1 vs N per broadcast) and current per-tier quotas; model room-hour message costs (AR-BACKEND-5).
- ~~Choose the CRDT provider for notes (AR-SYNC-4).~~ **Resolved 2026-07-18: Yjs**, the provider AR-SYNC-4 already named. Rationale and measured bundle cost in [STACK.md](STACK.md#dependency-exceptions); the integration is contained to `model/ydoc.ts`.
- **Persistence/compaction for note documents (AR-SYNC-4) — now live, not hypothetical.** A note stores its full Yjs state, and deletions leave tombstones, so a heavily-edited note's stored size grows with its EDIT HISTORY rather than its text. The stub keeps whole documents in localStorage with no compaction, which is fine at prototype scale and is not fine with a real backend. Needs a decision on snapshot-and-truncate vs. server-side GC before AR-BACKEND lands.
- **Permission granularity for streamed edits (AR-SYNC-4 × UX-PERM-4).** Permission is checked once per `edit_note` mutation, at the boundary, and the whole update is rejected if it fails. That is coherent today because an update is committed per keystroke-batch. It does NOT extend to a future where ops stream continuously: a mid-stream rejection has no meaningful revert, since UX-PERM-4's "visibly reverted" assumes a discrete change to undo. Options are per-session gating at editor open, or accepting that permission changes take effect only on the next session. Surfaced deliberately rather than being settled by whoever implements streaming first.
- Track Supabase passkeys to GA (AR-AUTH-5); design the guest→email/phone→passkey upgrade ladder.
- Stale anonymous-user cleanup job (AR-AUTH-3).

**Stage / capacity:**

- **Implemented 2026-07-18 as control plane only.** The capacity/slot/queue state machine is `model/stage.ts`, pure and node-tested per AR-TEST-4, with the store calling into it once per mutation. What remains A/V-blocked is only *media authorization* (UX-STAGE-5/6/8, AR-MEDIA-2): holding a slot means you MAY publish, and nothing yet publishes. Two decisions the spec left open were taken and are pinned by tests: someone who leaves is **dequeued**, and lowering `max_participants` **never evicts anyone** — the gate applies to new admissions only, because removing a person because a host changed a number is a worse failure than a briefly over-capacity room.
- ~~`mode: 'moderated'` is carried but has no MVP semantics.~~ **Dropped 2026-07-18.** It named nothing anyone could point at, and its only implementation was an invention of mine. A field that carries no agreed meaning is not neutral — it invites a reader to implement whatever they assume it meant. If moderation is wanted later it should arrive with its semantics written first.
- **Mute releases the audio slot unconditionally** (UX-STAGE-10) — even with an empty queue, so someone else may take it before you unmute. Intended when `max_audio` is scarce (that _is_ the conch) and invisible when capacity exceeds attendance. Confirm it isn't hostile in the middle case; the alternative is releasing only when someone is waiting, which is friendlier but makes "do I still have the floor?" depend on invisible state.
- Whether `max_participants` should be bounded directly by AR-TRANSPORT-4's uplink math, or whether that math should merely _suggest_ a ceiling to the host. With P2P as the MVP and no SFU to promote to, per-publisher uplink is the real limit on room size and nothing currently stops a host setting `max_participants` past what P2P can carry.
- Reverse-acquisition-order release when a configuration switch lowers a cap (AR-MEDIA-1, AR-COST-5): confirm "last to take it, first to lose it" is the fairest rule, and what the displaced person sees.

**Rooms / URLs:**

- Redirect-on-rename vs. the hard 404 currently specified (UX-ROOM-10).
- Squatting and name disputes in a flat global namespace (UX-ROOM-8): claim expiry for abandoned rooms, and whether a name should be released when a room is deleted or held for a grace period.
- Houses (Later) and the URL scheme: `/hey/<house>/<room>` vs. flat room names inside a house (UX-HOUSE-1).

**Media / cost:**

- **Measure the TURN relay fraction early** (AR-COST-9). The ~10–15% figure (UX-QOS-6) is assumed, not measured, and it is the MVP's only media cost — if it is materially higher, UX-ECON-1's "near-free" claim is wrong at ship, not at V2.
- Re-confirm Cloudflare Realtime pricing and free tier (assumed $0.05/GB, 1,000 GB/mo, July 2026) — V2 input, not an MVP blocker.
- Per-peer encoding on P2P (AR-MEDIA-3): confirm the layer-per-peer approach against real browsers, and what a publisher does when two subscribers want different layers — one encode per distinct layer, not per peer.
- Confirm SFU simulcast per-subscriber layer-selection API (Cloudflare Realtime; LiveKit if self-hosting) and how tile render size maps to the requested layer.
- Confirm whether Durable Objects (if AR-BACKEND-8 triggers) pushes onto Workers Paid and whether that fits budget.
- Calibrate `MAX_P2P_UPLINK_MBPS` (6) and `MAX_P2P_PUBLISHERS` (2) against real connection data; validate `getStats()` fields across target browsers.
- Establish per-room layout profiles and the `est_gb` safety margin from the first month's invoice (AR-COST-7).
- Measure the real paused/off-screen fraction in the actual gallery UX — it decides whether AR-COST-1's favorable numbers hold.

**Canvas / front-end:**

- ~~"Layout" now means two different things.~~ **Resolved 2026-07-19**: *layout* is the saved configuration, the word the product uses; the per-object `{transform, hidden}` record is a **pose**. Not "shape", which was the first proposal and would have been a third meaning alongside `clip.shape` (the silhouette) and `SolverShape` (the collision polygon) — all three would have appeared in the same expressions. "Pose" stretches slightly in carrying `hidden`, accepted as the price of a word that collides with nothing.

- ~~`anchor` is specified but does not exist.~~ **Struck 2026-07-19**, the same way arbitrary path clips were (UX-OBJ-7). It was specified in three places and implemented in none — the `permission` trap again. Dropped rather than built: a drawing that should follow moved content gets moved by hand, which is a small cost against a feature that would have to define what happens when the target is deleted, hidden, resized, or rotated.

- ~~Rotated-handle resize operates on world axes and ignores rotation.~~ **Accepted 2026-07-18 as intended behavior**, not a defect to fix. Rotated-shape COLLISION is exact (SAT/OBB); only the drag-to-resize math is world-axis, which is a UX approximation nobody has been bothered by. Documented in `canvas/resize.ts` so it stays a decision rather than reading as an oversight.

- Define the object-count and drawing-complexity budget; measure on target devices (AR-CANVAS-4).
- Decide anonymous-creator object leave-behavior default and host controls (UX-ID-5).
- Specify the legal-position solver (AR-CTRL-4, AR-CANVAS-5): the contact-and-slide algorithm, spacing, collision geometry per clip shape, and the search order when the default location is taken.
- **Concurrent-drag overlap race** (AR-CANVAS-5): two participants can drop into the same gap having each passed their own client-side check; the server rejects the loser, whose object snaps back. Confirm the revert reads as fair rather than arbitrary — this is the one place UX-OBJ-12 and UX-QOS-1 genuinely pull against each other.
- ~~Whether a remembered location (UX-AV-9) should survive a host rearranging the configuration around it.~~ **Implemented 2026-07-18 as re-validate-and-fall-through**, per AR-CTRL-4's own wording: a remembered spot that is no longer legal is not trusted, and entry falls through to the nearest legal position rather than dropping someone onto content. It no longer forgets silently: being re-placed is announced through the live region, so the move is accounted for without vision too (`model/placement.ts`, `wasDisplaced`).
- Set image size caps and the storage/serving path (UX-OBJ-5, Supabase Storage).
- ~~Decide configuration-switch semantics for objects present in one config but not another (hide vs remove from view).~~ **Resolved 2026-07-18** by dissolving the question rather than answering it: every object exists in every configuration, and a configuration records position, size, and VISIBILITY per object (UX-ROOM-3). Nothing is ever removed, so "present in one config but not another" cannot arise. Hidden objects hold no space and stay visible to their creator. Per-configuration capacity numbers and default location both landed 2026-07-18, so this item is fully closed.
- ~~Sticker-border rendering against arbitrary path clips (AR-CANVAS-2).~~ **Resolved 2026-07-18** by striking arbitrary paths (UX-OBJ-7). Border-follows-clip is implemented and regression-tested for the shapes that remain.
- ~~Define the emote set and per-emote animation approach (UX-AV-4..7).~~ **Resolved 2026-07-18**: the set is enumerated in UX-AV-4 with one source of truth in `model/emotes.ts`, and each animation is specified there. Persistent emotes (UX-AV-5) are the raise-hand corner stretch with glow, and the greyscale-blur away state.

**Houses / audio (Later):**

- Precise proximity-audio model: distance→volume curve, cutoff, max contributors, focus↔awareness transition on region crossing.
- House-level configuration snapshots: yes/no (UX-HOUSE-4).
- Room-region geometry, membership from position, boundary/overlap behavior.
- House admission: boundary-only vs per-room; hello/pre-admission chat mapping.
- Whisper consent/abuse model (UX-AUDIO-3).

---

## Status of cost numbers

**Every egress figure in this document is a V2 number.** The MVP is P2P-only (AR-TRANSPORT-1): its media generates no egress bill at all, and its only media spend is the TURN tail (AR-TRANSPORT-8, watched via AR-COST-9). The SFU cost model matters for deciding _when_ to build V2 and how to price it (UX-ECON-4) — not for shipping.

When it does apply: cost figures assume Cloudflare Realtime SFU pricing of **$0.05/GB egress with a 1,000 GB/month free tier** (verified July 2026) and the AR-MEDIA-3 layer rates. That pricing is an input to the numbers, not a commitment to the vendor — AR-TRANSPORT-10 exists so a better rate elsewhere is a contained change. Supabase quota/pricing figures (AR-BACKEND-5) are from official docs as of July 2026 but were not independently verified — re-check before cost modeling; these _do_ apply at MVP, since sync runs from day one. A naive "everyone receives every stream at full bitrate" model overstates cost ~5–8× and must never be used for planning — always compute from rendered layout (AR-COST-1). No provider hard-caps spend; the in-app ledger and caps (AR-COST-2..5) are the real ceiling.

---

## Appendix A — Backend decision record: Supabase vs Firebase (July 2026)

**Decision:** Supabase. Deep-research pass (July 15, 2026; primary sources, adversarially verified claims) on realtime speed, developer UX, platform evolution, and authentication.

**Realtime speed (decisive).** The latency-critical traffic here is ephemeral (AR-SYNC-1), and Supabase Broadcast is a no-database WebSocket relay: vendor benchmarks median 6 ms / p95 28 ms at 224k msgs/sec ([benchmarks](https://supabase.com/docs/guides/realtime/benchmarks)); private channels check RLS at join only. Broadcast-from-Database (Apr 2025) adds persisted-state fan-out at median 46 ms ([announcement](https://supabase.com/blog/realtime-broadcast-from-database)). Firestore's own docs document distance-dependent single-region listener latency, document-size-sensitive propagation, and a ~1 write/sec-per-document contention limit ([queries at scale](https://firebase.google.com/docs/firestore/real-time_queries_at_scale), [best practices](https://firebase.google.com/docs/firestore/best-practices)) — each in direct conflict with drag-frequency updates — and Firestore has no ephemeral channel (every event is a billed write). Firebase's fast option (RTDB) is its most stagnant product and would force a two-store split. Caveats: Supabase numbers are vendor benchmarks; Realtime is region-pinned (AR-BACKEND-7). Supabase's legacy Postgres Changes is single-threaded, ~64 changes/sec — hence AR-BACKEND-3.

**Developer UX.** First-party `@supabase/ssr` SvelteKit support (verified across three official docs pages) vs no first-party Firebase SvelteKit SSR story; schema-generated TS types vs hand-maintained `withConverter`; full local stack via CLI. Refuted claim, worth remembering: the Supabase SvelteKit docs wire up clients but do **not** provide auth enforcement — route guards and permission checks are ours (AR-AUTH-4, AR-SYNC-3).

**Evolution.** Firebase is active but investing in new surfaces (Data Connect GA Apr 2025 → renamed "SQL Connect" Apr 2026; Firestore Enterprise/MongoDB-compat GA Aug 2025) rather than the classic realtime-listener path — adopting it means the documented Firestore constraints or a one-year-old Postgres product. Supabase ships on exactly this project's needs (Broadcast-from-DB 2025, passkeys beta May 2026); $500M Series F at ~$10.5B (June 2026, TechCrunch, single source); open-source Postgres = exit path.

**Authentication.** Near parity in breadth; Supabase's anonymous sign-in maps 1:1 onto the guest model with an id-preserving upgrade path (AR-AUTH-1..3) and RLS-visible `is_anonymous`; passkeys beta (May 2026) fits UX-ID-7 once GA. Firebase Auth mature but maintenance-mode; its passkey status was not verifiable from primary sources.

**Authorization.** Lower-stakes than usual because enforcement is server-authoritative (AR-SYNC-3) — but per-object `{host, all, none}` + creator override is trivial RLS against real columns, and channel-join RLS doubles as the admission gate (AR-BACKEND-6). The relational ledger (AR-COST-2) is native SQL.

**Standing risks:** vendor-benchmark optimism; single-region fan-out for intercontinental rooms; message-counting/cost semantics unverified; passkeys API churn while beta; notes CRDT still unchosen.
