// "Search with ChatGPT / Claude": a link that opens a new chat with a prefilled message. The message
// is text only (tags, level, note, colors, source page). Image addresses of this app are private
// and never go in it; the user adds the images to the chat themselves.
import { t } from '#lib/i18n.js';

/** Longest message in characters. Both sites take the text in the address, so it must stay short. */
export const CHAT_PROMPT_MAX = 1500;

function cut(s: string, max: number): string {
	const chars = [...s];
	return chars.length > max ? chars.slice(0, Math.max(0, max - 1)).join('') + '…' : s;
}

/** The two links that open a new chat with `prompt` already typed in. */
export function chatLinks(prompt: string): { chatgpt: string; claude: string } {
	const q = encodeURIComponent(cut(prompt, CHAT_PROMPT_MAX));
	return { chatgpt: `https://chatgpt.com/?q=${q}`, claude: `https://claude.ai/new?q=${q}` };
}

export interface ChatPromptInput {
	projectName?: string | null;
	levelName?: string | null;
	tags?: string[];
	note?: string;
	colors?: string[];
	sourceUrl?: string | null;
	/** What the user wants to find, in their own words. */
	want?: string;
}

/** The message: what the user knows about the image, then what they want. At most CHAT_PROMPT_MAX characters. */
export function buildChatPrompt(i: ChatPromptInput): string {
	const source = i.sourceUrl && /^https?:\/\//i.test(i.sourceUrl) ? i.sourceUrl : '';
	const head = (note: string) =>
		[
			t('chat.intro'),
			i.projectName && `${t('chat.pProject')}: ${i.projectName}`,
			i.levelName && `${t('chat.pLevel')}: ${i.levelName}`,
			i.tags?.length && `${t('chat.pTags')}: ${i.tags.join(', ')}`,
			i.colors?.length && `${t('chat.pColors')}: ${i.colors.join(', ')}`,
			note && `${t('chat.pNote')}: ${note}`,
			source && `${t('chat.pSource')}: ${source}`
		]
			.filter(Boolean)
			.join('\n');
	const want = cut((i.want ?? '').trim(), 600);
	const tail = want ? `\n\n${want}` : '';
	const note = (i.note ?? '').trim().replace(/\s+/g, ' ');
	let out = head(note) + tail;
	if (out.length > CHAT_PROMPT_MAX && note) {
		const over = out.length - CHAT_PROMPT_MAX;
		out = head(cut(note, Math.max(0, note.length - over - 1))) + tail;
		if (out.length > CHAT_PROMPT_MAX) out = head('') + tail;
	}
	if (out.length > CHAT_PROMPT_MAX) out = cut(head(''), CHAT_PROMPT_MAX - tail.length) + tail;
	return out;
}
