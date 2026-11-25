// Edit handles of the selected element (slice E). Handles live in plan metres; the hit test works in
// screen pixels through a caller-given projection, so it knows nothing about three.js.
import type { Element, Vec2 } from './model.js';

/**
 * corner: a wall point (index = point index). mid: the "+" at a wall segment's midpoint (index =
 * segment). body: the whole wall (index -1, `path` = wall points, `at` = mean of the points).
 * center: an opening's centre on its wall, or a pool/box/item centre (index -1). rotate: the knob of a
 * pool/box/item, 0.5 m beyond its far edge along its rotated +y (index -1). vertex: a slab outline point.
 */
export type HandleKind = 'corner' | 'mid' | 'body' | 'center' | 'rotate' | 'vertex';

export interface Handle {
	/** Id of the element the handle edits. */
	element: string;
	kind: HandleKind;
	index: number;
	/** Plan position. */
	at: Vec2;
	/** body only: the polyline whose screen distance is hit-tested. */
	path?: Vec2[];
}

/** Hit radius in screen pixels by PointerEvent.pointerType; any other type uses mouse. */
export const HIT_PX: Record<'mouse' | 'pen' | 'touch', number> = { mouse: 8, pen: 10, touch: 22 };

/**
 * The handles of one element. Wall: corners (one per point, a closed loop's repeated last point
 * included), mids (one per segment), then body. Opening: center (needs the host wall: pass it as
 * `host`; none without it). Pool/box/item: center, rotate. Slab: one vertex per outline point.
 */
export function handlesFor(el: Element, host?: Element): Handle[] {
	void [el, host];
	throw new Error('not implemented');
}

/**
 * The handle under the pointer: the nearest point handle (all kinds but body) whose projected `at`
 * is within HIT_PX[pointerType] of `pointer`; else a body handle whose projected path is within that
 * radius; else null. `project` maps a plan point to screen pixels.
 */
export function handleAt(handles: Handle[], pointer: Vec2, project: (p: Vec2) => Vec2, pointerType: string): Handle | null {
	void [handles, pointer, project, pointerType];
	throw new Error('not implemented');
}
