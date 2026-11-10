<script lang="ts" module>
	import type { IconName } from './Icon.svelte';

	export interface MenuItem {
		label: string;
		icon?: IconName;
		/** Shortcut shown on the right. */
		kbd?: string;
		/** Small text on the right (e.g. a count). */
		meta?: string;
		danger?: boolean;
		/** Opens a sub-list; shows a chevron. */
		more?: boolean;
		onselect: () => void;
	}
</script>

<script lang="ts">
	import Icon from './Icon.svelte';

	interface Props {
		x: number;
		y: number;
		items: MenuItem[];
		/** A heading line; with onback it gets a back arrow. */
		title?: string;
		onback?: () => void;
		onclose: () => void;
	}
	let { x, y, items, title, onback, onclose }: Props = $props();

	/** Keep the menu inside the viewport and focus its first item. */
	function place(el: HTMLElement) {
		const r = el.getBoundingClientRect();
		const left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
		const top = y + r.height > window.innerHeight - 8 ? Math.max(8, y - r.height) : y;
		el.style.left = `${left}px`;
		el.style.top = `${top}px`;
		el.style.visibility = 'visible';
		el.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
		e.preventDefault();
		const list = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="menuitem"]')];
		const i = list.indexOf(document.activeElement as HTMLElement);
		const next = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
		list[next]?.focus();
	}
</script>

<div
	class="backdrop"
	role="presentation"
	onpointerdown={onclose}
	oncontextmenu={(e) => {
		e.preventDefault();
		onclose();
	}}
></div>
{#key items}
	<div class="menu" role="menu" tabindex="-1" {onkeydown} {@attach place}>
		{#if title}
			<div class="head">
				{#if onback}
					<button type="button" class="back" role="menuitem" aria-label="Πίσω" onclick={onback}>
						<Icon name="chevronLeft" size={14} />
					</button>
				{/if}
				<span>{title}</span>
			</div>
		{/if}
		{#each items as it, i (i)}
			<button type="button" class="item" class:danger={it.danger} role="menuitem" onclick={it.onselect}>
				{#if it.icon}<Icon name={it.icon} />{:else}<span class="noicon"></span>{/if}
				<span class="label">{it.label}</span>
				{#if it.meta}<span class="meta">{it.meta}</span>{/if}
				{#if it.kbd}<kbd class="kbd">{it.kbd}</kbd>{/if}
				{#if it.more}<Icon name="chevronRight" size={14} />{/if}
			</button>
		{/each}
	</div>
{/key}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 60;
	}
	.menu {
		position: fixed;
		left: 0;
		top: 0;
		visibility: hidden;
		z-index: 61;
		min-width: 220px;
		max-width: min(320px, calc(100vw - 16px));
		max-height: min(420px, calc(100vh - 16px));
		overflow-y: auto;
		padding: 5px;
		background: var(--raised);
		border-radius: 10px;
		box-shadow:
			0 12px 32px -12px rgb(0 0 0 / 0.3),
			0 0 0 1px var(--line);
		animation: pop 0.15s cubic-bezier(0.2, 0.8, 0.2, 1);
		outline: none;
	}
	@keyframes pop {
		from {
			opacity: 0;
			transform: scale(0.97);
		}
	}
	.head {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px 8px 6px 4px;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted);
		border-bottom: 1px solid var(--line);
		margin-bottom: 4px;
	}
	.back {
		display: grid;
		place-items: center;
		width: 26px;
		height: 26px;
		padding: 0;
		border: 0;
		background: none;
		color: var(--muted);
		border-radius: 6px;
	}
	.back:hover,
	.back:focus-visible {
		background: var(--sunk);
		color: var(--text);
	}
	.item {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 34px;
		padding: 6px 10px;
		border: 0;
		border-radius: 6px;
		background: none;
		color: var(--text);
		font-size: 13.5px;
		text-align: left;
	}
	.item :global(.icon) {
		color: var(--muted);
	}
	.item:hover,
	.item:focus-visible {
		background: var(--sunk);
		outline: none;
	}
	.item.danger,
	.item.danger :global(.icon) {
		color: var(--accent);
	}
	.noicon {
		width: 16px;
	}
	.label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.meta {
		color: var(--faint);
		font-size: 12px;
		font-variant-numeric: tabular-nums;
	}
	@media (hover: none) {
		.item {
			min-height: 42px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.menu {
			animation: none;
		}
	}
</style>
