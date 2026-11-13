/** Section key for the images with no project (or with a project that is not in the list). */
export const NO_PROJECT = 'none';

export interface ProjectGroup<T> {
	/** Project id, or `NO_PROJECT`. */
	key: string;
	name: string;
	items: T[];
}

/**
 * Splits images into one section per project. Images keep their input order inside a section.
 * Plain: sections follow `projects`, the no-project section comes last.
 * Ranked (input is best first): sections follow their best image. Empty sections are left out.
 */
export function groupByProject<T extends { project_id: string | null }>(
	items: T[],
	projects: { id: string; name: string }[],
	opts: { noProjectName: string; ranked?: boolean }
): ProjectGroup<T>[] {
	const names = new Map(projects.map((p) => [p.id, p.name]));
	const byKey = new Map<string, ProjectGroup<T>>();
	for (const item of items) {
		const key = item.project_id && names.has(item.project_id) ? item.project_id : NO_PROJECT;
		let g = byKey.get(key);
		if (!g) {
			g = { key, name: key === NO_PROJECT ? opts.noProjectName : names.get(key)!, items: [] };
			byKey.set(key, g);
		}
		g.items.push(item);
	}
	// A Map keeps insertion order: the order of each section's first (best) image.
	if (opts.ranked) return [...byKey.values()];
	const out: ProjectGroup<T>[] = [];
	for (const p of projects) {
		const g = byKey.get(p.id);
		if (g) out.push(g);
	}
	const none = byKey.get(NO_PROJECT);
	if (none) out.push(none);
	return out;
}
