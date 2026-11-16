import { describe, expect, it } from 'vitest';
import { cleanTags } from '../src/lib/inspirations';

// QA 2026-11-15 F12: a tag typed with a double space was stored with it and shown with one.
describe('cleanTags', () => {
	it('collapses inner whitespace, so «a  b» and «a b» are one tag', () => {
		expect(cleanTags(['Warm  light', 'warm light', ' x\ty '])).toEqual(['warm light', 'x y']);
	});
});
