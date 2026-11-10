<script lang="ts">
	import Icon from './Icon.svelte';

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
	<div class="dock" role="toolbar" aria-label="Εργαλεία πίνακα">
		<button type="button" class="dbtn primary" aria-label="Νέα εικόνα" aria-keyshortcuts="N" onclick={onadd}>
			<Icon name="plus" />
			<span class="lbl">Εικόνα</span>
			<span class="tip" aria-hidden="true">Νέα εικόνα <kbd class="kbd">N</kbd></span>
		</button>
		<span class="sep" aria-hidden="true"></span>
		<button
			type="button"
			class="dbtn"
			class:on={notesOn}
			aria-pressed={notesOn}
			aria-label="Σημειώσεις"
			onclick={() => (notesOn = !notesOn)}
		>
			<Icon name="notes" />
			<span class="lbl">Σημειώσεις</span>
			<span class="tip" aria-hidden="true">{notesOn ? 'Κρύψε τις σημειώσεις' : 'Δείξε τις σημειώσεις'}</span>
		</button>
		<label class="size">
			<span class="sr">Μέγεθος εικόνας</span>
			<svg class="sq s" viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="6" height="6" rx="1" /></svg>
			<input type="range" {min} {max} step="10" bind:value={size} aria-label="Μέγεθος εικόνας" />
			<svg class="sq" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /></svg>
			<span class="tip" aria-hidden="true">Μέγεθος εικόνων</span>
		</label>
		<span class="sep" aria-hidden="true"></span>
		<button type="button" class="dbtn icon" aria-label="Κεντράρισμα" aria-keyshortcuts="F" onclick={onfit}>
			<Icon name="fit" />
			<span class="tip" aria-hidden="true">Κεντράρισμα <kbd class="kbd">F</kbd></span>
		</button>
		<button type="button" class="dbtn icon" aria-label="Αυτόματη διάταξη" aria-keyshortcuts="L" onclick={onlayout}>
			<Icon name="layout" />
			<span class="tip" aria-hidden="true">Αυτόματη διάταξη <kbd class="kbd">L</kbd></span>
		</button>
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
	.dbtn {
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
	.dbtn.icon {
		padding: 0;
		width: 36px;
	}
	.dbtn:hover {
		background: var(--sunk);
		color: var(--text);
	}
	.dbtn.on {
		color: var(--text);
		background: var(--sunk);
	}
	.dbtn.primary {
		background: var(--accent);
		color: var(--on-accent);
		font-weight: 600;
		padding: 0 14px 0 11px;
	}
	.dbtn.primary:hover {
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
	.tip {
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
	.tip .kbd {
		background: transparent;
		color: inherit;
		border-color: color-mix(in srgb, var(--bg) 40%, transparent);
		padding: 2px 4px;
	}
	.dbtn:hover .tip,
	.dbtn:focus-visible .tip,
	.size:hover .tip {
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
		.lbl,
		.tip {
			display: none;
		}
		.dbtn {
			width: 40px;
			min-width: 40px;
			height: 40px;
			padding: 0;
		}
		.dbtn.primary {
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
		.dbtn,
		.tip {
			transition: none;
		}
	}
</style>
