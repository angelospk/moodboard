// Sections of the image list (home page and a project's list): none, by first tag, or by source
// project (see sourceProjects.ts). Pure.
import type { Inspiration } from '#lib/types.js';
import type { SourceProjectSection } from '#lib/sourceProjects.js';

export type GroupMode = '' | 'tag' | 'source';

/** The stored choice; the old value '1' meant by source project. */
export function parseGroupMode(stored: string | null): GroupMode {
	if (stored === 'tag') return 'tag';
	if (stored === 'source' || stored === '1') return 'source';
	return '';
}

/**
 * One section per first tag (an image's zone on the map), biggest first, then alphabetical; the
 * untagged images last. `ranked` (search by meaning): sections follow their best result.
 */
export function groupByFirstTag(
	items: Inspiration[],
	opts: { noneName: string; ranked?: boolean }
): SourceProjectSection[] {
	const sections = new Map<string, SourceProjectSection>();
	const none: Inspiration[] = [];
	for (const i of items) {
		const tag = i.tags[0]?.trim();
		if (!tag) {
			none.push(i);
			continue;
		}
		const sec = sections.get(tag) ?? { key: tag, name: tag, items: [] };
		sec.items.push(i);
		sections.set(tag, sec);
	}
	const named = [...sections.values()];
	if (!opts.ranked) named.sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));
	if (none.length) named.push({ key: '', name: opts.noneName, items: none });
	return named;
}
