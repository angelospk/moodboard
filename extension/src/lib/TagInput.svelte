<script lang="ts">
	let {
		tags = $bindable<string[]>([]),
		suggestions = [],
		placeholder = '',
	}: {
		tags?: string[];
		suggestions?: string[];
		placeholder?: string;
	} = $props();

	const MAX_TAGS = 30;
	const MAX_SUGGESTIONS = 12;

	let draft = $state('');
	let inputEl: HTMLInputElement | null = $state(null);

	const visibleSuggestions = $derived.by(() => {
		const query = draft.trim().toLowerCase();
		const chosen = new Set(tags);
		return suggestions
			.filter((tag) => !chosen.has(tag) && (query === '' || tag.toLowerCase().includes(query)))
			.slice(0, MAX_SUGGESTIONS);
	});

	/** Add raw text: split on commas, trim, lowercase, dedupe, cap at MAX_TAGS. */
	function add(raw: string) {
		const next = [...tags];
		const seen = new Set(next);
		for (const part of raw.split(',')) {
			const tag = part.trim().toLowerCase();
			if (!tag || seen.has(tag)) continue;
			if (next.length >= MAX_TAGS) break;
			seen.add(tag);
			next.push(tag);
		}
		tags = next;
	}

	function commit() {
		if (!draft.trim()) return;
		add(draft);
		draft = '';
	}

	function remove(tag: string) {
		tags = tags.filter((item) => item !== tag);
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			if (!draft.trim()) return; // empty input: keep default behaviour
			event.preventDefault();
			commit();
			return;
		}
		if (event.key === ',') {
			event.preventDefault();
			commit();
			return;
		}
		if (event.key === 'Backspace' && draft === '' && tags.length > 0) {
			event.preventDefault();
			remove(tags[tags.length - 1]!);
		}
	}

	function onpaste(event: ClipboardEvent) {
		const text = event.clipboardData?.getData('text') ?? '';
		if (!text.includes(',')) return;
		event.preventDefault();
		add(`${draft},${text}`);
		draft = '';
	}

	function onblur() {
		commit();
	}

	function pick(tag: string) {
		commit();
		add(tag);
		inputEl?.focus();
	}
</script>

<div class="tagbox">
	{#each tags as tag (tag)}
		<span class="chip">
			{tag}
			<button type="button" class="x" aria-label={`Αφαίρεση ${tag}`} onclick={() => remove(tag)}>×</button>
		</span>
	{/each}
	<input
		bind:this={inputEl}
		bind:value={draft}
		{placeholder}
		onkeydown={onkeydown}
		onpaste={onpaste}
		onblur={onblur}
	/>
</div>

{#if visibleSuggestions.length > 0}
	<div class="suggestions">
		{#each visibleSuggestions as tag (tag)}
			<button type="button" class="suggest" onclick={() => pick(tag)}>{tag}</button>
		{/each}
	</div>
{/if}

<style>
	.tagbox {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
		padding: 4px 6px;
		min-height: 30px;
		border: 1px solid #cfcfcf;
		border-radius: 6px;
		background: #fff;
		box-sizing: border-box;
		cursor: text;
	}
	.tagbox:focus-within {
		border-color: #1b5e64;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		padding: 1px 3px 1px 7px;
		border-radius: 999px;
		background: #eef4f4;
		border: 1px solid #cfcfcf;
		font-size: 0.75rem;
		line-height: 1.5;
		white-space: nowrap;
	}
	.x {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 15px;
		height: 15px;
		padding: 0;
		border: none;
		border-radius: 50%;
		background: none;
		color: #6b6b6b;
		font-size: 0.8rem;
		line-height: 1;
		cursor: pointer;
	}
	.x:hover {
		background: #dbe7e7;
		color: #171717;
	}
	.tagbox input {
		flex: 1 1 60px;
		width: auto;
		min-width: 60px;
		padding: 2px 3px;
		margin: 0;
		border: none;
		outline: none;
		background: none;
		font: inherit;
		font-size: 0.8rem;
		color: inherit;
	}
	.suggestions {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 4px;
	}
	.suggest {
		padding: 2px 7px;
		border-radius: 999px;
		border: 1px solid #cfcfcf;
		background: #fbfbfa;
		color: #1b5e64;
		font: inherit;
		font-size: 0.72rem;
		line-height: 1.5;
		cursor: pointer;
	}
	.suggest:hover {
		border-color: #1b5e64;
		background: #eef4f4;
	}
</style>
