<script lang="ts">
	import { t } from '#lib/i18n.js';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import type { Level } from '#lib/types.js';
	import { levelStore } from '#lib/levels.svelte.js';
	import { checkImage, createInspiration } from '#lib/inspirations.js';
	import TagInput from '#lib/components/TagInput.svelte';
	import { suggestLabels } from '#lib/suggest.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let file = $state<File | null>(null);
	let preview = $state('');
	let projectId = $state('');
	let note = $state('');
	let tags = $state<string[]>([]);
	let level = $state<Level | ''>('');
	let busy = $state(false);
	let error = $state('');

	let aiBusy = $state(false);
	let aiRun = 0;

	/** AI prefill (when the user switched it on): never overwrites what the user already set. */
	async function prefill(f: File) {
		const run = ++aiRun;
		aiBusy = true;
		try {
			const s = await suggestLabels(data.pb, f);
			if (!s || file !== f) return;
			if (!level && levelStore.list.some((l) => l.id === s.level)) level = s.level as Level;
			if (!tags.length) tags = s.tags;
		} finally {
			if (run === aiRun) aiBusy = false;
		}
	}

	function accept(f: File | null) {
		error = '';
		if (!f) return;
		try {
			checkImage(f);
		} catch (e) {
			error = e instanceof Error ? e.message : t('new.unsupported');
			return;
		}
		file = f;
		if (preview) URL.revokeObjectURL(preview);
		preview = URL.createObjectURL(f);
		void prefill(f);
	}

	function onPick(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		accept(input.files?.[0] ?? null);
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		const dt = e.dataTransfer;
		if (!dt) return;
		const f = dt.files?.[0] ?? Array.from(dt.items).find((i) => i.kind === 'file')?.getAsFile() ?? null;
		accept(f);
	}

	onMount(() => {
		function onPaste(e: ClipboardEvent) {
			const items = e.clipboardData?.items;
			if (!items) return;
			for (const item of items) {
				if (item.kind === 'file' && item.type.startsWith('image/')) {
					const f = item.getAsFile();
					if (f) {
						accept(f);
						e.preventDefault();
					}
					return;
				}
			}
		}
		window.addEventListener('paste', onPaste);
		return () => {
			window.removeEventListener('paste', onPaste);
			if (preview) URL.revokeObjectURL(preview);
		};
	});

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (!file || busy) return;
		if (!data.user) { error = t('new.noUser'); return; }

		busy = true;
		error = '';
		try {
			const { id } = await createInspiration(data.pb, data.user.id, file, {
				project_id: projectId || null,
				note,
				tags,
				level: level || null
			});
			await goto(`/i/${id}`);
		} catch (e) {
			error = e instanceof Error ? e.message : t('new.saveFailed');
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>{t('new.title')}</title>
</svelte:head>

<header>
	<a class="back" href="/">{t('common.back')}</a>
	<h1>{t('common.newImage')}</h1>
</header>

<main>
	<form onsubmit={save}>
		<div
			class="drop"
			class:filled={!!preview}
			role="button"
			tabindex="0"
			ondragover={(e) => e.preventDefault()}
			ondrop={onDrop}
			onkeydown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') (e.currentTarget as HTMLElement).querySelector('input')?.click();
			}}
		>
			{#if preview}
				<img src={preview} alt={t('new.preview')} />
				<label class="replace">
					<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" onchange={onPick} />
					{t('new.change')}
				</label>
			{:else}
				<label class="pick">
					<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" onchange={onPick} />
					<span class="cta">{t('new.pick')}</span>
					<span class="hint">{t('new.dropHint')}</span>
					<span class="hint">{t('new.formats')}</span>
				</label>
			{/if}
		</div>

		<div class="fields">
			<label>
				<span>Project</span>
				<select bind:value={projectId}>
					<option value="">{t('common.noProjectOption')}</option>
					{#each data.projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
				</select>
			</label>

			<label>
				<span>{t('common.level')}</span>
				<select bind:value={level}>
					<option value="">{t('common.noneOption')}</option>
					{#each levelStore.list as l (l.id)}<option value={l.id}>{l.name}</option>{/each}
				</select>
			</label>

			<label class="wide">
				<span>{t('new.note')}</span>
				<textarea bind:value={note} rows="4" placeholder={t('new.notePlaceholder')}></textarea>
			</label>

			<div class="wide field">
				<label for="tags">Tags <em>{t('new.tagsLimit')}</em>{#if aiBusy} <em>✦ {t('ai.filling')}</em>{/if}</label>
				<TagInput id="tags" bind:tags suggestions={data.tags} placeholder={t('new.tagsPlaceholder')} />
			</div>
		</div>

		{#if error}<p class="err">{error}</p>{/if}

		<div class="submit">
			<button class="primary" type="submit" disabled={busy || !file}>
				{busy ? t('common.saving') : t('common.save')}
			</button>
			<a href="/">{t('common.cancel')}</a>
		</div>
	</form>
</main>

<style>
	header { display: flex; align-items: center; gap: 12px; padding: 16px; border-bottom: 1px solid var(--line); background: var(--surface); }
	h1 { font-size: 1.1rem; margin: 0; }
	.back { text-decoration: none; color: var(--muted); font-size: 0.85rem; }

	main { padding: 16px; max-width: 720px; margin: 0 auto; }
	form { display: grid; gap: 16px; }

	.drop {
		border: 1.5px dashed var(--line);
		border-radius: var(--radius);
		background: var(--surface);
		display: grid;
		place-items: center;
		padding: 28px 16px;
		min-height: 220px;
	}
	.drop.filled { padding: 0; border-style: solid; overflow: hidden; position: relative; }
	.drop img { display: block; width: 100%; max-height: 60vh; object-fit: contain; background: var(--bg); }
	.pick { display: grid; gap: 6px; justify-items: center; cursor: pointer; text-align: center; }
	.pick .cta { font-weight: 600; padding: 0.5rem 1.1rem; border-radius: 8px; background: var(--accent); color: #fff; }
	.pick .hint { color: var(--muted); font-size: 0.8rem; }
	input[type='file'] { display: none; }
	.replace {
		position: absolute;
		right: 10px;
		bottom: 10px;
		cursor: pointer;
		font-size: 0.8rem;
		padding: 0.3rem 0.7rem;
		border-radius: 8px;
		background: rgba(0, 0, 0, 0.65);
		color: #fff;
	}

	.fields { display: grid; gap: 12px; }
	@media (min-width: 560px) { .fields { grid-template-columns: 1fr 1fr; } }
	label { display: grid; gap: 4px; font-size: 0.82rem; color: var(--muted); min-width: 0; }
	.field { display: grid; gap: 4px; font-size: 0.82rem; color: var(--muted); min-width: 0; }
	label :is(input, select, textarea) { width: 100%; color: var(--text); }
	.wide { grid-column: 1 / -1; }
	em { font-style: normal; opacity: 0.7; }

	.err { color: #c0392b; margin: 0; font-size: 0.85rem; }
	.submit { display: flex; align-items: center; gap: 16px; }
	.submit a { color: var(--muted); text-decoration: none; font-size: 0.85rem; }
</style>
