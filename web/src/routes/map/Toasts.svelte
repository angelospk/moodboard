<script lang="ts" module>
	export interface Toast {
		id: number;
		text: string;
		tone?: 'info' | 'busy' | 'error';
		action?: { label: string; run: () => void };
	}
</script>

<script lang="ts">
	import { t as tl } from '#lib/i18n.js';
	interface Props {
		toasts: Toast[];
		/** Screen px covered on the right (panel). */
		inset: number;
		ondismiss: (id: number) => void;
	}
	let { toasts, inset, ondismiss }: Props = $props();
</script>

<div class="toasts" style:--inset="{inset}px" aria-live="polite" role="status">
	{#each toasts as t (t.id)}
		<div class="toast" class:error={t.tone === 'error'}>
			{#if t.tone === 'busy'}<span class="spin" aria-hidden="true"></span>{/if}
			<span class="text">{t.text}</span>
			{#if t.action}
				<button
					type="button"
					class="act"
					onclick={() => {
						t.action?.run();
						ondismiss(t.id);
					}}>{t.action.label}</button
				>
			{/if}
			{#if t.tone === 'error'}
				<button type="button" class="x" aria-label={tl('common.close')} onclick={() => ondismiss(t.id)}>
					<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
				</button>
			{/if}
		</div>
	{/each}
</div>

<style>
	.toasts {
		position: absolute;
		left: calc((100% - var(--inset, 0px)) / 2);
		bottom: calc(80px + env(safe-area-inset-bottom));
		transform: translateX(-50%);
		display: flex;
		flex-direction: column-reverse;
		align-items: center;
		gap: 8px;
		/* Above the mobile bottom sheet too. */
		z-index: 46;
		pointer-events: none;
		width: max-content;
		max-width: calc(100% - 32px);
		transition: left 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.toast {
		pointer-events: auto;
		display: flex;
		align-items: center;
		gap: 10px;
		max-width: 100%;
		min-height: 38px;
		padding: 6px 8px 6px 14px;
		border-radius: var(--r-pill);
		background: var(--text);
		color: var(--bg);
		font-size: 13px;
		box-shadow: 0 12px 32px -12px rgb(0 0 0 / 0.4);
		animation: rise 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.toast:not(:has(.act, .x)) {
		padding-right: 14px;
	}
	.toast.error {
		background: color-mix(in srgb, var(--accent) 22%, var(--text));
		max-width: min(520px, 100%);
		border-radius: 18px;
	}
	.toast.error .text {
		white-space: normal;
		line-height: 1.35;
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
	}
	.text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.act {
		flex: none;
		border: 0;
		border-radius: var(--r-pill);
		padding: 5px 12px;
		background: color-mix(in srgb, var(--bg) 16%, transparent);
		color: inherit;
		font-weight: 600;
		font-size: 12.5px;
	}
	.act:hover {
		background: color-mix(in srgb, var(--bg) 26%, transparent);
	}
	.x {
		flex: none;
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		padding: 0;
		border: 0;
		border-radius: 999px;
		background: none;
		color: inherit;
	}
	.x svg {
		width: 14px;
		height: 14px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
	}
	.spin {
		width: 12px;
		height: 12px;
		border-radius: 999px;
		border: 1.5px solid color-mix(in srgb, var(--bg) 35%, transparent);
		border-top-color: var(--bg);
		animation: turn 0.8s linear infinite;
	}
	@keyframes turn {
		to {
			transform: rotate(360deg);
		}
	}
	@media (max-width: 640px) {
		.toasts {
			left: 50%;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.toast {
			animation: none;
		}
		.spin {
			animation-duration: 2.4s;
		}
	}
</style>
