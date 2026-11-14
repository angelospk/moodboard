<script lang="ts">
	import { untrack } from 'svelte';
	import { t } from '#lib/i18n.js';
	import { cleanSourceProject, SOURCE_PROJECT_MAX } from '#lib/sourceProjects.js';

	// One image's source project: free text with the names already in use as suggestions.
	interface Props {
		value: string | null;
		/** Names in use, for the suggestions list. */
		names: string[];
		/** The cleaned name, or null when the user emptied the field. */
		onchange: (value: string | null) => void;
	}
	let { value, names, onchange }: Props = $props();

	const uid = $props.id();
	const listId = `sp-${uid}`;
	let draft = $state('');
	// Show the stored value, but not while the draft already means the same name: saving as the
	// user types hands back the cleaned name, and replacing the draft would eat a typed space.
	$effect(() => {
		const stored = value ?? '';
		if (stored !== (cleanSourceProject(untrack(() => draft)) ?? '')) draft = stored;
	});

	/** Hand the cleaned name to the caller (its autosave waits for a pause in typing). */
	function save(text: string) {
		const next = cleanSourceProject(text);
		if (next !== (value ?? null)) onchange(next);
	}

	/** Leaving the field shows the name as it is stored. */
	function tidy() {
		save(draft);
		draft = cleanSourceProject(draft) ?? '';
	}
</script>

<label class="field" title={t('sp.hint')}>
	<span class="lbl">{t('sp.label')}</span>
	<input
		type="text"
		list={listId}
		bind:value={draft}
		placeholder={t('sp.placeholder')}
		maxlength={SOURCE_PROJECT_MAX}
		autocomplete="off"
		oninput={(e) => save(e.currentTarget.value)}
		onchange={tidy}
		onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), tidy())}
	/>
	<datalist id={listId}>
		{#each names as n (n)}<option value={n}></option>{/each}
	</datalist>
</label>

<style>
	.field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
	.lbl { font-size: 12.5px; font-weight: 600; color: var(--muted); }
	input { min-width: 0; }
</style>
