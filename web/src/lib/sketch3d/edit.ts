// Edits on the current variant of a document: commit an op, undo (pop it), redo (push it back).
// Pure: each call returns a new document.
import type { Element, SketchDoc } from './doc.js';
import type { Change, Op, Variant } from './ops.js';

export const current = (d: SketchDoc): Variant<Element> => d.variants.find((v) => v.id === d.current)!;

function withCurrent(d: SketchDoc, ops: Op<Element>[]): SketchDoc {
	return { ...d, variants: d.variants.map((v) => (v.id === d.current ? { ...v, ops } : v)) };
}

export function commit(d: SketchDoc, label: string, ch: Change<Element>[], id: string, t: number, author: Op<Element>['author'] = 'user'): SketchDoc {
	return withCurrent(d, [...current(d).ops, { id, label, author, t, ch }]);
}

/** Remove the last op of the current variant. Null when there is nothing to undo. */
export function undo(d: SketchDoc): { doc: SketchDoc; op: Op<Element> } | null {
	const ops = current(d).ops;
	if (!ops.length) return null;
	return { doc: withCurrent(d, ops.slice(0, -1)), op: ops[ops.length - 1] };
}

export const redo = (d: SketchDoc, op: Op<Element>): SketchDoc => withCurrent(d, [...current(d).ops, op]);
