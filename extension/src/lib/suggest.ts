import { pb } from './pb';

const MAX_SIDE = 1024;

/** Shrink to ~1024px (JPEG) so the model call is fast; the original blob when the canvas API is missing. */
async function smallBlob(dataUrl: string): Promise<Blob> {
	const original = await (await fetch(dataUrl)).blob();
	if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') return original;
	try {
		const bitmap = await createImageBitmap(original);
		const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
		const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
		const context = canvas.getContext('2d');
		if (!context) return original;
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
	} catch {
		return original;
	}
}

export interface LabelSuggestion {
	/** A level id of the user, or ''. */
	level: string;
	tags: string[];
}

/**
 * Ask the server which level and tags fit an image that is not saved yet. Resolves to null when
 * the user has AI off, the daily limit is reached, or anything fails: the form then stays as it is.
 */
export async function suggestLabels(dataUrl: string): Promise<LabelSuggestion | null> {
	try {
		const form = new FormData();
		form.append('image', await smallBlob(dataUrl), 'image.jpg');
		const out = await pb.send<{ enabled?: boolean; level?: string; tags?: string[] }>('/api/mb/suggest', {
			method: 'POST',
			body: form,
			requestKey: null, // never cancelled by another request
		});
		if (!out?.enabled) return null;
		return { level: out.level ?? '', tags: Array.isArray(out.tags) ? out.tags : [] };
	} catch {
		return null;
	}
}
