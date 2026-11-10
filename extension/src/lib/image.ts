/** Chrome storage areas hold ~10MB each, and a base64 data URL inflates bytes by 1.33x. */
const MAX_DATA_URL_CHARS = 7_000_000;

export function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
		reader.readAsDataURL(blob);
	});
}

/**
 * A 4K screenshot PNG can exceed the storage quota, so re-encode the big ones
 * to JPEG before they become a pending capture. Returns the same data URL when
 * it already fits or when the canvas API is unavailable.
 */
export async function shrinkIfHuge(
	dataUrl: string,
	mime: string,
): Promise<{ dataUrl: string; mime: string }> {
	if (dataUrl.length <= MAX_DATA_URL_CHARS) return { dataUrl, mime };
	if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') {
		return { dataUrl, mime };
	}
	try {
		const blob = await (await fetch(dataUrl)).blob();
		const bitmap = await createImageBitmap(blob);
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		const context = canvas.getContext('2d');
		if (!context) return { dataUrl, mime };
		context.drawImage(bitmap, 0, 0);
		const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
		return { dataUrl: await blobToDataUrl(jpeg), mime: 'image/jpeg' };
	} catch {
		return { dataUrl, mime };
	}
}
