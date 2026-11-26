import { describe, expect, it } from 'vitest';
import { replay, fork, mergePlan, merge, type Op, type Variant } from '../src/lib/sketch3d/ops.js';

type El = { v: number };
let n = 0;
const op = (label: string, ch: [string, El | null][]): Op<El> => ({
	id: `op${++n}`,
	label,
	author: 'user',
	t: n,
	ch: ch.map(([id, el]) => ({ id, el }))
});
const push = (b: Variant<El>, o: Op<El>): Variant<El> => ({ ...b, ops: [...b.ops, o] });
const meta = () => ({ id: `m${++n}`, t: n, label: 'merge' });

describe('replay', () => {
	it('applies full snapshots in order and null deletes', () => {
		const s = replay<El>([op('a', [['x', { v: 1 }], ['y', { v: 2 }]]), op('b', [['x', { v: 3 }], ['y', null]])]);
		expect([...s.entries()]).toEqual([['x', { v: 3 }]]);
	});
	it('does not share objects with the ops', () => {
		const o = op('a', [['x', { v: 1 }]]);
		replay<El>([o]).get('x')!.v = 9;
		expect(o.ch[0].el).toEqual({ v: 1 });
	});
});

describe('fork + merge', () => {
	const base = (): Variant<El> => ({ id: 'main', name: 'Main', ops: [op('init', [['x', { v: 1 }], ['y', { v: 1 }]])] });

	it('brings source-only changes without conflicts', () => {
		const main = base();
		let alt = fork(main, { id: 'alt', name: 'Alt' });
		expect(alt.from).toBe('main');
		alt = push(alt, op('edit x', [['x', { v: 2 }]]));
		const plan = mergePlan(alt, main);
		expect(plan.newOps.map((o) => o.label)).toEqual(['edit x']);
		expect(plan.conflicts).toEqual([]);
		const merged = merge(alt, main, {}, meta())!;
		expect(replay(merged.ops).get('x')).toEqual({ v: 2 });
		expect(merged.ops.at(-1)!.mergeOf).toBe('alt');
	});

	it('reports a conflict when both sides change one element; the choice decides', () => {
		const main0 = base();
		const alt = push(fork(main0, { id: 'alt', name: 'Alt' }), op('alt x', [['x', { v: 2 }], ['y', { v: 5 }]]));
		const main = push(main0, op('main x', [['x', { v: 3 }]]));
		const plan = mergePlan(alt, main);
		expect(plan.conflicts).toEqual([{ id: 'x', src: ['alt x'], dst: ['main x'] }]);
		const keepDst = replay(merge(alt, main, { x: 'dst' }, meta())!.ops);
		expect(keepDst.get('x')).toEqual({ v: 3 });
		expect(keepDst.get('y')).toEqual({ v: 5 });
		const takeSrc = replay(merge(alt, main, { x: 'src' }, meta())!.ops);
		expect(takeSrc.get('x')).toEqual({ v: 2 });
	});

	it('defaults an unresolved conflict to the source', () => {
		const main0 = base();
		const alt = push(fork(main0, { id: 'alt', name: 'Alt' }), op('alt x', [['x', { v: 2 }]]));
		const main = push(main0, op('main x', [['x', { v: 3 }]]));
		expect(replay(merge(alt, main, {}, meta())!.ops).get('x')).toEqual({ v: 2 });
	});

	it('is not a conflict when both sides end with the same element', () => {
		const main0 = base();
		const alt = push(fork(main0, { id: 'alt', name: 'Alt' }), op('alt x', [['x', { v: 7 }]]));
		const main = push(main0, op('main x', [['x', { v: 7 }]]));
		expect(mergePlan(alt, main).conflicts).toEqual([]);
	});

	it('a delete against an edit is a conflict; taking the source deletes', () => {
		const main0 = base();
		const alt = push(fork(main0, { id: 'alt', name: 'Alt' }), op('del x', [['x', null]]));
		const main = push(main0, op('main x', [['x', { v: 3 }]]));
		expect(mergePlan(alt, main).conflicts.map((c) => c.id)).toEqual(['x']);
		expect(replay(merge(alt, main, { x: 'src' }, meta())!.ops).has('x')).toBe(false);
	});

	it('a second merge brings only new ops; a resolved element changed again is a new conflict', () => {
		const main0 = base();
		let alt = push(fork(main0, { id: 'alt', name: 'Alt' }), op('alt x', [['x', { v: 2 }], ['y', { v: 2 }]]));
		let main = push(main0, op('main x', [['x', { v: 3 }]]));
		main = merge(alt, main, { x: 'dst' }, meta())!;
		alt = push(alt, op('alt again', [['x', { v: 4 }], ['y', { v: 4 }]]));
		const plan = mergePlan(alt, main);
		expect(plan.newOps.map((o) => o.label)).toEqual(['alt again']);
		// main kept its own x without alt seeing it, so alt's new x meets it again (as in git).
		expect(plan.conflicts).toEqual([{ id: 'x', src: ['alt again'], dst: ['main x', 'merge'] }]);
		const s = replay(merge(alt, main, { x: 'dst' }, meta())!.ops);
		expect([s.get('x'), s.get('y')]).toEqual([{ v: 3 }, { v: 4 }]);
	});

	it('a back-merge into the source does not come back as a change or a conflict', () => {
		let main = base();
		let alt = push(fork(main, { id: 'alt', name: 'Alt' }), op('alt x', [['x', { v: 2 }]]));
		main = merge(alt, main, {}, meta())!;
		main = push(main, op('main y', [['y', { v: 9 }]]));
		alt = merge(main, alt, {}, meta())!;
		main = push(main, op('main y again', [['y', { v: 10 }]]));
		alt = push(alt, op('alt z', [['z', { v: 1 }]]));
		const plan = mergePlan(alt, main);
		expect(plan.newOps.map((o) => o.label)).toEqual(['alt z']);
		expect(plan.conflicts).toEqual([]);
		const s = replay(merge(alt, main, {}, meta())!.ops);
		expect([s.get('x'), s.get('y'), s.get('z')]).toEqual([{ v: 2 }, { v: 10 }, { v: 1 }]);
	});

	it('a back-merge does not undo an element the other side restored', () => {
		let a = base();
		let b = fork(a, { id: 'b', name: 'B' });
		a = push(a, op('a del x', [['x', null]]));
		b = merge(a, b, {}, meta())!; // b: x deleted
		b = push(b, op('b restore x', [['x', { v: 8 }]]));
		a = merge(b, a, {}, meta())!; // a: x restored (from b)
		b = push(b, op('b del x', [['x', null]]));
		b = push(b, op('b restore x again', [['x', { v: 9 }]]));
		a = push(a, op('a y', [['y', { v: 2 }]]));
		const plan = mergePlan(a, b);
		expect(plan.conflicts).toEqual([]);
		const s = replay(merge(a, b, {}, meta())!.ops);
		expect(s.get('x')).toEqual({ v: 9 });
		expect(s.get('y')).toEqual({ v: 2 });
	});

	it('remembers what a variant received through a third variant', () => {
		let a = base();
		let b = fork(a, { id: 'b', name: 'B' });
		let c = fork(a, { id: 'c', name: 'C' });
		const d = fork(a, { id: 'd', name: 'D' });
		a = push(a, op('a del x', [['x', null]]));
		b = merge(a, b, {}, meta())!;
		c = merge(b, c, {}, meta())!; // c got a's delete through b
		c = push(c, op('c restore x', [['x', { v: 5 }]]));
		expect(mergePlan(a, c).conflicts).toEqual([]);
		// b only forwards a's delete; for d, which never saw it, that merge op is news.
		expect(mergePlan(b, d).newOps.map((o) => o.mergeOf)).toEqual(['main']);
		const m = merge(a, c, {}, meta());
		expect(m === null || replay(m.ops).get('x')?.v === 5).toBe(true);
	});

	it('a fresh edit on one side does not conflict with a change the other side already took', () => {
		let a = base();
		let b = fork(a, { id: 'b', name: 'B' });
		a = push(a, op('a x', [['x', { v: 2 }]]));
		b = merge(a, b, {}, meta())!;
		b = push(b, op('b x', [['x', { v: 3 }]]));
		const plan = mergePlan(b, a);
		expect(plan.conflicts).toEqual([]);
		expect(replay(merge(b, a, {}, meta())!.ops).get('x')).toEqual({ v: 3 });
	});

	it('after keeping its own version, the target wins the next merge back without a conflict', () => {
		let a = base();
		let b = fork(a, { id: 'b', name: 'B' });
		a = push(a, op('a x', [['x', { v: 2 }]]));
		b = push(b, op('b x', [['x', { v: 3 }]]));
		b = merge(a, b, { x: 'dst' }, meta())!;
		expect(mergePlan(a, b).newOps).toEqual([]);
		expect(mergePlan(b, a).conflicts).toEqual([]);
		expect(replay(merge(b, a, {}, meta())!.ops).get('x')).toEqual({ v: 3 });
	});

	it('elements that differ only by which key is present are a conflict', () => {
		const main0: Variant<Record<string, unknown>> = { id: 'main', name: 'Main', ops: [] };
		const alt = { ...fork(main0, { id: 'alt', name: 'Alt' }), ops: [{ id: 'p', label: 'alt', author: 'user' as const, t: 1, ch: [{ id: 'x', el: { a: undefined } }] }] };
		const main = { ...main0, ops: [{ id: 'q', label: 'main', author: 'user' as const, t: 2, ch: [{ id: 'x', el: { b: undefined } }] }] };
		expect(mergePlan(alt, main).conflicts.map((c) => c.id)).toEqual(['x']);
	});

	it('merging back and forth with nothing new adds no empty merge ops', () => {
		let a = base();
		let b = push(fork(a, { id: 'b', name: 'B' }), op('b x', [['x', { v: 2 }]]));
		a = merge(b, a, {}, meta())!;
		expect(merge(a, b, {}, meta())).toBeNull();
		expect(merge(b, a, {}, meta())).toBeNull();
		expect(mergePlan(a, b).newOps).toEqual([]);
	});

	it('3 variants with default choices do not stop merging while they still differ', () => {
		let a = base();
		let b = fork(a, { id: 'b', name: 'B' });
		let c = fork(a, { id: 'c', name: 'C' });
		a = push(a, op('a x', [['x', { v: 2 }]]));
		b = push(b, op('b x', [['x', { v: 3 }]]));
		c = merge(a, c, {}, meta())!;
		a = merge(b, a, {}, meta())!;
		b = merge(c, b, {}, meta())!;
		c = merge(a, c, {}, meta())!;
		for (let i = 0; i < 3; i++) {
			a = merge(b, a, {}, meta()) ?? a;
			c = merge(a, c, {}, meta()) ?? c;
			b = merge(c, b, {}, meta()) ?? b;
		}
		const xs = [a, b, c].map((v) => replay(v.ops).get('x'));
		expect(xs[1]).toEqual(xs[0]);
		expect(xs[2]).toEqual(xs[0]);
	});

	it('when both sides kept their own version, the later decision reaches the other side', () => {
		let a = base();
		let b = fork(a, { id: 'b', name: 'B' });
		a = push(a, op('a x', [['x', { v: 2 }]]));
		b = push(b, op('b x', [['x', { v: 3 }]]));
		b = merge(a, b, { x: 'dst' }, meta())!;
		a = merge(b, a, {}, meta())!;
		expect(replay(a.ops).get('x')).toEqual({ v: 3 });
	});

	it('random edits and merges between 3 variants converge and stop', () => {
		for (let seed = 1; seed <= 200; seed++) {
			let r = seed;
			const rnd = (k: number) => ((r = (r * 1103515245 + 12345) % 2147483648), r % k);
			const vs = [base()];
			vs.push(fork(vs[0], { id: 'b', name: 'B' }), fork(vs[0], { id: 'c', name: 'C' }));
			for (let step = 0; step < 30; step++) {
				const i = rnd(3);
				if (rnd(2)) {
					const id = ['x', 'y', 'z'][rnd(3)];
					vs[i] = push(vs[i], op(`e${step}`, [[id, rnd(4) ? { v: rnd(5) } : null]]));
				} else {
					const j = (i + 1 + rnd(2)) % 3;
					const choice: Record<string, 'src' | 'dst'> = {};
					for (const c of mergePlan(vs[i], vs[j]).conflicts) choice[c.id] = rnd(2) ? 'src' : 'dst';
					vs[j] = merge(vs[i], vs[j], choice, meta()) ?? vs[j];
				}
			}
			// Settle: merge round-robin until nothing changes (bounded).
			let rounds = 0;
			for (let changed = true; changed; rounds++) {
				expect(rounds).toBeLessThan(10);
				changed = false;
				for (const [i, j] of [[0, 1], [1, 2], [2, 0], [1, 0], [2, 1], [0, 2]]) {
					const m = merge(vs[i], vs[j], {}, meta());
					if (m) (vs[j] = m), (changed = true);
				}
			}
			const st = vs.map((v) => JSON.stringify([...replay(v.ops)].sort()));
			expect(st[1]).toBe(st[0]);
			expect(st[2]).toBe(st[0]);
		}
	});

	it('returns null when there is nothing new to merge', () => {
		const main = base();
		const alt = fork(main, { id: 'alt', name: 'Alt' });
		expect(merge(alt, main, {}, meta())).toBeNull();
	});

	it('does not mutate its inputs', () => {
		const main0 = base();
		const alt = push(fork(main0, { id: 'alt', name: 'Alt' }), op('alt x', [['x', { v: 2 }]]));
		const before = JSON.stringify([alt, main0]);
		merge(alt, main0, {}, meta());
		expect(JSON.stringify([alt, main0])).toBe(before);
	});
});
