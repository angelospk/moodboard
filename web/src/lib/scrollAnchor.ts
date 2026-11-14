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
 * The section to hold in place: the one that covers the top of the viewport (the one being read),
 * else the first one that starts inside it. Null when none is in view.
 */
export function pickAnchor(boxes: AnchorBox[], viewportHeight: number): string | null {
	const reading = boxes.find((b) => b.top <= 0 && b.bottom > 0);
	if (reading) return reading.id;
	return boxes.find((b) => b.top > 0 && b.top < viewportHeight)?.id ?? null;
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
	const id = pickAnchor(boxes, window.innerHeight);
	const before = boxes.find((b) => b.id === id)?.top ?? 0;
	const out = await change();
	await settled();
	const el = id === null ? null : root?.querySelector<HTMLElement>(`[data-section="${CSS.escape(id)}"]`);
	if (el) {
		const delta = el.getBoundingClientRect().top - before;
		if (Math.abs(delta) > 1) window.scrollBy({ top: delta, behavior: 'instant' });
	}
	return out;
}
