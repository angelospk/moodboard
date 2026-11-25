// One drag of a handle, from press to release (slice E). The session computes preview models and
// never commits them; it calls `commit` once, on end, with the final model. The viewport draws the
// previews as ghosts. A second pointer or cancel() ends the session without a commit.
import type { Handle } from './handles.js';
import type { HouseModel, Vec2 } from './model.js';

/**
 * The model after dragging `handle` from plan point `start` to `to`, or null when the drag op
 * refuses it. Maps handle kinds to drag.ts ops: corner → moveWallPoint, mid → insertWallPoint at the
 * segment midpoint then moveWallPoint(index + 1), body → moveWall(to − start), center → moveOpening
 * (opening) or movePlaced(old centre + to − start), rotate → rotatePlaced (angle of `to` around the
 * centre, knob on local +y at 0°), vertex → moveSlabPoint.
 */
export function applyDrag(model: HouseModel, handle: Handle, start: Vec2, to: Vec2): HouseModel | null {
	void [model, handle, start, to];
	throw new Error('not implemented');
}

export interface DragPreview {
	/** The model as it would be after this drag (the last valid one when the op refused the move). */
	model: HouseModel;
	/** True when the drag op refused the move, or hidesOpening(original, model). */
	invalid: boolean;
	/** Ids of elements that differ from the original model (for a partial ghost rebuild). */
	affected: string[];
}

export interface DragSessionOptions {
	/** The committed model when the drag started. Never mutated. */
	model: HouseModel;
	handle: Handle;
	pointerId: number;
	/** Plan point of the press. */
	start: Vec2;
	/** Called once, from end(), with the final model. Never called by move() or cancel(). */
	commit: (next: HouseModel) => void;
	/** Snaps each pointer point before the drag op; default: none. */
	snap?: (p: Vec2) => Vec2;
	/** Drag op; default applyDrag. Tests inject a fake. */
	apply?: (model: HouseModel, handle: Handle, start: Vec2, to: Vec2) => HouseModel | null;
}

export class DragSession {
	constructor(opts: DragSessionOptions) {
		void opts;
		throw new Error('not implemented');
	}

	/** True after cancel(), a second pointer, or end(). */
	get done(): boolean {
		throw new Error('not implemented');
	}

	/** Another pointer pressed: cancel the drag (the two-finger gesture takes over). Same pointer: ignored. */
	pointerDown(pointerId: number): void {
		void pointerId;
		throw new Error('not implemented');
	}

	/** Pointer moved to plan point `to`. Null for another pointer or when done. */
	move(pointerId: number, to: Vec2): DragPreview | null {
		void [pointerId, to];
		throw new Error('not implemented');
	}

	/**
	 * Release: calls commit(model) once and returns that model. Null (no commit) for another pointer,
	 * when done, when nothing moved, or when the last preview is invalid.
	 */
	end(pointerId: number): HouseModel | null {
		void pointerId;
		throw new Error('not implemented');
	}

	/** Abort without commit. Always null. */
	cancel(): null {
		throw new Error('not implemented');
	}
}
