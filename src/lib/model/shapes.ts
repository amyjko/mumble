import type { CanvasObject, Clip, Participant, Placer, Size, SolverShape } from './types';
import { ellipsePoints } from '$lib/canvas/geometry';
import { AVATAR_BORDER } from './avatar';

/**
 * The solver's view of the world: how each kind of thing becomes a shape the
 * overlap rule can test.
 *
 * Moved out of memory-store because the RULE ENGINE needs it and the store now
 * imports the rule engine — leaving these behind would be a cycle. That they
 * sat in a localStorage stub at all was the earlier smell: collision geometry
 * is a product fact, not a storage detail, and the real backend needs exactly
 * the same answers.
 */

/**
 * Whether an object takes part in collision at all (UX-OBJ-12's exemptions).
 *
 * Drawings do not. Ink is annotation: it belongs ON TOP of the things it
 * annotates, and a stroke's axis-aligned bounding box is mostly empty anyway —
 * a diagonal squiggle reserved a huge rectangle. Worse, drawings carry
 * border.width 0, so they got no sticker inset and reserved their FULL box,
 * making them stricter obstacles than notes.
 *
 * One predicate, called from every site, because the rule has to hold on both
 * sides of the seam: exempting only the client would let a drawing be dragged
 * freely and then snap back on commit, and exempting only the store would
 * leave the drag feeling blocked.
 */
export function participatesInCollision(object: CanvasObject): boolean {
	return object.type !== 'drawing';
}

/**
 * The one place a SolverShape is built.
 *
 * The three public `shapeOf*` functions below were independent copies of this
 * record — same nine fields, same order, differing only in where the numbers
 * came from. `SolverShape` is the collider's contract, so adding a field meant
 * editing three sites, and missing one would degrade collision for a single
 * entity class. Collision bugs present as "it snapped back for no reason",
 * which is the kind nobody files.
 *
 * The `circle`/`points` pair is the fragile part: they have to agree, and that
 * invariant was restated three times.
 */
function solverShape(
	id: string,
	x: number,
	y: number,
	size: Size,
	rotation: number,
	clip: Clip,
	border: number
): SolverShape {
	return {
		id,
		x,
		y,
		width: size.width,
		height: size.height,
		rotation,
		circle: clip.shape === 'circle',
		points: outlinePoints(clip),
		border
	};
}

export function shapeOfObject(object: CanvasObject): SolverShape {
	const t = object.transform;
	return solverShape(object.id, t.x, t.y, t, t.rotation, object.clip, object.border.width);
}

/**
 * The clip's outline as percentage points, or undefined for shapes the solver
 * handles directly (a plain rect, or a circle via its exact fast path).
 * Ellipses are tessellated here so the solver never has to know about clips.
 */
export function outlinePoints(clip: Clip): readonly { x: number; y: number }[] | undefined {
	switch (clip.shape) {
		case 'ellipse':
			return ellipsePoints();
		case 'polygon':
			return clip.points;
		default:
			return undefined;
	}
}

/**
 * Solver view of a placer, used only to ask whether anyone is standing in it.
 * A placer never enters the obstacle set itself — it holds no space, so people
 * and content pass through it freely. Borrows the avatar border so "occupied"
 * means the same thing here as it does between two avatars.
 */
export function shapeOfPlacer(placer: Placer): SolverShape {
	return solverShape(placer.id, placer.x, placer.y, placer, placer.rotation, placer.clip, AVATAR_BORDER);
}

export function shapeOfParticipant(participant: Participant): SolverShape {
	// Reads the participant's own size and clip now that avatars are resizable
	// and reshapeable (UX-AV-1) — using the AVATAR_SIZE constant here would
	// have let a resized avatar collide as though it were still the default.
	return solverShape(
		participant.id,
		participant.location.x,
		participant.location.y,
		participant.size,
		participant.rotation,
		participant.clip,
		AVATAR_BORDER
	);
}
