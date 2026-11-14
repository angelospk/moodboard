<script lang="ts">
	import type PocketBase from 'pocketbase';
	import { tick } from 'svelte';
	import { t } from '#lib/i18n.js';
	import { updateMany } from '#lib/inspirations.js';
	import { reloadData } from '#lib/reload.js';
	import { cleanSourceProject, commonSourceProject, SOURCE_PROJECT_MAX } from '#lib/sourceProjects.js';
	import type { Inspiration } from '#lib/types.js';

	// «Πηγές»: the source project of every image of one web page, in one small field. Enter or
	// leaving the field saves; with mixed names an empty field changes nothing.
	interface Props {
		pb: PocketBase;
		items: Inspiration[];
		/** The page's datalist of the names in use. */
		listId: string;
	}
	let { pb, items, listId }: Props = $props();

	const common = $derived(commonSourceProject(items));
	let draft = $state('');
	let busy = $state(false);
	let failed = $state(false);
	// Show the stored name again whenever it changes (after a save, or from elsewhere).
	$effect(() => {
		draft = common.mixed ? '' : (common.name ?? '');
	});

	async function save() {
		const name = cleanSourceProject(draft);
		if (busy || (common.mixed && !name)) return;
		const ids = items.filter((i) => cleanSourceProject(i.source_project) !== name).map((i) => i.id);
		if (!ids.length) return;
		busy = true;
		failed = false;
		try {
			const out = await updateMany(pb, ids, { source_project: name });
			failed = out.failed.length > 0;
			await reloadData();
			// Some images kept the old name: the field shows the new one again, so Enter retries.
			if (failed) {
				await tick();
				draft = name ?? '';
			}
		} finally {
			busy = false;
		}
	}
</script>

<span class="spp">
	<input
		type="text"
		list={listId}
		bind:value={draft}
		placeholder={common.mixed && common.name ? t('sp.page.mixed', { name: common.name }) : t('sp.label')}
		aria-label={t('sp.page.label')}
		title={t('sp.page.label')}
		maxlength={SOURCE_PROJECT_MAX}
		autocomplete="off"
		readonly={busy}
		onchange={save}
		onkeydown={(e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				void save();
			}
		}}
	/>
	{#if failed}<span class="err" role="status">{t('sp.page.failed')}</span>{/if}
</span>

<style>
	.spp { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; flex: 0 1 220px; min-width: 120px; }
	input { width: 100%; min-width: 0; min-height: 32px; padding: 4px 8px; font-size: 12.5px; }
	.err { font-size: 12.5px; color: var(--accent); white-space: nowrap; }
</style>
