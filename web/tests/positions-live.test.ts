import { describe, expect, it } from 'vitest';
import { applyPositionEvent } from '../src/lib/realtime';

// QA 2026-11-15 F1: a node moved in one tab must move in the user's other tabs.
const rec = (scope: string, node_key: string, x: number, y: number) => ({ id: 'r1', scope, node_key, x, y }) as never;

describe('applyPositionEvent', () => {
	const pos = { 'i:a': { x: 1, y: 2 } };

	it('moves a node of the shown map on create/update', () => {
		expect(applyPositionEvent(pos, 'all', { action: 'update', record: rec('all', 'i:a', 10, 20) })).toEqual({ 'i:a': { x: 10, y: 20 } });
		expect(applyPositionEvent(pos, 'all', { action: 'create', record: rec('all', 't:red', 5, 6) })).toEqual({ 'i:a': { x: 1, y: 2 }, 't:red': { x: 5, y: 6 } });
	});

	it('ignores another map (scope) and an echo of the same spot', () => {
		expect(applyPositionEvent(pos, 'all', { action: 'update', record: rec('p123', 'i:a', 10, 20) })).toBe(pos);
		expect(applyPositionEvent(pos, 'all', { action: 'update', record: rec('all', 'i:a', 1, 2) })).toBe(pos);
	});

	it('forgets a node on delete; an unknown delete changes nothing', () => {
		expect(applyPositionEvent(pos, 'all', { action: 'delete', record: rec('all', 'i:a', 0, 0) })).toEqual({});
		expect(applyPositionEvent(pos, 'all', { action: 'delete', record: rec('all', 'i:zz', 0, 0) })).toBe(pos);
	});

	it('ignores rows without finite coordinates', () => {
		expect(applyPositionEvent(pos, 'all', { action: 'update', record: rec('all', 'i:a', NaN, 3) })).toBe(pos);
	});
});

describe('applyPositionEvent while the user drags (Codex review)', () => {
	const pos = { 'i:a': { x: 1, y: 2 } };
	it('ignores a remote move of a card this tab is dragging, alone or with its zone', () => {
		const busy = new Set(['i:a', 't:red']);
		expect(applyPositionEvent(pos, 'all', { action: 'update', record: rec('all', 'i:a', 10, 20) }, busy)).toBe(pos);
		expect(applyPositionEvent(pos, 'all', { action: 'delete', record: rec('all', 'i:a', 0, 0) }, busy)).toBe(pos);
		expect(applyPositionEvent(pos, 'all', { action: 'update', record: rec('all', 'i:b', 3, 4) }, busy)).toEqual({ 'i:a': { x: 1, y: 2 }, 'i:b': { x: 3, y: 4 } });
	});
});
