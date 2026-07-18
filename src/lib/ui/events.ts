/**
 * Shared event helpers for controls that live inside draggable canvas objects.
 *
 * A control inside an ObjectFrame must stop its pointerdown from reaching the
 * frame, or pressing the button starts a drag instead. That one-liner was
 * repeated ~15 times across the object components; this is the single copy.
 */

export function stopPointer(event: PointerEvent): void {
	event.stopPropagation();
}
