import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Autosaver } from '../src/lib/autosave';

type F = { note: string; tags: string[]; level: string | null };

/** A save function we resolve or reject by hand, recording every call. */
function fakeSave() {
	const calls: { id: string; fields: Partial<F>; resolve: () => void; reject: (e: Error) => void }[] = [];
	const save = (id: string, fields: Partial<F>) =>
		new Promise<void>((resolve, reject) => calls.push({ id, fields: structuredClone(fields), resolve, reject }));
	return { save, calls };
}
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => vi.useRealTimers());

describe('Autosaver', () => {
	it('debounces and sends only the changed keys, last value wins', async () => {
		const { save, calls } = fakeSave();
		const a = new Autosaver<F>(save, 700);
		a.set('A', 'note', 'n1');
		a.set('A', 'note', 'n2');
		vi.advanceTimersByTime(699);
		expect(calls).toHaveLength(0);
		vi.advanceTimersByTime(1);
		await settle();
		expect(calls).toEqual([expect.objectContaining({ id: 'A', fields: { note: 'n2' } })]);
	});

	it('captures values at set time; mutating the source later does not change what is sent', async () => {
		const { save, calls } = fakeSave();
		const a = new Autosaver<F>(save);
		const tags = ['x'];
		a.set('A', 'tags', tags);
		tags.push('y');
		void a.flush();
		await settle();
		expect(calls[0].fields).toEqual({ tags: ['x'] });
	});

	it('edits made during an inflight save are sent afterwards, not lost', async () => {
		const { save, calls } = fakeSave();
		const a = new Autosaver<F>(save);
		a.set('A', 'note', 'first');
		const f1 = a.flush();
		await settle();
		a.set('A', 'note', 'second');
		const f2 = a.flush();
		calls[0].resolve();
		await settle();
		expect(calls).toHaveLength(2);
		expect(calls[1].fields).toEqual({ note: 'second' });
		calls[1].resolve();
		expect(await f1).toBe(true);
		expect(await f2).toBe(true);
		expect(a.state).toBe('saved');
	});

	it('keeps edits of item A when the user switches to item B mid-save', async () => {
		const { save, calls } = fakeSave();
		const a = new Autosaver<F>(save);
		a.set('A', 'note', 'a-edit');
		void a.flush();
		await settle();
		a.set('A', 'level', 'detail');
		a.set('B', 'note', 'b-edit');
		const done = a.flush();
		calls[0].resolve();
		await settle();
		calls[1]?.resolve();
		await settle();
		calls[2]?.resolve();
		expect(await done).toBe(true);
		const sent = calls.map((c) => [c.id, c.fields]);
		expect(sent).toContainEqual(['A', { note: 'a-edit' }]);
		expect(sent).toContainEqual(['A', { level: 'detail' }]);
		expect(sent).toContainEqual(['B', { note: 'b-edit' }]);
	});

	it('a failed save keeps the edits, flush reports false, retry resends; newer edits win', async () => {
		const { save, calls } = fakeSave();
		const a = new Autosaver<F>(save);
		a.set('A', 'note', 'old');
		a.set('A', 'level', 'urban');
		const f = a.flush();
		await settle();
		calls[0].reject(new Error('offline'));
		expect(await f).toBe(false);
		expect(a.state).toBe('error');
		expect(a.error).toBe('offline');
		expect(a.dirtyKeys('A')).toEqual(new Set(['note', 'level']));
		a.set('A', 'note', 'new');
		const r = a.retry();
		await settle();
		expect(calls[1].fields).toEqual({ note: 'new', level: 'urban' });
		calls[1].resolve();
		expect(await r).toBe(true);
		expect(a.state).toBe('saved');
		expect(a.dirtyKeys('A').size).toBe(0);
	});

	it('dirtyKeys covers pending and inflight keys, per item', async () => {
		const { save, calls } = fakeSave();
		const a = new Autosaver<F>(save);
		a.set('A', 'note', 'x');
		void a.flush();
		await settle();
		a.set('A', 'tags', ['t']);
		expect(a.dirtyKeys('A')).toEqual(new Set(['note', 'tags']));
		expect(a.dirtyKeys('B').size).toBe(0);
		calls[0].resolve();
		await settle();
		expect(a.dirtyKeys('A')).toEqual(new Set(['tags']));
	});

	it('discard(id) drops pending edits of a deleted item', async () => {
		const { save, calls } = fakeSave();
		const a = new Autosaver<F>(save);
		a.set('A', 'note', 'x');
		a.discard('A');
		expect(await a.flush()).toBe(true);
		expect(calls).toHaveLength(0);
	});

	it('reports state changes to the listener', async () => {
		const { save, calls } = fakeSave();
		const states: string[] = [];
		const a = new Autosaver<F>(save, 700, (s) => states.push(s));
		a.set('A', 'note', 'x');
		const f = a.flush();
		await settle();
		calls[0].resolve();
		await f;
		expect(states).toEqual(['pending', 'saving', 'saved']);
	});
});
