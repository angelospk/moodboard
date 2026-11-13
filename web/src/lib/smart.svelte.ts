// The user's two consents for smart features, shared by every page: `ai` (label suggestions, one
// image at a time) and `embed` (search by meaning and similar images: every image is analysed once).
// The switches on the home page and the buttons that need a feature all read and set this, so a
// consent given in one place shows everywhere at once.
import { pb } from '#lib/pb.js';
import { t } from '#lib/i18n.js';

export type SmartKind = 'ai' | 'embed';

export const smart = $state({ ai: false, embed: false });

function sync() {
	const r = pb.authStore.record;
	smart.ai = !!r?.ai_enabled;
	smart.embed = !!r?.embed_enabled;
}
sync();
// Sign in or out, and the SDK's own update of the signed-in record after a users update.
pb.authStore.onChange(sync);

/**
 * Turn a feature on or off for the signed-in user. Turning it on asks first, in plain words, because
 * images then go to Google. Resolves to true when the feature is now in the wanted state.
 */
export async function setSmart(kind: SmartKind, on: boolean): Promise<boolean> {
	const id = pb.authStore.record?.id;
	if (!id) return false;
	if (smart[kind] === on) return true;
	if (on && !confirm(t(kind === 'ai' ? 'ai.consent' : 'embed.consent'))) return false;
	await pb.collection('users').update(id, kind === 'ai' ? { ai_enabled: on } : { embed_enabled: on });
	smart[kind] = on;
	return true;
}

/** For a button that needs a feature: true at once when it is on, else ask to turn it on. */
export async function needSmart(kind: SmartKind): Promise<boolean> {
	if (smart[kind]) return true;
	try {
		return await setSmart(kind, true);
	} catch {
		return false;
	}
}
