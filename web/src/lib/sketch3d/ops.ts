// Sketch document history: state = replay of an op log. Each change is a full snapshot of one
// element (el = null deletes it), so a merge works per element. Elements are plain JSON data
// (no Map, Date, undefined): `parseSketch` enforces it, and equality below relies on it. A variant owns its own op list;
// fork copies it, merge appends one op to the target that carries the source's new state.
// Merge bookkeeping. Each change has an origin (`from`, else its own op id): the op that decided
// that value. A plain edit is its own origin; a merge forwards the source's origin, except for a
// conflict, whose resolution is a new decision with the merge op as origin. A variant "knows" the
// origins in its own ops plus the op ids its merge ops list in `merged`. A side has news for an
// element when the origin of its last write is unknown to the other. Merge ops that only forward
// are never an origin, so merging back and forth with nothing new is a no-op.

export type ElementId = string;
export interface Change<E> {
	id: ElementId;
	el: E | null;
	/** Merge changes only: the op that decided this value (see top of file). */
	from?: string;
}
export interface Op<E> {
	id: string;
	label: string;
	author: 'user' | 'ai' | 'import';
	t: number;
	ch: Change<E>[];
	/** Set on a merge op: the variant it came from and the op ids the target learnt from it. */
	mergeOf?: string;
	merged?: string[];
}
export interface Variant<E> {
	id: string;
	name: string;
	from?: string;
	ops: Op<E>[];
}
export interface Conflict {
	id: ElementId;
	src: string[];
	dst: string[];
}
export interface MergePlan<E> {
	/** Source ops that carry a write the target has not seen, for display. */
	newOps: Op<E>[];
	/** Elements whose source value the target has not seen. */
	touched: ElementId[];
	conflicts: Conflict[];
	srcState: Map<ElementId, E>;
	dstState: Map<ElementId, E>;
	/** Origin of the source's last write per touched element. */
	srcFrom: Map<ElementId, string>;
	/** Origins the source knows and the target does not. */
	learnt: string[];
}

export function replay<E>(ops: readonly Op<E>[]): Map<ElementId, E> {
	const m = new Map<ElementId, E>();
	for (const o of ops)
		for (const c of o.ch) {
			if (c.el === null) m.delete(c.id);
			else m.set(c.id, structuredClone(c.el));
		}
	return m;
}

export function fork<E>(src: Variant<E>, v: { id: string; name: string }): Variant<E> {
	return { id: v.id, name: v.name, from: src.id, ops: src.ops.slice() };
}

function known<E>(v: Variant<E>): Set<string> {
	const k = new Set<string>();
	for (const o of v.ops) {
		if (!o.mergeOf || o.ch.some((c) => c.from === o.id)) k.add(o.id);
		for (const id of o.merged ?? []) k.add(id);
	}
	return k;
}

/** Origin of the last write per element (deletes included). */
function writers<E>(v: Variant<E>): Map<ElementId, string> {
	const w = new Map<ElementId, string>();
	for (const o of v.ops) for (const c of o.ch) w.set(c.id, c.from ?? o.id);
	return w;
}

/** Deep equality of plain JSON values (key order does not matter). */
export function equal(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const ka = Object.keys(a), kb = Object.keys(b);
	if (ka.length !== kb.length || !ka.every((k) => Object.hasOwn(b, k))) return false;
	return ka.every((k) => equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function labelsById<E>(ops: Op<E>[], ids: Set<ElementId>): Map<ElementId, string[]> {
	const t = new Map<ElementId, string[]>();
	for (const o of ops)
		for (const c of o.ch) {
			if (!ids.has(c.id)) continue;
			const a = t.get(c.id) ?? t.set(c.id, []).get(c.id)!;
			if (!a.includes(o.label)) a.push(o.label);
		}
	return t;
}

/** What merging src into dst would do. A conflict = an element where each side has a write the
 * other has not seen, and the two values differ. */
export function mergePlan<E>(src: Variant<E>, dst: Variant<E>): MergePlan<E> {
	const kS = known(src), kD = known(dst);
	const wS = writers(src), wD = writers(dst);
	const newOps = src.ops.filter((o) => !kD.has(o.id) && o.ch.some((c) => !kD.has(c.from ?? o.id)));
	const srcFrom = new Map([...wS].filter(([, from]) => !kD.has(from)));
	const srcState = replay(src.ops), dstState = replay(dst.ops);
	const both = new Set(
		[...srcFrom.keys()].filter((id) => {
			const d = wD.get(id);
			return d !== undefined && !kS.has(d) && !equal(srcState.get(id) ?? null, dstState.get(id) ?? null);
		})
	);
	const sT = labelsById(newOps, both);
	const dT = labelsById(dst.ops.filter((o) => !kS.has(o.id)), both);
	const conflicts = [...both].map((id) => ({ id, src: sT.get(id) ?? [], dst: dT.get(id) ?? [] }));
	const learnt = [...kS].filter((id) => !kD.has(id));
	return { newOps, touched: [...srcFrom.keys()], conflicts, srcState, dstState, srcFrom, learnt };
}

/** Merge src into dst. For a conflict, choice[id] = 'dst' keeps dst's element, anything else
 * takes src's; either way the result is a new decision other variants will receive.
 * Returns the new dst variant, or null when src has nothing dst has not seen. */
export function merge<E>(
	src: Variant<E>,
	dst: Variant<E>,
	choice: Record<ElementId, 'src' | 'dst'>,
	meta: { id: string; t: number; label: string }
): Variant<E> | null {
	const p = mergePlan(src, dst);
	if (!p.learnt.length) return null;
	const conflicted = new Set(p.conflicts.map((c) => c.id));
	const value = (m: Map<ElementId, E>, id: ElementId) => (m.has(id) ? structuredClone(m.get(id)!) : null);
	const ch: Change<E>[] = p.touched.map((id) =>
		!conflicted.has(id)
			? { id, el: value(p.srcState, id), from: p.srcFrom.get(id)! }
			: { id, el: value(choice[id] === 'dst' ? p.dstState : p.srcState, id), from: meta.id }
	);
	const op: Op<E> = { ...meta, author: 'user', ch, mergeOf: src.id, merged: p.learnt };
	return { ...dst, ops: [...dst.ops, op] };
}
