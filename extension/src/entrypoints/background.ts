import { blobToDataUrl } from '@/lib/image';
import { setPending, type CaptureResult, type PopupMessage } from '@/lib/pending';
import { normalizeMime } from '@/lib/types';

const MENU_IMAGE_ID = 'mb-save-image';
const MENU_PAGE_ID = 'mb-save-page';

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);

/** Open the popup so the user can confirm the capture. */
async function openPopup(): Promise<void> {
	try {
		await browser.action.openPopup();
	} catch {
		const width = 380;
		const height = 620;
		await browser.windows.create({
			url: browser.runtime.getURL('/popup.html'),
			type: 'popup',
			width,
			height,
		});
	}
}

/** Download the image bytes in the background (needs <all_urls> host permission). */
async function captureImage(
	imageUrl: string,
	tabUrl: string | null,
	tabTitle: string | null,
): Promise<CaptureResult> {
	const fail = async (error: string): Promise<CaptureResult> => {
		await setPending({
			dataUrl: '',
			mime: '',
			sourceUrl: tabUrl,
			sourceTitle: tabTitle,
			imageUrl,
			error,
		});
		await openPopup();
		return { ok: false, error };
	};
	try {
		const response = await fetch(imageUrl, { credentials: 'include' });
		if (!response.ok) return await fail(`Η λήψη απέτυχε (HTTP ${response.status}).`);
		const blob = await response.blob();
		const headerMime = normalizeMime(blob.type || '');
		const mime = headerMime && headerMime !== 'application/octet-stream'
			? headerMime
			: normalizeMime(guessMimeFromPath(imageUrl));
		if (!IMAGE_MIMES.has(mime)) return await fail('Ο τύπος εικόνας δεν υποστηρίζεται.');
		await setPending({
			dataUrl: await blobToDataUrl(blob),
			mime,
			sourceUrl: tabUrl,
			sourceTitle: tabTitle,
			imageUrl,
		});
		await openPopup();
		return { ok: true };
	} catch (error) {
		return await fail(`Η λήψη απέτυχε: ${String(error)}`);
	}
}

function guessMimeFromPath(url: string): string {
	const path = url.split('?')[0]!.split('#')[0]!.toLowerCase();
	if (path.endsWith('.png')) return 'image/png';
	if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
	if (path.endsWith('.webp')) return 'image/webp';
	if (path.endsWith('.gif')) return 'image/gif';
	if (path.endsWith('.avif')) return 'image/avif';
	return '';
}

/** Capture the visible area of a tab as a PNG data URL. */
async function captureTab(
	tab: { id?: number; url?: string; title?: string; windowId?: number } | undefined,
): Promise<CaptureResult> {
	const tabUrl = tab?.url ?? null;
	const tabTitle = tab?.title ?? null;
	if (tab?.windowId == undefined) return { ok: false, error: 'Δεν βρέθηκε ενεργή καρτέλα.' };
	try {
		const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
		await setPending({ dataUrl, mime: 'image/png', sourceUrl: tabUrl, sourceTitle: tabTitle });
		return { ok: true };
	} catch (error) {
		// Screenshots are blocked on some pages (chrome://, the extension UI, some stores).
		await setPending({
			dataUrl: '',
			mime: 'image/png',
			sourceUrl: tabUrl,
			sourceTitle: tabTitle,
			error: 'Το στιγμιότυπο δεν είναι διαθέσιμο σε αυτή τη σελίδα.',
		});
		return { ok: false, error: String(error) };
	}
}

/** The active tab of the focused window, falling back to any normal window's active tab. */
async function activeTab() {
	const [focused] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
	if (focused?.windowId != undefined && !(focused.url ?? '').startsWith(browser.runtime.getURL('/'))) {
		return focused;
	}
	const [fallback] = await browser.tabs.query({ active: true, windowType: 'normal' });
	return fallback;
}

function createMenus() {
	browser.contextMenus.removeAll(() => {
		browser.contextMenus.create({
			id: MENU_IMAGE_ID,
			title: 'Αποθήκευση εικόνας στο Moodboard',
			contexts: ['image'],
		});
		browser.contextMenus.create({
			id: MENU_PAGE_ID,
			title: 'Στιγμιότυπο σελίδας στο Moodboard',
			contexts: ['page'],
		});
	});
}

export default defineBackground(() => {
	browser.runtime.onInstalled.addListener(createMenus);
	browser.runtime.onStartup.addListener(createMenus);

	browser.contextMenus.onClicked.addListener(async (info, tab) => {
		if (info.menuItemId === MENU_IMAGE_ID) {
			const srcUrl = info.srcUrl;
			if (!srcUrl) return;
			await captureImage(srcUrl, tab?.url ?? null, tab?.title ?? null);
			return;
		}
		if (info.menuItemId === MENU_PAGE_ID) {
			const tabInfo = tab ?? (await activeTab());
			await captureTab(tabInfo);
			await openPopup();
		}
	});

	browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
		const typed = message as PopupMessage | undefined;
		if (typed?.type !== 'capture-active-tab') return;
		(async () => {
			const tab = await activeTab();
			const result = await captureTab(tab);
			sendResponse(result);
		})();
		return true;
	});
});
