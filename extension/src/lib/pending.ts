import { shrinkIfHuge } from '@/lib/image';

/** A captured image waiting for the user to confirm it in the popup. */
export interface PendingCapture {
	dataUrl: string;
	mime: string;
	sourceUrl: string | null;
	sourceTitle: string | null;
	imageUrl?: string;
	error?: string;
}

const KEY = 'pendingCapture';

export async function setPending(capture: PendingCapture): Promise<void> {
	let record = capture;
	if (record.dataUrl) {
		const shrunk = await shrinkIfHuge(record.dataUrl, record.mime);
		record = { ...record, dataUrl: shrunk.dataUrl, mime: shrunk.mime };
	}
	try {
		await browser.storage.session.set({ [KEY]: record });
		await browser.storage.local.remove(KEY);
	} catch {
		// Session quota is 10MB; large screenshots fall back to local storage.
		await browser.storage.local.set({ [KEY]: record });
		await browser.storage.session.remove(KEY);
	}
}

export async function getPending(): Promise<PendingCapture | null> {
	const fromSession = (await browser.storage.session.get(KEY))[KEY] as PendingCapture | undefined;
	if (fromSession) return fromSession;
	const fromLocal = (await browser.storage.local.get(KEY))[KEY] as PendingCapture | undefined;
	return fromLocal ?? null;
}

export async function clearPending(): Promise<void> {
	await browser.storage.session.remove(KEY);
	await browser.storage.local.remove(KEY);
}

export type PopupMessage = { type: 'capture-active-tab' };

export interface CaptureResult {
	ok: boolean;
	error?: string;
}
