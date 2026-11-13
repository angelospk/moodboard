<script lang="ts">
	import { t } from '#lib/i18n.js';
	import type PocketBase from 'pocketbase';
	import { imageUrls, listInspirationsByIds, thumbUrl } from '#lib/inspirations.js';
	import { similarTo } from '#lib/semantic.js';
	import type { Inspiration } from '#lib/types.js';
	import { needSmart, smart } from '#lib/smart.svelte.js';

	// Images that look like image `id`, from its own project or from all projects. The server compares
	// the stored vectors, so this makes no model call.
	interface Props {
		pb: PocketBase;
		id: string;
		/** Open a result in place (the map selects it); without it a result links to its image page. */
		onpick?: (id: string) => void;
		/** Show a "Select" switch: the user can tick results (the image page acts on them). */
		selectable?: boolean;
		/** The ticked result ids (bind). Emptied when selecting ends or the list changes. */
		selected?: string[];
		/** True while the user is ticking results (bind). */
		selecting?: boolean;
	}
	let { pb, id, onpick, selectable = false, selected = $bindable([]), selecting = $bindable(false) }: Props = $props();
	const enabled = $derived(smart.embed);
	let enabling = $state(false);

	function toggle(itemId: string) {
		selected = selected.includes(itemId) ? selected.filter((x) => x !== itemId) : [...selected, itemId];
	}

	async function enable() {
		enabling = true;
		await needSmart('embed');
		enabling = false;
	}

	/** Reload the list (after the caller changed some of the images). */
	export function refresh() {
		again++;
	}

	let scope = $state<'project' | 'all'>('project');
	let phase = $state<'loading' | 'ready' | 'notReady' | 'failed'>('loading');
	let items = $state<Inspiration[]>([]);
	let urls = $state<Record<string, string>>({});
	let again = $state(0);
	let latest = 0;

	$effect(() => {
		const s = scope;
		const imageId = id;
		void again;
		if (!enabled) return;
		const mine = ++latest;
		phase = 'loading';
		selected = [];
		(async () => {
			try {
				const r = await similarTo(pb, imageId, s);
				if (mine !== latest) return;
				if (!r.ready) {
					items = [];
					phase = 'notReady';
					return;
				}
				const rows = await listInspirationsByIds(pb, r.results.map((h) => h.id));
				const u = await imageUrls(pb, rows);
				if (mine !== latest) return;
				items = rows;
				urls = u;
				phase = 'ready';
			} catch {
				if (mine === latest) phase = 'failed';
			}
		})();
	});
</script>

<section class="similar" aria-label={t('similar.title')}>
	<div class="head">
		<span class="lbl">{t('similar.title')}</span>
		{#if enabled}
			<div class="seg" role="group" aria-label={t('similar.title')}>
				<button type="button" class={['chip', scope === 'project' && 'on']} aria-pressed={scope === 'project'} onclick={() => (scope = 'project')}>{t('similar.scopeProject')}</button>
				<button type="button" class={['chip', scope === 'all' && 'on']} aria-pressed={scope === 'all'} onclick={() => (scope = 'all')}>{t('similar.scopeAll')}</button>
				{#if selectable && phase === 'ready' && items.length}
					<button
						type="button"
						class={['chip', 'soft', selecting && 'on']}
						aria-pressed={selecting}
						onclick={() => {
							selecting = !selecting;
							if (!selecting) selected = [];
						}}
					>
						{selecting ? t('bulk.done') : t('bulk.select')}
					</button>
				{/if}
			</div>
		{/if}
	</div>

	{#if !enabled}
		<p class="msg">
			{t('similar.off')}
			<button type="button" class="btn enable" disabled={enabling} onclick={enable}>{t('smart.enable')}</button>
		</p>
	{:else if phase === 'loading'}
		<p class="msg">{t('common.loading')}</p>
	{:else if phase === 'notReady'}
		<p class="msg">{t('similar.notReady')} <button type="button" class="again" onclick={() => again++}>↻</button></p>
	{:else if phase === 'failed'}
		<p class="msg">{t('similar.failed')} <button type="button" class="again" onclick={() => again++}>↻</button></p>
	{:else if items.length === 0}
		<p class="msg">{t('similar.none')}</p>
	{:else}
		<ul class="grid">
			{#each items as it (it.id)}
				{@const label = it.note ? it.note.slice(0, 60) : t('item.alt')}
				<li>
					{#if selecting}
						<button
							type="button"
							class={['tile', selected.includes(it.id) && 'picked']}
							role="checkbox"
							aria-checked={selected.includes(it.id)}
							aria-label={`${t('bulk.check')}: ${label}`}
							onclick={() => toggle(it.id)}
						>
							{@render thumb(it)}
							<span class="tick" aria-hidden="true">{selected.includes(it.id) ? '✓' : ''}</span>
						</button>
					{:else if onpick}
						<button type="button" class="tile" aria-label={label} onclick={() => onpick(it.id)}>{@render thumb(it)}</button>
					{:else}
						<!-- The image page keeps its editor state per page load, so another image needs a fresh load. -->
						<a class="tile" href={`/i/${it.id}`} data-sveltekit-reload aria-label={label}>{@render thumb(it)}</a>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

{#snippet thumb(it: Inspiration)}
	{#if urls[it.image_path]}
		<img src={thumbUrl(urls[it.image_path])} alt="" loading="lazy" decoding="async" />
	{:else}
		<span class="missing">{t('common.noImage')}</span>
	{/if}
{/snippet}

<style>
	.similar {
		display: grid;
		gap: 8px;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		justify-content: space-between;
	}
	.lbl {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--muted);
	}
	.seg {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.msg {
		margin: 0;
		font-size: 13px;
		color: var(--muted);
	}
	.again {
		border: 0;
		background: none;
		padding: 0 4px;
		font-size: 15px;
		color: var(--text);
	}
	.grid {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 6px;
	}
	.tile {
		position: relative;
		display: block;
		width: 100%;
		padding: 0;
		border: 0;
		aspect-ratio: 1;
		overflow: hidden;
		border-radius: var(--r-ctl);
		background: var(--sunk);
		cursor: pointer;
	}
	.tile.picked {
		outline: 3px solid var(--accent);
		outline-offset: -3px;
	}
	.tile.picked img {
		opacity: 0.8;
	}
	.tick {
		position: absolute;
		top: 5px;
		right: 5px;
		display: grid;
		place-items: center;
		width: 20px;
		height: 20px;
		border-radius: var(--r-pill);
		border: 1.5px solid #fff;
		background: rgb(0 0 0 / 0.35);
		color: #fff;
		font-size: 12px;
		line-height: 1;
	}
	.picked .tick {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--on-accent);
	}
	.enable {
		margin-left: 6px;
		font-size: 12.5px;
		padding: 3px 10px;
	}
	.grid img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}
	.missing {
		display: grid;
		place-items: center;
		height: 100%;
		font-size: 11px;
		color: var(--faint);
	}
</style>
