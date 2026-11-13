<script lang="ts">
	import { t } from '#lib/i18n.js';
	import type PocketBase from 'pocketbase';
	import type { Level } from '#lib/types.js';
	import { levelLabel } from '#lib/levels.svelte.js';
	import { knnSuggest } from '#lib/semantic.js';
	import { suggestStored } from '#lib/suggest.js';
	import { needSmart, smart } from '#lib/smart.svelte.js';

	// Label ideas for an image that is already saved, as chips the user presses one by one:
	// - from the labels of the most similar images (free: stored vectors, no model call), when smart
	//   search is on;
	// - from the AI, only when the user presses the button (one model call; asks for consent first).
	// Chips already applied are hidden. Used on the image page and in the map panel.
	interface Props {
		pb: PocketBase;
		id: string;
		tags: string[];
		level: Level | null;
		onaddtag: (tag: string) => void;
		onsetlevel: (level: Level) => void;
	}
	let { pb, id, tags, level, onaddtag, onsetlevel }: Props = $props();

	let knn = $state<{ level: string | null; tags: string[] } | null>(null);
	let ai = $state<{ level: string | null; tags: string[] } | null>(null);
	let aiState = $state<'idle' | 'busy' | 'none' | 'limit' | 'failed' | 'off'>('idle');

	$effect(() => {
		const imageId = id;
		knn = null;
		ai = null;
		aiState = 'idle';
		if (!smart.embed) return;
		let alive = true;
		knnSuggest(pb, imageId)
			.then((r) => alive && (knn = r.ready ? { level: r.level, tags: r.tags } : null))
			.catch(() => {});
		return () => {
			alive = false;
		};
	});

	/** What is left of a suggestion after removing what the image already has. */
	function rest(s: { level: string | null; tags: string[] } | null) {
		if (!s) return { level: null, tags: [] as string[] };
		return {
			level: s.level && s.level !== level && levelLabel(s.level) ? s.level : null,
			tags: s.tags.filter((x) => !tags.includes(x))
		};
	}
	const knnLeft = $derived(rest(knn));
	const aiLeft = $derived(rest(ai));

	async function askAi() {
		if (aiState === 'busy') return;
		const imageId = id;
		if (!(await needSmart('ai'))) return;
		aiState = 'busy';
		const r = await suggestStored(pb, imageId);
		if (imageId !== id) return;
		if (r.kind !== 'ok') {
			aiState = r.kind;
			return;
		}
		ai = { level: r.level || null, tags: r.tags };
		const left = rest(ai);
		aiState = left.level || left.tags.length ? 'idle' : 'none';
	}
</script>

{#snippet chips(s: { level: string | null; tags: string[] })}
	<div class="chips">
		{#if s.level}
			{@const l = s.level}
			<button type="button" class="chip soft" onclick={() => onsetlevel(l)}>{levelLabel(l)}</button>
		{/if}
		{#each s.tags as tg (tg)}
			<button type="button" class="chip soft" onclick={() => onaddtag(tg)}>+ {tg}</button>
		{/each}
	</div>
{/snippet}

<div class="smart">
	{#if knnLeft.level || knnLeft.tags.length}
		<div class="part">
			<span class="lbl">{t('knn.title')}</span>
			{@render chips(knnLeft)}
		</div>
	{/if}

	{#if aiLeft.level || aiLeft.tags.length}
		<div class="part">
			<span class="lbl">{t('suggestAi.title')}</span>
			{@render chips(aiLeft)}
		</div>
	{:else}
		<div class="part row">
			<button type="button" class="btn ask" disabled={aiState === 'busy'} onclick={askAi}>
				{aiState === 'busy' ? t('suggestAi.busy') : t('suggestAi.button')}
			</button>
			{#if aiState === 'none'}
				<span class="msg">{t('suggestAi.none')}</span>
			{:else if aiState === 'limit'}
				<span class="msg">{t('suggestAi.limit')}</span>
			{:else if aiState === 'failed'}
				<span class="msg">{t('suggestAi.failed')}</span>
			{:else if aiState === 'off'}
				<span class="msg">{t('suggestAi.off')}</span>
			{/if}
		</div>
	{/if}
	{#if knnLeft.level || knnLeft.tags.length || aiLeft.level || aiLeft.tags.length}
		<p class="msg">{t('suggestAi.hint')}</p>
	{/if}
</div>

<style>
	.smart {
		display: grid;
		gap: 10px;
	}
	.part {
		display: grid;
		gap: 6px;
	}
	.part.row {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.lbl {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--muted);
	}
	.chips {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.chip {
		min-height: 30px;
	}
	.ask {
		font-size: 13px;
	}
	.ask:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.msg {
		margin: 0;
		font-size: 12.5px;
		color: var(--muted);
	}
	@media (pointer: coarse) {
		.chip {
			min-height: 40px;
		}
	}
</style>
