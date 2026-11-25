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
import { moveOpening, movePlaced, moveSlabPoint, moveWall, moveWallPoint, rotatePlaced, insertWallPoint } from './drag.js';
import { hidesOpening, type Element, type Item, type Box, type Pool } from './model.js';

export function applyDrag(model: HouseModel, handle: Handle, start: Vec2, to: Vec2): HouseModel | null {
	const el = model.elements.find((e) => e.id === handle.element);
	if (!el) return model;
	switch (handle.kind) {
		case 'corner':
			return moveWallPoint(model, handle.element, handle.index, to);
		case 'mid': {
			const withPoint = insertWallPoint(model, handle.element, handle.index, start);
			if (withPoint === model) return model;
			return moveWallPoint(withPoint, handle.element, handle.index + 1, to);
		}
		case 'body':
			return moveWall(model, handle.element, [to[0] - start[0], to[1] - start[1]]);
		case 'center': {
			if (el.type === 'window' || el.type === 'door') return moveOpening(model, el.id, to);
			if (el.type === 'pool' || el.type === 'box' || el.type === 'item') {
				return movePlaced(model, el.id, [el.center[0] + to[0] - start[0], el.center[1] + to[1] - start[1]]);
			}
			return model;
		}
		case 'rotate': {
			const placed = el as Pool | Box | Item;
			// The knob sits on the rotated +y axis, so its direction is rotation + 90 deg.
			const angle = (Math.atan2(to[1] - placed.center[1], to[0] - placed.center[0]) * 180) / Math.PI - 90;
			return rotatePlaced(model, el.id, angle);
		}
		case 'vertex':
			return moveSlabPoint(model, handle.element, handle.index, to);
	}
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
	private original: HouseModel;
	private lastValid: HouseModel;
	private lastPreview: DragPreview | null = null;
	private moved = false;
	private finished = false;

	constructor(opts: DragSessionOptions) {
		this.original = opts.model;
		this.lastValid = opts.model;
		this.opts = opts;
	}

	private opts: DragSessionOptions;

	get done(): boolean {
		return this.finished;
	}

	pointerDown(pointerId: number): void {
		if (this.finished) return;
		if (pointerId === this.opts.pointerId) return;
		this.finished = true;
	}

	move(pointerId: number, to: Vec2): DragPreview | null {
		if (this.finished || pointerId !== this.opts.pointerId) return null;
		this.moved = true;
		const snap = this.opts.snap ?? ((p: Vec2) => p);
		const target = snap(to);
		const apply = this.opts.apply ?? applyDrag;
		const next = apply(this.original, this.opts.handle, this.opts.start, target);
		if (next === null) {
			this.lastPreview = { model: this.lastValid, invalid: true, affected: changed(this.original, this.lastValid) };
			return this.lastPreview;
		}
		if (hidesOpening(this.original, next)) {
			// The move hides a hole: show it (the viewport flags it) but never keep or commit it.
			this.lastPreview = { model: next, invalid: true, affected: changed(this.original, next) };
			return this.lastPreview;
		}
		this.lastValid = next;
		this.lastPreview = { model: next, invalid: false, affected: changed(this.original, next) };
		return this.lastPreview;
	}

	end(pointerId: number): HouseModel | null {
		if (this.finished || pointerId !== this.opts.pointerId) return null;
		if (!this.moved || !this.lastPreview || this.lastPreview.invalid) {
			this.finished = true;
			return null;
		}
		const out = this.lastValid;
		this.finished = true;
		this.opts.commit(out);
		return out;
	}

	cancel(): null {
		this.finished = true;
		return null;
	}
}

/** Ids of elements that differ between two models, by reference or by value. */
function changed(before: HouseModel, after: HouseModel): string[] {
	const old = new Map(before.elements.map((e) => [e.id, e]));
	const ids: string[] = [];
	for (const e of after.elements) {
		const prev = old.get(e.id);
		if (prev !== e && !sameElement(prev, e)) ids.push(e.id);
	}
	return ids;
}

function sameElement(a: Element | undefined, b: Element): boolean {
	return !!a && JSON.stringify(a) === JSON.stringify(b);
}
