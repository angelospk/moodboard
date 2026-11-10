<script lang="ts">
	import type { ZoneColor } from './board.js';

	interface Props {
		tags: { tag: string; count: number }[];
		colors: Map<string, ZoneColor>;
		highlight: string | null;
		ontoggle: (tag: string) => void;
		/** Wrap onto several lines (filter sheet) instead of one scrolling row. */
		wrap?: boolean;
	}
	let { tags, colors, highlight, ontoggle, wrap = false }: Props = $props();
</script>

<div class="tags" class:wrap role="group" aria-label="Tags">
	{#each tags as t (t.tag)}
		{@const c = colors.get(t.tag)}
		<button
			type="button"
			class="chip tagchip"
			class:on={highlight === t.tag}
			aria-pressed={highlight === t.tag}
			style:--zl={c?.light}
			style:--zd={c?.dark}
			onclick={() => ontoggle(t.tag)}
		>
			<i class="dot" aria-hidden="true"></i>
			<span class="name">{t.tag}</span>
			<span class="n">{t.count}</span>
		</button>
	{/each}
</div>

<style>
	.tags {
		display: flex;
		gap: 6px;
		align-items: center;
		overflow-x: auto;
		scrollbar-width: none;
		min-width: 0;
	}
	.tags::-webkit-scrollbar {
		display: none;
	}
	.tags.wrap {
		flex-wrap: wrap;
		overflow: visible;
	}
	.tagchip {
		--z: var(--zl, #7d7a72);
		flex: none;
		position: relative;
		padding: 3px 10px 3px 8px;
		background: var(--raised);
		border-color: var(--line);
		transition:
			background-color 0.15s cubic-bezier(0.2, 0.8, 0.2, 1),
			border-color 0.15s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	/* Bigger hit area than the visible chip. */
	.tagchip::after {
		content: '';
		position: absolute;
		inset: -5px -2px;
	}
	@media (prefers-color-scheme: dark) {
		.tagchip {
			--z: var(--zd, #9a978f);
		}
	}
	.tagchip:hover {
		border-color: color-mix(in srgb, var(--z) 55%, var(--line));
	}
	.tagchip.on {
		background: color-mix(in srgb, var(--z) 14%, var(--raised));
		border-color: color-mix(in srgb, var(--z) 70%, transparent);
		color: var(--text);
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 999px;
		background: var(--z);
	}
	.n {
		color: var(--faint);
		font-variant-numeric: tabular-nums;
		font-size: 11.5px;
	}
	.tagchip.on .n {
		color: var(--muted);
	}
	@media (hover: none) {
		.tagchip {
			padding: 6px 12px 6px 10px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.tagchip {
			transition: none;
		}
	}
</style>
