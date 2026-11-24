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

/** Zoom to level `k` (at most `max`) around the frame point (px, py): the picture point under it stays under it. */
export function zoomTo(v: View, k: number, px: number, py: number, w: number, h: number, max = MAX_ZOOM): View {
	const k2 = clamp(k, 1, max);
	if (k2 === 1) return { ...RESET };
	return clampPan({ k: k2, x: px - ((px - v.x) * k2) / v.k, y: py - ((py - v.y) * k2) / v.k }, w, h);
}

/** Zoom by `factor` (> 1 in, < 1 out) around the frame point (px, py). */
export function zoomAt(v: View, factor: number, px: number, py: number, w: number, h: number, max = MAX_ZOOM): View {
	return zoomTo(v, v.k * factor, px, py, w, h, max);
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

/** The zoom at which one image pixel fills one screen pixel: the most the image can show. `natural`
 *  is the width of the largest copy, `shown` its width on screen at zoom 1. 0 = not known yet. */
export function pixelCap(natural: number, shown: number): number {
	if (!natural || !shown) return MAX_ZOOM;
	return clamp(natural / shown, 1, MAX_ZOOM);
}

/** Background size (w, h) and offset (x, y) of a round loupe `size` px wide that shows the image
 *  magnified `mag` times, centred on the client point (cx, cy). `box` is the image's rect on screen. */
export function loupeBackground(
	cx: number,
	cy: number,
	box: { left: number; top: number; width: number; height: number },
	size: number,
	mag: number
): { w: number; h: number; x: number; y: number } {
	const w = box.width * mag;
	const h = box.height * mag;
	return { w, h, x: size / 2 - (cx - box.left) * mag, y: size / 2 - (cy - box.top) * mag };
}
