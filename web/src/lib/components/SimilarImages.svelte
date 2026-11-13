<script lang="ts">
	import { t } from '#lib/i18n.js';
	import type PocketBase from 'pocketbase';
	import { imageUrls, listInspirationsByIds, thumbUrl } from '#lib/inspirations.js';
	import { similarTo } from '#lib/semantic.js';
	import type { Inspiration } from '#lib/types.js';

	// Images that look like image `id`, from its own project or from all projects. The server compares
	// the stored vectors, so this makes no model call.
	let { pb, id, enabled }: { pb: PocketBase; id: string; enabled: boolean } = $props();

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
			</div>
		{/if}
	</div>

	{#if !enabled}
		<p class="msg">{t('similar.off')}</p>
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
				<li>
					<!-- The image page keeps its editor state per page load, so another image needs a fresh load. -->
					<a href={`/i/${it.id}`} data-sveltekit-reload aria-label={it.note ? it.note.slice(0, 60) : t('item.alt')}>
						{#if urls[it.image_path]}
							<img src={thumbUrl(urls[it.image_path])} alt="" loading="lazy" decoding="async" />
						{:else}
							<span class="missing">{t('common.noImage')}</span>
						{/if}
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</section>

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
	.grid a {
		display: block;
		aspect-ratio: 1;
		overflow: hidden;
		border-radius: var(--r-ctl);
		background: var(--sunk);
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
