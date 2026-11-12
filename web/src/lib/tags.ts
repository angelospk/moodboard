/** Normalize a comma separated tag string: trim, lowercase, dedupe, drop empty, keep at most 30. */
export function normTags(s: string): string[] {
	return [...new Set(s.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 30);
}
