// Pure parts of the smart-search features: the chat links and prompt, and the project draft text.
import { describe, expect, it } from 'vitest';
import { buildChatPrompt, chatLinks, CHAT_PROMPT_MAX } from '../src/lib/chatlinks';
import { composeDraft, type DraftPart } from '../src/lib/semantic';
import { toInspiration } from '../src/lib/inspirations';

describe('chatLinks', () => {
	it('puts the escaped text in the q parameter of each site', () => {
		const l = chatLinks('φως & σκιά?\nδεύτερη γραμμή');
		const q = encodeURIComponent('φως & σκιά?\nδεύτερη γραμμή');
		expect(l.chatgpt).toBe(`https://chatgpt.com/?q=${q}`);
		expect(l.claude).toBe(`https://claude.ai/new?q=${q}`);
		expect(l.chatgpt).not.toContain(' ');
		expect(l.chatgpt).not.toContain('&σκιά');
	});

	it('cuts a very long text so the link stays usable', () => {
		const l = chatLinks('α'.repeat(CHAT_PROMPT_MAX + 500));
		const q = decodeURIComponent(l.claude.split('?q=')[1]);
		expect(q.length).toBeLessThanOrEqual(CHAT_PROMPT_MAX);
		expect(q.endsWith('…')).toBe(true);
	});
});

describe('buildChatPrompt', () => {
	const base = {
		projectName: 'Λιμάνι',
		levelName: 'Κτίριο',
		tags: ['beton', 'φως'],
		note: 'ωραίος ρυθμός ανοιγμάτων',
		colors: ['#aabbcc', '#102030'],
		sourceUrl: 'https://example.com/a',
		want: 'βρες παρόμοια έργα'
	};

	it('lists what the user knows about the image, then what they want', () => {
		const p = buildChatPrompt(base);
		for (const part of ['Λιμάνι', 'Κτίριο', 'beton', 'φως', 'ωραίος ρυθμός ανοιγμάτων', '#aabbcc', 'https://example.com/a']) {
			expect(p).toContain(part);
		}
		expect(p.indexOf('βρες παρόμοια έργα')).toBeGreaterThan(p.indexOf('beton'));
	});

	it('leaves out what is missing and never prints an empty label', () => {
		const p = buildChatPrompt({ want: 'κάτι' });
		expect(p).toContain('κάτι');
		expect(p).not.toMatch(/:\s*$/m);
	});

	it('drops a source that is not http(s)', () => {
		expect(buildChatPrompt({ ...base, sourceUrl: 'javascript:alert(1)' })).not.toContain('javascript:');
		expect(buildChatPrompt({ ...base, sourceUrl: 'data:text/html,x' })).not.toContain('data:');
	});

	it('keeps the free text when the rest is long', () => {
		const p = buildChatPrompt({ ...base, note: 'ν'.repeat(5000), want: 'ΤΕΛΙΚΟ ΑΙΤΗΜΑ' });
		expect(p.length).toBeLessThanOrEqual(CHAT_PROMPT_MAX);
		expect(p).toContain('ΤΕΛΙΚΟ ΑΙΤΗΜΑ');
	});
});

describe('composeDraft', () => {
	const parts: DraftPart[] = [
		{ text: 'Ένα project για ' },
		{ choices: ['σπίτια', 'καταφύγια', 'βίλες'] },
		{ text: ' με φως και ' },
		{ choices: ['ξύλο', 'μπετόν'] },
		{ text: '.' }
	];

	it('takes the first choice of each place by default', () => {
		expect(composeDraft(parts, {})).toBe('Ένα project για σπίτια με φως και ξύλο.');
	});

	it('takes the picked choice of a place', () => {
		expect(composeDraft(parts, { 1: 2, 3: 1 })).toBe('Ένα project για βίλες με φως και μπετόν.');
	});

	it('ignores a pick outside the choices', () => {
		expect(composeDraft(parts, { 1: 9, 3: -1 })).toBe('Ένα project για σπίτια με φως και ξύλο.');
	});
});

describe('toInspiration colors', () => {
	const base = { id: 'x', created_at: '', updated_at: '' };
	it('keeps #rrggbb strings only', () => {
		expect(toInspiration({ ...base, colors: ['#aabbcc', 'red', 5, '#12345', '#ABCDEF'] } as never).colors).toEqual(['#aabbcc', '#abcdef']);
	});
	it('is empty when missing or malformed', () => {
		expect(toInspiration(base as never).colors).toEqual([]);
		expect(toInspiration({ ...base, colors: 'x' } as never).colors).toEqual([]);
	});
});
