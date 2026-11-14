// Keep the user's place when a change reorders the content above it (images that move to another
// section after a bulk change). Note the section in view before the change, scroll it back after.
// Sections, not cards: inside a section the masonry columns rebalance when a card leaves.

export interface AnchorBox {
	id: string;
	/** Top and bottom edge in viewport pixels (getBoundingClientRect). */
	top: number;
	bottom: number;
}

/**
 * The sections to hold in place, best first: the one that covers the top of the viewport (the one
 * being read), else the first one that starts inside it; then the sections after it, then the ones
 * before it (nearest first), in case the change removes it. Empty when none is in view.
 */
export function anchorCandidates(boxes: AnchorBox[], viewportHeight: number): string[] {
	let i = boxes.findIndex((b) => b.top <= 0 && b.bottom > 0);
	if (i < 0) i = boxes.findIndex((b) => b.top > 0 && b.top < viewportHeight);
	if (i < 0) return [];
	return [...boxes.slice(i), ...boxes.slice(0, i).reverse()].map((b) => b.id);
}

/**
 * Run `change`, then keep the section that was in view at the same height on screen. Sections are
 * the elements with `[data-section]` inside `root`; `settled` waits for the DOM update.
 */
export async function keepPlace<T>(
	root: ParentNode | null | undefined,
	change: () => Promise<T>,
	settled: () => Promise<void>
): Promise<T> {
	const boxes = [...(root?.querySelectorAll<HTMLElement>('[data-section]') ?? [])].map((el) => {
		const r = el.getBoundingClientRect();
		return { id: el.dataset.section!, top: r.top, bottom: r.bottom };
	});
	const tops = new Map(boxes.map((b) => [b.id, b.top]));
	const candidates = anchorCandidates(boxes, window.innerHeight);
	const out = await change();
	await settled();
	// The first candidate that is still there (a bulk rename can remove the one being read).
	for (const id of candidates) {
		const el = root?.querySelector<HTMLElement>(`[data-section="${CSS.escape(id)}"]`);
		if (!el) continue;
		const delta = el.getBoundingClientRect().top - tops.get(id)!;
		if (Math.abs(delta) > 1) window.scrollBy({ top: delta, behavior: 'instant' });
		break;
	}
	return out;
}
