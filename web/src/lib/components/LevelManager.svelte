<script lang="ts">
	import { t } from '#lib/i18n.js';
	// Edit the user's levels: add, rename, reorder, remove. Changes save at once.
	import { onMount } from 'svelte';
	import type PocketBase from 'pocketbase';
	import { addLevel, deleteLevel, listLevels, MAX_LEVEL_NAME, moveLevel, renameLevel } from '#lib/levels.js';
	import { levelStore, setLevels } from '#lib/levels.svelte.js';

	let { pb, userId, onclose }: { pb: PocketBase; userId: string; onclose: () => void } = $props();

	let dialog = $state<HTMLDialogElement | null>(null);
	let newName = $state('');
	let busy = $state(false);
	let error = $state('');
	/** Level being renamed, and its draft name. */
	let editing = $state<string | null>(null);
	let draft = $state('');
	let confirming = $state<string | null>(null);

	onMount(() => {
		if (dialog && !dialog.open) dialog.showModal();
	});

	async function run(task: () => Promise<void>) {
		if (busy) return;
		busy = true;
		error = '';
		try {
			await task();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			// A failed save may have changed part of the list (a reorder is several requests): show the real state.
			setLevels(await listLevels(pb).catch(() => levelStore.list));
		} finally {
			busy = false;
		}
	}

	const add = (e: SubmitEvent) => {
		e.preventDefault();
		return run(async () => {
			const row = await addLevel(pb, userId, newName);
			setLevels([...levelStore.list, row]);
			newName = '';
		});
	};

	const startRename = (id: string, name: string) => {
		editing = id;
		draft = name;
		confirming = null;
		error = '';
	};

	const saveRename = (e: SubmitEvent) => {
		e.preventDefault();
		const id = editing;
		if (!id) return;
		return run(async () => {
			const row = await renameLevel(pb, id, draft);
			setLevels(levelStore.list.map((l) => (l.id === id ? row : l)));
			editing = null;
		});
	};

	const move = (id: string, dir: -1 | 1) =>
		run(async () => {
			setLevels(await moveLevel(pb, levelStore.list, id, dir));
		});

	const remove = (id: string) =>
		run(async () => {
			await deleteLevel(pb, id);
			setLevels(levelStore.list.filter((l) => l.id !== id));
			confirming = null;
		});

	function onDialogClick(e: MouseEvent) {
		if (e.target === dialog) onclose();
	}
</script>

<dialog bind:this={dialog} oncancel={(e) => { e.preventDefault(); onclose(); }} onclick={onDialogClick}>
	<div class="box">
		<header>
			<h2>{t('common.levels')}</h2>
			<button class="x" type="button" onclick={onclose} aria-label={t('common.close')}>×</button>
		</header>
		<p class="hint">{t('levels.hint')}</p>

		<ul>
			{#each levelStore.list as l, i (l.id)}
				<li>
					{#if editing === l.id}
						<form class="edit" onsubmit={saveRename}>
							<!-- svelte-ignore a11y_autofocus -->
							<input bind:value={draft} maxlength={MAX_LEVEL_NAME} aria-label={t('levels.nameLabel')} autofocus />
							<button class="btn primary" type="submit" disabled={busy}>{t('common.save')}</button>
							<button class="btn" type="button" onclick={() => (editing = null)}>{t('common.cancel')}</button>
						</form>
					{:else if confirming === l.id}
						<span class="name">{t('levels.confirmDelete', { name: l.name })}</span>
						<button class="btn danger" type="button" disabled={busy} onclick={() => remove(l.id)}>{t('levels.yes')}</button>
						<button class="btn" type="button" onclick={() => (confirming = null)}>{t('common.cancel')}</button>
					{:else}
						<span class="name">{l.name}</span>
						<button class="ib" type="button" disabled={busy || i === 0} onclick={() => move(l.id, -1)} aria-label={t('levels.up', { name: l.name })}>↑</button>
						<button class="ib" type="button" disabled={busy || i === levelStore.list.length - 1} onclick={() => move(l.id, 1)} aria-label={t('levels.down', { name: l.name })}>↓</button>
						<button class="btn" type="button" onclick={() => startRename(l.id, l.name)}>{t('common.rename')}</button>
						<button class="btn danger" type="button" onclick={() => { confirming = l.id; editing = null; error = ''; }}>{t('common.delete')}</button>
					{/if}
				</li>
			{/each}
			{#if levelStore.list.length === 0}<li class="none">{t('levels.none')}</li>{/if}
		</ul>

		<form class="add" onsubmit={add}>
			<input bind:value={newName} maxlength={MAX_LEVEL_NAME} placeholder={t('levels.new')} aria-label={t('levels.new')} />
			<button class="btn primary" type="submit" disabled={busy || !newName.trim()}>{t('levels.add')}</button>
		</form>
		{#if error}<p class="err" role="alert">{error}</p>{/if}
	</div>
</dialog>

<style>
	dialog {
		width: min(520px, 100vw - 32px);
		max-height: calc(100vh - 32px);
		padding: 0;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		overflow: auto;
	}
	dialog::backdrop { background: var(--scrim); }
	.box { display: grid; gap: 12px; padding: 16px; }
	header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
	h2 { font-size: 1rem; margin: 0; }
	.x { border: none; background: none; font-size: 1.2rem; line-height: 1; padding: 0.2rem 0.5rem; color: var(--muted); }
	.x:hover { color: var(--accent); }
	.hint { margin: 0; color: var(--muted); font-size: 0.8rem; }
	ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
	li {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
		padding: 6px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--raised);
	}
	li.none { color: var(--muted); justify-content: center; }
	.name { flex: 1 1 140px; min-width: 0; overflow-wrap: anywhere; }
	.ib {
		width: 32px;
		height: 32px;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
	}
	.ib:disabled { opacity: 0.35; }
	.btn { font-size: 0.8rem; }
	form.edit, form.add { display: flex; gap: 6px; flex: 1 1 100%; flex-wrap: wrap; }
	form input { flex: 1 1 160px; min-width: 0; }
	.err { color: var(--accent); margin: 0; font-size: 0.85rem; }
</style>
