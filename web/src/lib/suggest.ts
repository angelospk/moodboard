import type PocketBase from 'pocketbase';

const MAX_SIDE = 1024;

export interface LabelSuggestion {
	/** A level id of the user, or ''. */
	level: string;
	tags: string[];
}

/** ~1024px JPEG, so the model call is fast. The original when the canvas API is missing or fails. */
async function smallBlob(file: Blob): Promise<Blob> {
	if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return file;
	try {
		const bitmap = await createImageBitmap(file);
		const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
		const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
		const context = canvas.getContext('2d');
		if (!context) return file;
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
	} catch {
		return file;
	}
}

/**
 * Ask the server which level and tags fit an image that is not saved yet, so a form can prefill.
 * Resolves to null when the user has AI off, the daily limit is reached, or anything fails: the
 * form then stays as it is.
 */
export async function suggestLabels(pb: PocketBase, file: Blob): Promise<LabelSuggestion | null> {
	if (!file.type.startsWith('image/')) return null;
	try {
		const form = new FormData();
		form.append('image', await smallBlob(file), 'image.jpg');
		const out = await pb.send<{ enabled?: boolean; level?: string; tags?: string[] }>('/api/mb/suggest', {
			method: 'POST',
			body: form,
			requestKey: null
		});
		if (!out?.enabled) return null;
		return { level: out.level ?? '', tags: Array.isArray(out.tags) ? out.tags : [] };
	} catch {
		return null;
	}
}

/** Save the user's choice: new images may be sent to the AI for level/tag suggestions. */
export async function setAiEnabled(pb: PocketBase, userId: string, on: boolean): Promise<void> {
	await pb.collection('users').update(userId, { ai_enabled: on });
}
