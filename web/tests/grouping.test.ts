// Grouping the image grid by project: plain order and the ranked (search by meaning) order.
import { describe, expect, it } from 'vitest';
import { groupByProject, NO_PROJECT } from '../src/lib/grouping';

const projects = [
	{ id: 'p1', name: 'Λιμάνι' },
	{ id: 'p2', name: 'Σπίτι' },
	{ id: 'p3', name: 'Άδειο' }
];
const img = (id: string, project_id: string | null) => ({ id, project_id });
const shape = (gs: ReturnType<typeof groupByProject<{ id: string; project_id: string | null }>>) =>
	gs.map((g) => [g.key, g.items.map((i) => i.id)]);

describe('groupByProject', () => {
	it('returns no sections for no images', () => {
		expect(groupByProject([], projects, { noProjectName: 'Χωρίς project' })).toEqual([]);
	});

	it('follows the project order, skips empty projects and puts the images with no project last', () => {
		const items = [img('a', null), img('b', 'p2'), img('c', 'p1'), img('d', 'p2'), img('e', null)];
		const gs = groupByProject(items, projects, { noProjectName: 'Χωρίς project' });
		expect(shape(gs)).toEqual([
			['p1', ['c']],
			['p2', ['b', 'd']],
			[NO_PROJECT, ['a', 'e']]
		]);
		expect(gs.map((g) => g.name)).toEqual(['Λιμάνι', 'Σπίτι', 'Χωρίς project']);
	});

	it('puts an image whose project is not in the list with the images that have no project', () => {
		const gs = groupByProject([img('a', 'gone'), img('b', 'p1')], projects, { noProjectName: '—' });
		expect(shape(gs)).toEqual([
			['p1', ['b']],
			[NO_PROJECT, ['a']]
		]);
	});

	it('ranked: orders sections by their best image and keeps the search order inside each section', () => {
		// Best first: x (p2), y (no project), z (p1), w (p2).
		const items = [img('x', 'p2'), img('y', null), img('z', 'p1'), img('w', 'p2')];
		const gs = groupByProject(items, projects, { noProjectName: '—', ranked: true });
		expect(shape(gs)).toEqual([
			['p2', ['x', 'w']],
			[NO_PROJECT, ['y']],
			['p1', ['z']]
		]);
	});

	it('keeps the input order of the images inside a section', () => {
		const items = [img('3', 'p1'), img('1', 'p1'), img('2', 'p1')];
		expect(shape(groupByProject(items, projects, { noProjectName: '—' }))).toEqual([['p1', ['3', '1', '2']]]);
	});
});
