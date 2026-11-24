<script lang="ts">
	import { t } from '#lib/i18n.js';
	import type PocketBase from 'pocketbase';
	import { imageUrls, listInspirationsByIds, thumbUrl } from '#lib/inspirations.js';
	import { similarTo } from '#lib/semantic.js';
	import type { Inspiration } from '#lib/types.js';
	import { smart } from '#lib/smart.svelte.js';
	import CropImg from '#lib/components/CropImg.svelte';

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

	/** At most this many: the server already keeps only images that stand out from the rest. */
	const LIMIT = 8;

	function toggle(itemId: string) {
		selected = selected.includes(itemId) ? selected.filter((x) => x !== itemId) : [...selected, itemId];
	}

	/** Reload the list (after the caller changed some of the images). */
	export function refresh() {
		again++;
	}

	let scope = $state<'project' | 'all'>('project');
	let phase = $state<'loading' | 'ready' | 'hidden'>('loading');
	let items = $state<Inspiration[]>([]);
	let urls = $state<Record<string, string>>({});
	/** This project has none, but other projects do: the row stays, so the user can switch. */
	let elsewhere = $state(false);
	let again = $state(0);
	let latest = 0;

	$effect(() => {
		const s = scope;
		const imageId = id;
		void again;
		selected = [];
		if (!enabled) {
			selecting = false;
			phase = 'hidden';
			return;
		}
		const mine = ++latest;
		phase = 'loading';
		(async () => {
			try {
				const r = await similarTo(pb, imageId, s, LIMIT);
				if (mine !== latest) return;
				// Nothing alike (or no vector yet): no section at all, unless other projects have some.
				let other = false;
				if (r.ready && !r.results.length && s === 'project') {
					const all = await similarTo(pb, imageId, 'all', 1);
					if (mine !== latest) return;
					other = all.results.length > 0;
				}
				const rows = r.results.length ? await listInspirationsByIds(pb, r.results.map((h) => h.id)) : [];
				const u = await imageUrls(pb, rows);
				if (mine !== latest) return;
				[items, urls, elsewhere] = [rows, u, other];
				// A tick made on the old tiles must not reach the new list.
				selected = [];
				phase = rows.length || other ? 'ready' : 'hidden';
				if (!rows.length) selecting = false;
			} catch {
				if (mine === latest) phase = 'hidden';
			}
		})();
	});
</script>

{#if enabled && (phase === 'ready' || (phase === 'loading' && (items.length || elsewhere)))}
	<section class="similar" class:busy={phase === 'loading'} aria-label={t('similar.title')} aria-busy={phase === 'loading'}>
		<div class="head">
			<span class="lbl">{t('similar.title')}</span>
			<div class="seg" role="group" aria-label={t('similar.title')}>
				<button type="button" class={['chip', scope === 'project' && 'on']} aria-pressed={scope === 'project'} onclick={() => (scope = 'project')}>{t('similar.scopeProject')}</button>
				<button type="button" class={['chip', scope === 'all' && 'on']} aria-pressed={scope === 'all'} onclick={() => (scope = 'all')}>{t('similar.scopeAll')}</button>
				{#if selectable && items.length}
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
		</div>

		{#if items.length === 0}
			<p class="msg">{t('similar.onlyElsewhere')}</p>
		{:else}
			<ul class="strip">
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
								disabled={phase === 'loading'}
								onclick={() => toggle(it.id)}
							>
								{@render thumb(it)}
								<span class="tick" aria-hidden="true">{selected.includes(it.id) ? '✓' : ''}</span>
							</button>
						{:else if onpick}
							<button type="button" class="tile" aria-label={label} disabled={phase === 'loading'} onclick={() => onpick(it.id)}>{@render thumb(it)}</button>
						{:else}
							<!-- The image page keeps its editor state per page load, so another image needs a fresh load. -->
							<a class="tile" href={`/i/${it.id}`} data-sveltekit-reload aria-label={label}>{@render thumb(it)}</a>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{/if}

{#snippet thumb(it: Inspiration)}
	{#if urls[it.image_path]}
		<CropImg src={thumbUrl(urls[it.image_path]) ?? ''} crop={it.crop} fit="cover" />
	{:else}
		<span class="missing">{t('common.noImage')}</span>
	{/if}
{/snippet}

<style>
	.similar {
		display: grid;
		gap: 8px;
		animation: sim-in 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
		transition: opacity 150ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.similar.busy {
		opacity: 0.55;
	}
	/* Old results while the new ones load: no clicks (links included). */
	.similar.busy .strip {
		pointer-events: none;
	}
	@keyframes sim-in {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.similar {
			animation: none;
		}
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
	/* One row under the image, scrolled sideways: the picture above stays the main thing. */
	.strip {
		list-style: none;
		margin: 0;
		padding: 0 0 4px;
		display: flex;
		gap: 6px;
		overflow-x: auto;
		scroll-snap-type: x proximity;
		scrollbar-width: thin;
		scrollbar-color: var(--line-strong) transparent;
	}
	.strip li {
		flex: none;
		width: var(--sim-tile, 72px);
		scroll-snap-align: start;
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
		transition: transform 150ms cubic-bezier(0.2, 0.8, 0.2, 1), box-shadow 150ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.tile:hover {
		transform: translateY(-1px);
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.06), 0 8px 24px -12px rgb(0 0 0 / 0.25);
	}
	.tile:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	@media (prefers-reduced-motion: reduce) {
		.tile {
			transition: none;
		}
	}
	.tile.picked {
		outline: 3px solid var(--accent);
		outline-offset: -3px;
	}
	.tile.picked :global(img) {
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
	.missing {
		display: grid;
		place-items: center;
		height: 100%;
		font-size: 11px;
		color: var(--faint);
	}
</style>
