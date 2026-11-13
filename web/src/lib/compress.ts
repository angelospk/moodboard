// Upload compression: a large photo is made smaller in the browser before it goes to the server.
// Any failure returns the original file, so compression never blocks an upload.
import { IMAGE_EXT } from '#lib/inspirations.js';

/** Longest edge, in pixels, of a stored image. */
export const MAX_EDGE = 2560;
/** A file at or under this size, with pixels that fit MAX_EDGE, is kept as it is. */
const KEEP_BYTES = 1.5 * 1024 * 1024;
const QUALITY = 0.86;

export type ResizePlan = { width: number; height: number; type: string; quality: number };

/** How to re-encode an image, or null when it should stay as it is. A GIF is never touched (it may
 *  be animated). The long edge is scaled down to MAX_EDGE; a small image is never upscaled. */
export function resizePlan(img: { width: number; height: number; type: string; size: number }): ResizePlan | null {
	if (img.type === 'image/gif') return null;
	const long = Math.max(img.width, img.height);
	if (long <= MAX_EDGE && img.size <= KEEP_BYTES) return null;
	const scale = Math.min(1, MAX_EDGE / long);
	return {
		width: Math.round(img.width * scale),
		height: Math.round(img.height * scale),
		type: 'image/webp',
		quality: QUALITY
	};
}

/** Is this PNG, WebP or AVIF animated? A canvas keeps only the first frame, so such a file stays as
 *  it is. Reads only the start of the file: APNG puts acTL before the first IDAT, an animated WebP sets
 *  the animation flag of its VP8X header, an AVIF image sequence has the brand 'avis'. */
export async function isAnimated(file: Blob, type = file.type): Promise<boolean> {
	if (type !== 'image/png' && type !== 'image/webp' && type !== 'image/avif') return false;
	const b = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
	const tag = (at: number) => String.fromCharCode(...b.subarray(at, at + 4));
	if (type === 'image/webp') return tag(12) === 'VP8X' && (b[20] & 0x02) !== 0;
	if (type === 'image/avif') return tag(4) === 'ftyp' && tag(8) === 'avis';
	for (let at = 8; at + 8 <= b.length; ) {
		const len = ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
		const t = tag(at + 4);
		if (t === 'acTL') return true;
		if (t === 'IDAT') return false;
		at += 12 + len;
	}
	return false;
}

/** Encode a bitmap to a Blob with OffscreenCanvas, else with a canvas element. Null when the
 *  browser has neither. */
async function encode(bmp: ImageBitmap, plan: ResizePlan): Promise<Blob | null> {
	if (typeof OffscreenCanvas !== 'undefined') {
		const canvas = new OffscreenCanvas(plan.width, plan.height);
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		ctx.drawImage(bmp, 0, 0, plan.width, plan.height);
		return canvas.convertToBlob({ type: plan.type, quality: plan.quality });
	}
	if (typeof document === 'undefined') return null;
	const canvas = document.createElement('canvas');
	canvas.width = plan.width;
	canvas.height = plan.height;
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	ctx.drawImage(bmp, 0, 0, plan.width, plan.height);
	return new Promise((resolve) => canvas.toBlob(resolve, plan.type, plan.quality));
}

/** A smaller copy of the image (long edge at most MAX_EDGE, WebP), or `file` itself when it cannot
 *  or need not be made smaller. Re-encoding also drops EXIF data such as GPS. */
export async function compressImage(file: Blob): Promise<Blob> {
	if (file.type === 'image/gif' || typeof createImageBitmap === 'undefined') return file;
	try {
		if (await isAnimated(file)) return file;
	} catch {
		return file;
	}
	let bmp: ImageBitmap;
	try {
		// 'from-image' applies the EXIF rotation of phone photos.
		bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
	} catch {
		return file;
	}
	try {
		const plan = resizePlan({ width: bmp.width, height: bmp.height, type: file.type, size: file.size });
		if (!plan) return file;
		const out = await encode(bmp, plan);
		// Safari may return a PNG when it cannot encode WebP; keep it only if it is allowed and smaller.
		if (!out || !(out.type in IMAGE_EXT) || out.size >= file.size) return file;
		return out;
	} catch {
		return file;
	} finally {
		bmp.close();
	}
}
