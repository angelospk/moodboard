// A crop is a rectangle stored on the row (fractions of the image); the file stays whole. Every view
// shows only that part: a frame with the crop's shape clips the whole image, which is made larger
// and moved so the kept part fills the frame. Only the crop editor shows the whole image. Pure.
import type { Crop } from '#lib/types.js';

export const FULL: Crop = { x: 0, y: 0, w: 1, h: 1 };

/** The crop when it is a usable rectangle inside the image, else null (show the whole image). */
export function validCrop(c: Crop | null | undefined): Crop | null {
	if (!c) return null;
	const ok = [c.x, c.y, c.w, c.h].every(Number.isFinite) && c.x >= 0 && c.y >= 0 && c.w > 0 && c.h > 0;
	return ok && c.x + c.w <= 1.0001 && c.y + c.h <= 1.0001 ? c : null;
}

/** Width / height of what is shown: the image's aspect ratio (`imageAspect`, 0 or NaN when not known
 *  yet: 4:3 is assumed) shaped by the crop. */
export function cropAspect(crop: Crop | null | undefined, imageAspect: number): number {
	const ar = Number.isFinite(imageAspect) && imageAspect > 0 ? imageAspect : 4 / 3;
	const c = validCrop(crop);
	return c ? (ar * c.w) / c.h : ar;
}

/** Where the whole image goes, in percent of the frame, so that the crop fills the frame. */
export function imgPlacement(crop: Crop | null | undefined): { left: number; top: number; width: number; height: number } {
	const c = validCrop(crop) ?? FULL;
	// + 0 turns -0 into 0.
	return { left: (-100 * c.x) / c.w + 0, top: (-100 * c.y) / c.h + 0, width: 100 / c.w, height: 100 / c.h };
}

/** imgPlacement as an inline style for an absolutely placed element. */
export function placementStyle(crop: Crop | null | undefined): string {
	const p = imgPlacement(crop);
	return `left:${p.left}%;top:${p.top}%;width:${p.width}%;height:${p.height}%`;
}
