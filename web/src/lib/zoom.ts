// Zoom and pan of the picture in the viewer. The picture is drawn with transform:
// translate(x, y) scale(k), origin top-left, inside a frame of w x h pixels. k = 1 is the whole
// picture; it never gets smaller, and it always covers the frame (no empty edge). Pure.

export interface View {
	k: number;
	x: number;
	y: number;
}

export const RESET: View = { k: 1, x: 0, y: 0 };
export const MAX_ZOOM = 8;
/** Double-click on the whole picture zooms to this level. */
export const DBLCLICK_ZOOM = 2.5;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** The same view, moved back so the picture covers the frame. */
export function clampPan(v: View, w: number, h: number): View {
	if (v.k <= 1) return { ...RESET };
	return { k: v.k, x: clamp(v.x, w - w * v.k, 0), y: clamp(v.y, h - h * v.k, 0) };
}

/** Zoom to level `k` around the frame point (px, py): the picture point under it stays under it. */
export function zoomTo(v: View, k: number, px: number, py: number, w: number, h: number): View {
	const k2 = clamp(k, 1, MAX_ZOOM);
	if (k2 === 1) return { ...RESET };
	return clampPan({ k: k2, x: px - ((px - v.x) * k2) / v.k, y: py - ((py - v.y) * k2) / v.k }, w, h);
}

/** Zoom by `factor` (> 1 in, < 1 out) around the frame point (px, py). */
export function zoomAt(v: View, factor: number, px: number, py: number, w: number, h: number): View {
	return zoomTo(v, v.k * factor, px, py, w, h);
}

/** Move the picture with the pointer by (dx, dy) pixels. */
export function panBy(v: View, dx: number, dy: number, w: number, h: number): View {
	return clampPan({ k: v.k, x: v.x + dx, y: v.y + dy }, w, h);
}

/** The zoom factor of one wheel event: smooth for a trackpad, one step of about 20% for a mouse
 *  notch (deltaY 100). Line deltas (deltaMode 1) count 16 px, page deltas (2) 400 px. */
export function wheelFactor(deltaY: number, deltaMode: number): number {
	const px = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1);
	return clamp(Math.exp(-px * 0.002), 0.5, 2);
}
