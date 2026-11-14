// Keep the user's place when a change moves images between sections above them.
import { describe, expect, it } from 'vitest';
import { pickAnchor } from '../src/lib/scrollAnchor';

const box = (id: string, top: number, height = 100) => ({ id, top, bottom: top + height });

describe('pickAnchor', () => {
	it('the section the user is reading: the one that covers the top of the viewport', () => {
		expect(pickAnchor([box('a', -900, 500), box('b', -400, 1000), box('c', 600)], 800)).toBe('b');
	});
	it('no section covers the top: the first one that starts in view', () => {
		expect(pickAnchor([box('a', -300, 200), box('b', 120), box('c', 400)], 800)).toBe('b');
	});
	it('a section that starts exactly at the top counts as covering it', () => {
		expect(pickAnchor([box('a', 0), box('b', 100)], 800)).toBe('a');
	});
	it('nothing in view: no anchor', () => {
		expect(pickAnchor([box('a', 900), box('b', -500)], 800)).toBeNull();
		expect(pickAnchor([], 800)).toBeNull();
	});
});
