<script lang="ts">
	import { untrack } from 'svelte';
	import type PocketBase from 'pocketbase';
	import { t } from '#lib/i18n.js';
	import { listInspirationsByIds } from '#lib/inspirations.js';
	import { similarTo } from '#lib/semantic.js';
	import { smart } from '#lib/smart.svelte.js';
	import { cleanSourceProject, similarSourceProject, SOURCE_PROJECT_MAX } from '#lib/sourceProjects.js';

	// One image's source project: free text with the names already in use as suggestions.
	interface Props {
		value: string | null;
		/** Names in use, for the suggestions list. */
		names: string[];
		/** The cleaned name, or null when the user emptied the field. */
		onchange: (value: string | null) => void;
		/** With both: while the field is empty, offer the name the images that look like this one share. */
		pb?: PocketBase;
		id?: string;
	}
	let { value, names, onchange, pb, id }: Props = $props();

	const uid = $props.id();
	const listId = `sp-${uid}`;
	let draft = $state('');
	// Show the stored value, but not while the draft already means the same name: saving as the
	// user types hands back the cleaned name, and replacing the draft would eat a typed space.
	$effect(() => {
		const stored = value ?? '';
		if (stored !== (cleanSourceProject(untrack(() => draft)) ?? '')) draft = stored;
	});

	// Offer, never set: the user decides with one click. A new image gets its vector a few seconds
	// after upload, so ask again a few times while the server says it is not ready.
	const empty = $derived(!value);
	let offer = $state<string | null>(null);
	$effect(() => {
		const imageId = id;
		const client = pb;
		offer = null;
		if (!client || !imageId || !empty || !smart.embed) return;
		let gone = false;
		(async () => {
			for (let round = 1; round <= 4 && !gone; round++) {
				try {
					const r = await similarTo(client, imageId, 'all', 10);
					if (gone) return;
					if (r.ready) {
						const rows = await listInspirationsByIds(client, r.results.map((h) => h.id));
						if (!gone) offer = similarSourceProject(r.results, new Map(rows.map((x) => [x.id, x.source_project])));
						return;
					}
				} catch {
					return;
				}
				await new Promise((done) => setTimeout(done, 3000 * round));
			}
		})();
		return () => {
			gone = true;
		};
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
{#if offer && empty}
	<p class="offer">
		<span>{t('sp.similar', { name: offer })}</span>
		<button type="button" class="btn ghost" onclick={() => offer && onchange(offer)}>{t('sp.suggest.apply')}</button>
	</p>
{/if}

<style>
	.field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
	.lbl { font-size: 12.5px; font-weight: 600; color: var(--muted); }
	input { min-width: 0; }
	.offer { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; margin: -2px 0 0; font-size: 12.5px; color: var(--muted); }
	.offer .btn { min-height: 28px; padding: 2px 8px; color: var(--accent); font-weight: 600; }
</style>
