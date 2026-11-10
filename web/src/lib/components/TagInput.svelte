<script lang="ts">
	import { cleanTags } from '#lib/inspirations.js';

	interface Props {
		/** Chosen tags (bindable). Always lowercase, trimmed, unique. */
		tags: string[];
		/** Past tags of the user, most used first. */
		suggestions?: string[];
		placeholder?: string;
		/** id for the text input, so a <label for> can point at it. */
		id?: string;
	}
	let { tags = $bindable([]), suggestions = [], placeholder = 'ξύλο, φως…', id }: Props = $props();

	let draft = $state('');

	/** Chips to offer: past tags not chosen yet, filtered by the draft text, at most 12. */
	const hints = $derived.by(() => {
		const q = draft.trim().toLowerCase();
		const chosen = new Set(tags.map((t) => t.toLowerCase()));
		return suggestions
			.map((s) => s.trim().toLowerCase())
			.filter((s) => s && !chosen.has(s) && (q === '' || s.includes(q)))
			.slice(0, 12);
	});

	function add(...texts: string[]) {
		const next = cleanTags([...tags, ...texts]);
		// A new array, so bindable parents see the change.
		tags = next;
	}

	function commit() {
		const text = draft;
		draft = '';
		if (!text.trim()) return;
		add(text);
	}

	function remove(tag: string) {
		tags = tags.filter((t) => t !== tag);
	}

	function onKey(e: KeyboardEvent) {
		if (e.isComposing) return;
		if (e.key === 'Enter' || e.key === ',') {
			// Empty box: let the surrounding form handle Enter (it submits).
			if (!draft.trim()) return;
			e.preventDefault();
			commit();
			return;
		}
		if (e.key === 'Backspace' && !draft && tags.length) {
			e.preventDefault();
			tags = tags.slice(0, -1);
		}
	}

	function onPaste(e: ClipboardEvent) {
		const text = e.clipboardData?.getData('text') ?? '';
		if (!text.includes(',') && !text.includes('\n')) return;
		e.preventDefault();
		const parts = [...draft.split(','), ...text.split(/[,\n]/)];
		draft = '';
		add(...parts);
	}

	function onInput(e: Event) {
		const el = e.currentTarget as HTMLInputElement;
		const text = el.value;
		// A comma typed, or IME text ending in one, commits the text before it.
		if (text.includes(',')) {
			const parts = text.split(',');
			draft = parts.pop() ?? '';
			el.value = draft;
			add(...parts);
		} else {
			draft = text;
		}
	}
</script>

<div class="tag-input">
	<div class="box">
		{#each tags as tag (tag)}
			<span class="chip">
				{tag}
				<button type="button" onclick={() => remove(tag)} aria-label={`Αφαίρεση ${tag}`}>×</button>
			</span>
		{/each}
		<input
			{id}
			{placeholder}
			value={draft}
			onkeydown={onKey}
			onpaste={onPaste}
			oninput={onInput}
			onblur={commit}
		/>
	</div>

	{#if hints.length}
		<div class="suggestions">
			{#each hints as hint (hint)}
				<button type="button" class="suggestion" onclick={() => add(hint)}>{hint}</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.tag-input { display: grid; gap: 6px; }

	.box {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
		width: 100%;
		min-height: 2.3rem;
		padding: 4px 6px;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--surface);
	}
	.box:focus-within { border-color: var(--accent); }

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		padding: 0.1rem 0.15rem 0.1rem 0.5rem;
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		color: var(--text);
		font-size: 0.8rem;
		line-height: 1.6;
		max-width: 100%;
	}
	.chip button {
		border: none;
		background: none;
		padding: 0 0.35rem;
		color: var(--muted);
		font-size: 0.95rem;
		line-height: 1.2;
		border-radius: 999px;
	}
	.chip button:hover { color: #c0392b; }

	.box input {
		flex: 1 1 8rem;
		min-width: 6rem;
		border: none;
		background: none;
		padding: 0.15rem;
		outline: none;
	}
	.box input:focus-visible { outline: none; }

	.suggestions { display: flex; flex-wrap: wrap; gap: 4px; }
	.suggestion {
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--muted);
		border-radius: 999px;
		padding: 0.1rem 0.55rem;
		font-size: 0.75rem;
		line-height: 1.6;
	}
	.suggestion:hover { color: var(--accent); border-color: var(--accent); }
</style>
