<script lang="ts">
	import { t } from '#lib/i18n.js';
	import type { Level } from '#lib/types.js';
	import { levelStore } from '#lib/levels.svelte.js';
	import Icon from './Icon.svelte';
	import TagChips from './TagChips.svelte';
	import type { ZoneColor } from './board.js';
	import type { Snippet } from 'svelte';

	interface Props {
		/** 'all', 'none' or a project id. */
		current: string;
		currentName: string;
		options: { id: string; name: string; count: number }[];
		onproject: (id: string) => void;
		search: string;
		level: Level | '';
		switcherOpen: boolean;
		filtersOpen: boolean;
		tags: { tag: string; count: number }[];
		colors: Map<string, ZoneColor>;
		highlight: string | null;
		ontoggletag: (tag: string) => void;
		/** Extra buttons at the start of the right side (the share menu). */
		actions?: Snippet;
	}
	let {
		current,
		currentName,
		options,
		onproject,
		search = $bindable(),
		level = $bindable(),
		switcherOpen = $bindable(),
		filtersOpen = $bindable(),
		tags,
		colors,
		highlight,
		ontoggletag,
		actions
	}: Props = $props();

	const active = $derived((search.trim() ? 1 : 0) + (level ? 1 : 0) + (highlight ? 1 : 0));

	function pick(id: string) {
		switcherOpen = false;
		onproject(id);
	}

	function focusCurrent(el: HTMLElement) {
		(el.querySelector<HTMLElement>('[aria-current="true"]') ?? el.querySelector('button'))?.focus({ preventScroll: true });
	}
</script>

{#snippet levelSeg()}
	<div class="seg levels" role="group" aria-label={t('common.level')}>
		<button type="button" class:on={level === ''} aria-pressed={level === ''} onclick={() => (level = '')}>{t('common.all')}</button>
		{#each levelStore.list as l (l.id)}
			<button type="button" class:on={level === l.id} aria-pressed={level === l.id} onclick={() => (level = level === l.id ? '' : l.id)}>
				{l.name}
			</button>
		{/each}
	</div>
{/snippet}

{#snippet searchField(id: string)}
	<label class="search" for={id}>
		<Icon name="search" size={15} />
		<input {id} type="search" placeholder={t('header.search')} autocomplete="off" bind:value={search} aria-label={t('header.search')} />
	</label>
{/snippet}

<header class="bar">
	<nav class="crumb" aria-label={t('common.breadcrumb')}>
		<a class="home" href="/">Moodboard</a>
		<span class="sep" aria-hidden="true"><Icon name="chevronRight" size={14} /></span>
		<div class="switch">
			<button
				type="button"
				class="current"
				aria-haspopup="true"
				aria-expanded={switcherOpen}
				onclick={() => (switcherOpen = !switcherOpen)}
			>
				<span class="pname">{currentName}</span>
				<Icon name="chevronDown" size={14} />
			</button>
			{#if switcherOpen}
				<div class="scrim" role="presentation" onpointerdown={() => (switcherOpen = false)}></div>
				<div class="pop" role="menu" aria-label="Projects" {@attach focusCurrent}>
					{#each options as o, i (o.id)}
						{#if i === 1 || o.id === 'none'}<hr />{/if}
						<button
							type="button"
							role="menuitem"
							class="opt"
							class:serifopt={o.id !== 'all' && o.id !== 'none'}
							aria-current={o.id === current}
							onclick={() => pick(o.id)}
						>
							<span class="oname">{o.name}</span>
							<span class="ocount">{o.count}</span>
							{#if o.id === current}<span class="tick"><Icon name="check" size={14} /></span>{/if}
						</button>
					{/each}
				</div>
			{/if}
		</div>
	</nav>

	{@render actions?.()}
	<div class="right">
		{@render searchField('board-search')}
		<div class="wide">{@render levelSeg()}</div>
		<select class="narrow" bind:value={level} aria-label={t('common.level')}>
			<option value="">{t('home.allLevels')}</option>
			{#each levelStore.list as l (l.id)}<option value={l.id}>{l.name}</option>{/each}
		</select>
	</div>

	<button
		type="button"
		class="btn filters"
		aria-expanded={filtersOpen}
		onclick={() => (filtersOpen = true)}
	>
		<Icon name="filter" size={15} />
		{t('header.filters')}
		{#if active}<span class="badge">{active}</span>{/if}
	</button>
</header>

{#if filtersOpen}
	<div class="sheetscrim" role="presentation" onpointerdown={() => (filtersOpen = false)}></div>
	<div class="sheet" role="dialog" aria-label={t('header.filters')}>
		<div class="grab" aria-hidden="true"></div>
		{@render searchField('sheet-search')}
		<p class="slabel">{t('common.level')}</p>
		<div class="levelchips">
			<button type="button" class="chip" class:on={level === ''} onclick={() => (level = '')}>{t('common.all')}</button>
			{#each levelStore.list as l (l.id)}
				<button type="button" class="chip" class:on={level === l.id} onclick={() => (level = level === l.id ? '' : l.id)}>
					{l.name}
				</button>
			{/each}
		</div>
		{#if tags.length}
			<p class="slabel">Tags</p>
			<TagChips {tags} {colors} {highlight} ontoggle={ontoggletag} wrap />
		{/if}
		<button type="button" class="btn primary done" onclick={() => (filtersOpen = false)}>{t('header.done')}</button>
	</div>
{/if}

<style>
	.bar {
		position: relative;
		z-index: 40;
		height: 56px;
		flex: none;
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 0 16px 0 20px;
		background: var(--surface);
		border-bottom: 1px solid var(--line);
	}
	.crumb {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		flex: 1 1 auto;
	}
	.home {
		font-size: 13px;
		color: var(--muted);
		text-decoration: none;
		padding: 6px 4px;
		border-radius: 6px;
		white-space: nowrap;
	}
	.home:hover {
		color: var(--text);
	}
	.sep {
		color: var(--faint);
	}
	.switch {
		position: relative;
		min-width: 0;
	}
	.current {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		max-width: 100%;
		min-height: 36px;
		padding: 4px 8px;
		border: 0;
		background: none;
		border-radius: var(--r-ctl);
		color: var(--text);
	}
	.current:hover,
	.current[aria-expanded='true'] {
		background: var(--sunk);
	}
	.current :global(.icon) {
		color: var(--muted);
	}
	.pname {
		font-family: var(--font-serif);
		font-size: 18px;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}
	.scrim,
	.sheetscrim {
		position: fixed;
		inset: 0;
		z-index: 50;
	}
	.pop {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		z-index: 51;
		min-width: 260px;
		max-width: min(360px, calc(100vw - 24px));
		max-height: min(480px, calc(100vh - 80px));
		overflow-y: auto;
		padding: 5px;
		background: var(--raised);
		border-radius: 10px;
		box-shadow:
			0 12px 32px -12px rgb(0 0 0 / 0.3),
			0 0 0 1px var(--line);
		animation: pop 0.15s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	@keyframes pop {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
	}
	.pop hr {
		border: 0;
		border-top: 1px solid var(--line);
		margin: 4px 6px;
	}
	.opt {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 36px;
		padding: 6px 10px;
		border: 0;
		border-radius: 6px;
		background: none;
		text-align: left;
		font-size: 13.5px;
		color: var(--text);
	}
	.opt:hover,
	.opt:focus-visible {
		background: var(--sunk);
		outline: none;
	}
	.serifopt .oname {
		font-family: var(--font-serif);
		font-size: 15px;
	}
	.oname {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ocount {
		color: var(--faint);
		font-size: 12px;
		font-variant-numeric: tabular-nums;
	}
	.tick {
		color: var(--accent);
		margin-right: -2px;
	}
	.opt:not([aria-current='true']) .ocount {
		margin-right: 16px;
	}

	.right {
		display: flex;
		align-items: center;
		gap: 12px;
		flex: none;
	}
	.search {
		display: flex;
		align-items: center;
		gap: 7px;
		height: 34px;
		padding: 0 10px;
		border: 1px solid var(--line);
		border-radius: var(--r-ctl);
		background: var(--raised);
		color: var(--faint);
		width: 240px;
		transition: border-color 0.15s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.search:focus-within {
		border-color: var(--line-strong);
		outline: 2px solid color-mix(in srgb, var(--accent) 35%, transparent);
		outline-offset: 0;
	}
	.search input {
		flex: 1;
		min-width: 0;
		border: 0;
		padding: 0;
		background: none;
		font-size: 13.5px;
		color: var(--text);
		outline: none;
	}
	.search input::placeholder {
		color: var(--faint);
	}
	.levels button {
		min-height: 32px;
	}
	.levels button:hover:not(.on) {
		color: var(--text);
		background: var(--sunk);
	}
	.narrow {
		display: none;
		height: 34px;
		font-size: 13px;
	}
	.filters {
		display: none;
		flex: none;
		min-height: 40px;
	}
	.badge {
		display: grid;
		place-items: center;
		min-width: 18px;
		height: 18px;
		padding: 0 5px;
		border-radius: 999px;
		background: var(--accent);
		color: var(--on-accent);
		font-size: 11px;
		font-weight: 700;
	}

	.sheet {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 51;
		max-height: 80vh;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 8px 16px calc(16px + env(safe-area-inset-bottom));
		background: var(--surface);
		border-radius: var(--r-panel) var(--r-panel) 0 0;
		box-shadow: 0 -12px 32px -12px rgb(0 0 0 / 0.3);
		animation: up 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.sheetscrim {
		background: var(--scrim);
	}
	@keyframes up {
		from {
			transform: translateY(24px);
			opacity: 0;
		}
	}
	.grab {
		align-self: center;
		width: 36px;
		height: 4px;
		border-radius: 999px;
		background: var(--line-strong);
		margin-bottom: 4px;
	}
	.sheet .search {
		width: 100%;
		height: 40px;
	}
	.slabel {
		margin: 6px 0 0;
		font-size: 12.5px;
		color: var(--muted);
	}
	.levelchips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.levelchips .chip {
		padding: 7px 12px;
	}
	.done {
		justify-content: center;
		margin-top: 8px;
		min-height: 42px;
	}

	@media (max-width: 1080px) {
		.search {
			width: 180px;
		}
	}
	@media (max-width: 900px) {
		.wide {
			display: none;
		}
		.narrow {
			display: block;
		}
	}
	@media (max-width: 640px) {
		.bar {
			padding: 0 10px 0 12px;
			gap: 8px;
		}
		.right {
			display: none;
		}
		.filters {
			display: inline-flex;
		}
		.pname {
			font-size: 16px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.pop,
		.sheet {
			animation: none;
		}
	}
</style>
