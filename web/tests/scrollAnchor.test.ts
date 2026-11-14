// Keep the user's place when a change moves images between sections above them.
import { describe, expect, it } from 'vitest';
import { anchorCandidates } from '../src/lib/scrollAnchor';

const box = (id: string, top: number, height = 100) => ({ id, top, bottom: top + height });

describe('anchorCandidates', () => {
	it('the section the user is reading: the one that covers the top of the viewport', () => {
		expect(anchorCandidates([box('a', -900, 500), box('b', -400, 1000), box('c', 600)], 800)[0]).toBe('b');
	});
	it('no section covers the top: the first one that starts in view', () => {
		expect(anchorCandidates([box('a', -300, 200), box('b', 120), box('c', 400)], 800)[0]).toBe('b');
	});
	it('a section that starts exactly at the top counts as covering it', () => {
		expect(anchorCandidates([box('a', 0), box('b', 100)], 800)[0]).toBe('a');
	});
	it('then the sections after it, then the ones before it (nearest first), in case the first one goes away', () => {
		const boxes = [box('a', -2000), box('b', -900), box('c', -400, 1000), box('d', 600), box('e', 1500)];
		expect(anchorCandidates(boxes, 800)).toEqual(['c', 'd', 'e', 'b', 'a']);
	});
	it('nothing in view: no candidates', () => {
		expect(anchorCandidates([box('a', 900), box('b', -500)], 800)).toEqual([]);
		expect(anchorCandidates([], 800)).toEqual([]);
	});
});
