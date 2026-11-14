<script lang="ts">
	import { t } from '#lib/i18n.js';
	import { cleanSourceProject, SOURCE_PROJECT_MAX } from '#lib/sourceProjects.js';

	// Floating bar of the select mode: set or clear the source project of the selected images.
	interface Props {
		count: number;
		names: string[];
		busy: boolean;
		/** Result of the last action (shown for screen readers too). */
		message: string;
		/** Undo the last action; absent when there is nothing to undo. */
		onundo?: () => void;
		onset: (name: string) => void;
		onclear: () => void;
		onall: () => void;
		onnone: () => void;
		ondone: () => void;
	}
	let { count, names, busy, message, onundo, onset, onclear, onall, onnone, ondone }: Props = $props();

	const uid = $props.id();
	const listId = `spb-${uid}`;
	let draft = $state('');
	let input: HTMLInputElement | undefined = $state();
	const name = $derived(cleanSourceProject(draft));

	/** Put the cursor in the name field (after the caller ticked a whole section). */
	export function focus() {
		input?.focus();
	}

	function submit(e: SubmitEvent) {
		e.preventDefault();
		if (name && count && !busy) onset(name);
	}
</script>

<form class="bar" onsubmit={submit} aria-label={t('sp.label')}>
	<span class="count" aria-live="polite">{count ? t('sp.bar.count', { n: count }) : t('sp.bar.hint')}</span>
	<button type="button" class="btn ghost" onclick={onall}>{t('sp.bar.all')}</button>
	{#if count}<button type="button" class="btn ghost" onclick={onnone}>{t('sp.bar.none')}</button>{/if}
	<span class="break" aria-hidden="true"></span>
	<input
		bind:this={input}
		type="text"
		list={listId}
		bind:value={draft}
		placeholder={t('sp.bar.placeholder')}
		aria-label={t('sp.bar.label')}
		maxlength={SOURCE_PROJECT_MAX}
		autocomplete="off"
	/>
	<datalist id={listId}>
		{#each names as n (n)}<option value={n}></option>{/each}
	</datalist>
	<button type="submit" class="btn primary" disabled={busy || !count || !name}>{busy ? '…' : t('sp.bar.set')}</button>
	<button type="button" class="btn" title={t('sp.bar.clearTitle')} disabled={busy || !count} onclick={onclear}>
		{t('sp.bar.clear')}
	</button>
	<button type="button" class="btn ghost done" title={t('sp.bar.doneTitle')} onclick={ondone}>{t('bulk.done')}</button>
	{#if message}
		<p class="msg" role="status">
			{message}
			{#if onundo}<button type="button" class="undo" disabled={busy} onclick={onundo}>{t('sp.undo')}</button>{/if}
		</p>
	{/if}
</form>

<style>
	.bar {
		position: fixed;
		left: 50%;
		bottom: 16px;
		transform: translateX(-50%);
		z-index: 20;
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		/* A fixed width: the bar does not jump when the count or the message changes. */
		width: min(820px, calc(100vw - 32px));
		padding: 8px 12px;
		background: var(--raised);
		border-radius: var(--r-panel);
		box-shadow: 0 12px 32px -12px rgb(0 0 0 / 0.3), 0 0 0 1px var(--line);
	}
	.count { font-size: 14px; font-weight: 600; margin-right: 4px; white-space: nowrap; }
	input { flex: 1 1 160px; min-width: 0; }
	.break { display: none; }
	.msg { flex-basis: 100%; margin: 0; font-size: 12.5px; color: var(--muted); }
	.undo {
		border: 0;
		background: none;
		padding: 0 4px;
		min-height: 32px;
		font: inherit;
		font-weight: 600;
		color: var(--text);
		text-decoration: underline;
		text-underline-offset: 3px;
		cursor: pointer;
	}
	@media (max-width: 600px) {
		/* Two rows: what is selected (and Done) on top, the action below. The + button is hidden in select mode. */
		.bar { bottom: 12px; gap: 6px; padding: 8px 10px; }
		.count { flex: 1 1 0; min-width: 0; white-space: normal; }
		.done { order: 1; }
		.break { display: block; order: 2; flex-basis: 100%; height: 0; }
		input, .bar > .btn:not(.ghost) { order: 3; }
		input { flex-basis: 96px; }
		.msg { order: 4; }
	}
</style>
