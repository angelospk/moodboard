<script lang="ts">
	import { t } from '#lib/i18n.js';
	// Read-only view of a public board: the owner's layout, images and what the owner chose to show.
	// Nothing here writes: the board gets canSave=false and no-op callbacks, and the server has no write route.
	import Board from '../../map/Board.svelte';
	import TagChips from '../../map/TagChips.svelte';
	import Icon from '../../map/Icon.svelte';
	import ImageViewer from '#lib/components/ImageViewer.svelte';
	import { viewerList, zoneColors } from '../../map/board.js';
	import PocketBase, { BaseAuthStore } from 'pocketbase';
	import { PB_URL } from '#lib/pb.js';
	import { publicImageUrl } from '#lib/share.js';
	import { neighborUrls } from '#lib/prefetch.js';
	import { hostOf } from '#lib/sources.js';
	import type { Inspiration } from '#lib/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Board wants a client only to save positions (off here); this one has no session at all.
	const anon = new PocketBase(PB_URL, new BaseAuthStore());
	const items = $derived(data.board?.inspirations ?? []);
	let notesOn = $state(true);
	let highlight = $state<string | null>(null);
	let selectedId = $state<string | null>(null);
	let board = $state<ReturnType<typeof Board>>();

	const tagStats = $derived.by(() => {
		const count = new Map<string, number>();
		for (const i of items) for (const t of new Set(i.tags)) count.set(t, (count.get(t) ?? 0) + 1);
		return [...count].map(([tag, n]) => ({ tag, count: n })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
	});
	const colors = $derived(zoneColors(tagStats.map((t) => t.tag)));
	const urlOf = (i: Inspiration) => publicImageUrl(data.id, i.id);
	const hasNotes = $derived(items.some((i) => i.note || i.regions.length));
	const selected = $derived(items.find((i) => i.id === selectedId) ?? null);
	/** Only http(s) sources become links (a javascript: URL would run here). */
	const sourceHost = $derived(hostOf(selected?.source_url));
	const noop = () => {};

	// A click on a card opens it full screen (a visitor cannot edit, so there is no panel).
	// The arrows step only through the opened card's zone tag, until the visitor picks another chip.
	let viewId = $state<string | null>(null);
	let viewTag = $state<string | null>(null);
	const viewList = $derived(viewerList(items, viewTag));
	const viewIndex = $derived(viewId ? viewList.findIndex((i) => i.id === viewId) : -1);
	const viewItem = $derived(viewIndex >= 0 ? viewList[viewIndex] : null);
	const viewTags = $derived(tagStats.map((s) => ({ ...s, color: colors.get(s.tag)?.dark })));
	function viewStep(dir: -1 | 1) {
		const next = viewList[viewIndex + dir];
		if (next) viewId = next.id;
	}
	function openView(id: string) {
		viewTag = items.find((i) => i.id === id)?.tags?.[0] ?? null;
		viewId = id;
	}
	function pickViewTag(tag: string | null) {
		const list = viewerList(items, tag);
		if (!list.length) return;
		viewTag = tag;
		if (!list.some((i) => i.id === viewId)) viewId = list[0].id;
	}
</script>

<svelte:head>
	<title>{data.board?.project.name ?? t('public.title')} · Moodboard</title>
	<meta name="referrer" content="no-referrer" />
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="page">
	<header class="bar">
		<div class="title">
			<span class="brand">Moodboard</span>
			{#if data.board}<h1>{data.board.project.name}</h1>{/if}
		</div>
		<span class="ro">{t('public.readOnly')}</span>
		{#if data.board}
			<div class="actions">
				{#if hasNotes}<button type="button" class="btn ghost" aria-pressed={notesOn} onclick={() => (notesOn = !notesOn)} title={t('common.notes')}>
					<Icon name="notes" size={15} /> {t('common.notes')}
				</button>{/if}
				<button type="button" class="btn ghost" onclick={() => board?.fit()} title={t('common.fit')}>
					<Icon name="fit" size={15} />
				</button>
			</div>
		{/if}
	</header>

	{#if data.board?.project.description}
		<p class="desc">{data.board.project.description}</p>
	{/if}
	{#if tagStats.length}
		<div class="tagrow">
			<TagChips tags={tagStats} {colors} {highlight} ontoggle={(t) => (highlight = highlight === t ? null : t)} />
		</div>
	{/if}

	<div class="body">
		{#if data.error}
			<p class="msg">{data.error}</p>
		{:else if !items.length}
			<p class="msg">{t('public.empty')}</p>
		{:else}
			<Board
				bind:this={board}
				pb={anon}
				{items}
				{urlOf}
				{colors}
				size={260}
				{notesOn}
				{selectedId}
				{highlight}
				matches={null}
				scope="shared"
				seed={data.board?.positions ?? {}}
				canSave={false}
				rightInset={0}
				onselect={(id) => ((selectedId = id), openView(id))}
				onbackground={() => (selectedId = null)}
				oncontext={noop}
				onfiles={noop}
				onpick={noop}
				onrezone={noop}
				ontoast={noop}
			/>
		{/if}
		{#if viewItem}
			<ImageViewer
				src={urlOf(viewItem)}
				alt={viewItem.note || t('item.alt')}
				sourceUrl={viewItem.source_url}
				crop={viewItem.crop}
				regions={viewItem.regions}
				tags={viewTags}
				tag={viewTag}
				position={{ n: viewIndex + 1, of: viewList.length }}
				neighbors={neighborUrls(viewList, viewIndex, urlOf)}
				ontag={pickViewTag}
				onclose={() => (viewId = null)}
				onprev={viewIndex > 0 ? () => viewStep(-1) : undefined}
				onnext={viewIndex < viewList.length - 1 ? () => viewStep(1) : undefined}
			/>
		{/if}
		{#if selected?.source_url && sourceHost}
			<a class="source" href={selected.source_url} target="_blank" rel="noopener noreferrer">
				<Icon name="open" size={14} /> {selected.source_title || sourceHost}
			</a>
		{/if}
	</div>
</div>

<style>
	.page {
		position: fixed;
		inset: 0;
		display: flex;
		flex-direction: column;
		background: var(--bg);
		overflow: hidden;
	}
	.bar {
		flex: none;
		height: 56px;
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 0 16px 0 20px;
		background: var(--surface);
		border-bottom: 1px solid var(--line);
		position: relative;
		z-index: 20;
	}
	.title {
		display: flex;
		align-items: baseline;
		gap: 10px;
		min-width: 0;
	}
	.brand {
		color: var(--muted);
		font-size: 14px;
	}
	h1 {
		margin: 0;
		font-family: var(--font-serif);
		font-size: 18px;
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.ro {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--muted);
		border: 1px solid var(--line);
		border-radius: var(--r-pill);
		padding: 2px 10px;
		white-space: nowrap;
	}
	.actions {
		margin-left: auto;
		display: flex;
		gap: 4px;
	}
	.actions [aria-pressed='true'] {
		color: var(--accent);
	}
	.desc {
		flex: none;
		margin: 0;
		padding: 8px 20px;
		color: var(--muted);
		font-size: 14px;
		background: var(--surface);
		border-bottom: 1px solid var(--line);
		white-space: pre-line;
	}
	.tagrow {
		flex: none;
		height: 40px;
		display: flex;
		align-items: center;
		padding: 0 20px;
		background: var(--surface);
		border-bottom: 1px solid var(--line);
		position: relative;
		z-index: 10;
	}
	.body {
		position: relative;
		flex: 1;
		min-height: 0;
	}
	.msg {
		color: var(--muted);
		padding: 32px 20px;
		margin: 0;
	}
	.source {
		position: absolute;
		left: 50%;
		bottom: 24px;
		transform: translateX(-50%);
		z-index: 20;
		display: inline-flex;
		gap: 6px;
		align-items: center;
		max-width: calc(100% - 32px);
		padding: 8px 14px;
		border-radius: var(--r-pill);
		background: var(--raised);
		color: var(--text);
		font-size: 14px;
		text-decoration: none;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		box-shadow: 0 12px 32px -12px rgb(0 0 0 / 0.3), 0 0 0 1px var(--line);
	}
	@media (max-width: 640px) {
		.brand {
			display: none;
		}
		.actions .btn:first-child {
			font-size: 0;
			gap: 0;
		}
	}
</style>
