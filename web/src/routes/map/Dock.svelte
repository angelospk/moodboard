<script lang="ts">
	import { t } from '#lib/i18n.js';
	import Icon from './Icon.svelte';
	import Appearance from './Appearance.svelte';

	interface Props {
		notesOn: boolean;
		size: number;
		min: number;
		max: number;
		/** Shown beside the dock (few images yet). */
		hint: string | null;
		/** Screen px covered on the right (panel); the dock centres in what is left. */
		inset: number;
		onadd: () => void;
		onfit: () => void;
		onlayout: () => void;
	}
	let { notesOn = $bindable(), size = $bindable(), min, max, hint, inset, onadd, onfit, onlayout }: Props = $props();
</script>

<div class="dockwrap" style:--inset="{inset}px">
	<div class="dock" role="toolbar" aria-label={t('dock.tools')}>
		<button type="button" class="dbtn primary" aria-label={t('common.newImage')} aria-keyshortcuts="N" onclick={onadd}>
			<Icon name="plus" />
			<span class="lbl">{t('dock.image')}</span>
			<span class="tip" aria-hidden="true">{t('common.newImage')} <kbd class="kbd">N</kbd></span>
		</button>
		<span class="sep" aria-hidden="true"></span>
		<button
			type="button"
			class="dbtn"
			class:on={notesOn}
			aria-pressed={notesOn}
			aria-label={t('common.notes')}
			onclick={() => (notesOn = !notesOn)}
		>
			<Icon name="notes" />
			<span class="lbl">{t('common.notes')}</span>
			<span class="tip" aria-hidden="true">{notesOn ? t('dock.hideNotes') : t('dock.showNotes')}</span>
		</button>
		<label class="size">
			<span class="sr">{t('dock.imageSize')}</span>
			<svg class="sq s" viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="6" height="6" rx="1" /></svg>
			<input type="range" {min} {max} step="10" bind:value={size} aria-label={t('dock.imageSize')} />
			<svg class="sq" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /></svg>
			<span class="tip" aria-hidden="true">{t('dock.imagesSize')}</span>
		</label>
		<span class="sep" aria-hidden="true"></span>
		<button type="button" class="dbtn icon" aria-label={t('common.fit')} aria-keyshortcuts="F" onclick={onfit}>
			<Icon name="fit" />
			<span class="tip" aria-hidden="true">{t('common.fit')} <kbd class="kbd">F</kbd></span>
		</button>
		<button type="button" class="dbtn icon" aria-label={t('dock.autoLayout')} aria-keyshortcuts="L" onclick={onlayout}>
			<Icon name="layout" />
			<span class="tip" aria-hidden="true">{t('dock.autoLayout')} <kbd class="kbd">L</kbd></span>
		</button>
		<Appearance />
	</div>
	{#if hint}<p class="hint">{hint}</p>{/if}
</div>

<style>
	.dockwrap {
		position: absolute;
		left: calc((100% - var(--inset, 0px)) / 2);
		bottom: calc(16px + env(safe-area-inset-bottom));
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: 12px;
		z-index: 10;
		transition: left 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
		max-width: calc(100% - 32px);
		pointer-events: none;
	}
	.dock {
		pointer-events: auto;
		height: 48px;
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 0 6px;
		background: var(--raised);
		border-radius: var(--r-pill);
		box-shadow:
			0 12px 32px -12px rgb(0 0 0 / 0.3),
			0 0 0 1px var(--line);
	}
	.dock :global(.dbtn) {
		position: relative;
		height: 36px;
		min-width: 36px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 0 12px;
		border: 0;
		border-radius: var(--r-pill);
		background: none;
		color: var(--muted);
		font-size: 13px;
		white-space: nowrap;
		transition:
			background-color 0.15s cubic-bezier(0.2, 0.8, 0.2, 1),
			color 0.15s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.dock :global(.dbtn.icon) {
		padding: 0;
		width: 36px;
	}
	.dock :global(.dbtn:hover) {
		background: var(--sunk);
		color: var(--text);
	}
	.dock :global(.dbtn.on) {
		color: var(--text);
		background: var(--sunk);
	}
	.dock :global(.dbtn.primary) {
		background: var(--accent);
		color: var(--on-accent);
		font-weight: 600;
		padding: 0 14px 0 11px;
	}
	.dock :global(.dbtn.primary:hover) {
		background: color-mix(in srgb, var(--accent) 88%, var(--text));
	}
	.sep {
		width: 1px;
		height: 20px;
		background: var(--line);
		margin: 0 4px;
	}
	.size {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 0 8px;
		height: 36px;
		color: var(--faint);
	}
	.sq {
		width: 14px;
		height: 14px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.4;
	}
	.size input {
		width: 104px;
		padding: 0;
		border: 0;
		background: none;
		accent-color: var(--accent);
	}
	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	/* Tooltips: label plus shortcut, above the control. */
	.dock :global(.tip) {
		position: absolute;
		bottom: calc(100% + 10px);
		left: 50%;
		transform: translate(-50%, 4px);
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 8px;
		border-radius: 6px;
		background: var(--text);
		color: var(--bg);
		font-size: 12px;
		font-weight: 500;
		white-space: nowrap;
		opacity: 0;
		pointer-events: none;
		transition:
			opacity 0.15s cubic-bezier(0.2, 0.8, 0.2, 1),
			transform 0.15s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.dock :global(.tip .kbd) {
		background: transparent;
		color: inherit;
		border-color: color-mix(in srgb, var(--bg) 40%, transparent);
		padding: 2px 4px;
	}
	.dock :global(.dbtn:hover .tip),
	.dock :global(.dbtn:focus-visible .tip),
	.size:hover :global(.tip) {
		opacity: 1;
		transform: translate(-50%, 0);
		transition-delay: 0.35s;
	}

	.hint {
		pointer-events: auto;
		margin: 0;
		font-size: 12.5px;
		color: var(--muted);
		white-space: nowrap;
		padding: 6px 12px;
		border-radius: var(--r-pill);
		background: color-mix(in srgb, var(--bg) 85%, transparent);
	}

	@media (max-width: 1100px) {
		.hint {
			display: none;
		}
	}
	@media (max-width: 640px) {
		.dockwrap {
			left: 50%;
		}
		.dock :global(.lbl),
		.dock :global(.tip) {
			display: none;
		}
		.dock :global(.dbtn) {
			width: 40px;
			min-width: 40px;
			height: 40px;
			padding: 0;
		}
		.dock :global(.dbtn.primary) {
			padding: 0;
		}
		.size input {
			width: 84px;
		}
		.size .s {
			display: none;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.dockwrap,
		.dock :global(.dbtn),
		.dock :global(.tip) {
			transition: none;
		}
	}
</style>
