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
		onset: (name: string) => void;
		onclear: () => void;
		onall: () => void;
		onnone: () => void;
		ondone: () => void;
	}
	let { count, names, busy, message, onset, onclear, onall, onnone, ondone }: Props = $props();

	const uid = $props.id();
	const listId = `spb-${uid}`;
	let draft = $state('');
	const name = $derived(cleanSourceProject(draft));

	function submit(e: SubmitEvent) {
		e.preventDefault();
		if (name && count && !busy) onset(name);
	}
</script>

<form class="bar" onsubmit={submit} aria-label={t('sp.label')}>
	<span class="count" aria-live="polite">{count ? t('sp.bar.count', { n: count }) : t('sp.bar.hint')}</span>
	<button type="button" class="btn ghost" onclick={onall}>{t('sp.bar.all')}</button>
	{#if count}<button type="button" class="btn ghost" onclick={onnone}>{t('sp.bar.none')}</button>{/if}
	<input
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
	<button type="button" class="btn" disabled={busy || !count} onclick={onclear}>{t('sp.bar.clear')}</button>
	<button type="button" class="btn ghost" onclick={ondone}>{t('bulk.done')}</button>
	{#if message}<span class="msg" role="status">{message}</span>{/if}
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
		width: max-content;
		max-width: calc(100vw - 32px);
		padding: 8px 12px;
		background: var(--raised);
		border-radius: var(--r-panel);
		box-shadow: 0 12px 32px -12px rgb(0 0 0 / 0.3), 0 0 0 1px var(--line);
	}
	.count { font-size: 14px; font-weight: 600; margin-right: 4px; }
	input { width: 220px; max-width: 100%; min-width: 0; }
	.msg { flex-basis: 100%; font-size: 12.5px; color: var(--muted); }
	@media (max-width: 600px) {
		.bar { bottom: 76px; }
		input { flex: 1 1 160px; }
	}
</style>
