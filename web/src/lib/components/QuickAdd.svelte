<script lang="ts">
	import { t } from '#lib/i18n.js';
	import { onMount, untrack } from 'svelte';
	import type PocketBase from 'pocketbase';
	import type { Level, Project } from '#lib/types.js';
	import { levelStore } from '#lib/levels.svelte.js';
	import { checkImage, cleanTags, createInspiration } from '#lib/inspirations.js';
	import TagInput from './TagInput.svelte';

	interface Props {
		pb: PocketBase;
		userId: string;
		projects: Project[];
		/** Image to preload (e.g. pasted on the map). */
		file?: File | null;
		/** Tags to preselect (e.g. the tag whose "+" was clicked). */
		tags?: string[];
		/** Project to preselect; null = no project. */
		projectId?: string | null;
		/** Past tags for one-click chips. */
		suggestions?: string[];
		onclose: () => void;
		/** Called after a successful save with the new inspiration id. */
		onsaved: (id: string) => void;
	}
	let {
		pb,
		userId,
		projects,
		file = null,
		tags: initialTags = [],
		projectId: initialProject = null,
		suggestions = [],
		onclose,
		onsaved
	}: Props = $props();

	// Initial values are read once; later prop changes do not overwrite the user's edits.
	const start = untrack(() => ({
		file,
		tags: cleanTags(initialTags),
		projectId: initialProject
	}));

	let dialog = $state<HTMLDialogElement | null>(null);
	let formEl = $state<HTMLFormElement | null>(null);
	let noteEl = $state<HTMLTextAreaElement | null>(null);

	let image = $state<File | null>(start.file);
	let preview = $state('');
	let note = $state('');
	let tags = $state<string[]>([...start.tags]);
	let level = $state<Level | ''>('');
	let projectId = $state(start.projectId ?? '');
	let busy = $state(false);
	let error = $state('');

	onMount(() => {
		const d = dialog;
		if (d && !d.open) d.showModal();
		// A preloaded image needs its preview URL only on the client.
		if (image && !preview) preview = URL.createObjectURL(image);
		// Focus the note when an image is already there, else the picker/close button.
		if (start.file) noteEl?.focus();

		const onPaste = (e: ClipboardEvent) => {
			const items = e.clipboardData?.items;
			if (!items) return;
			for (const item of items) {
				if (item.kind === 'file' && item.type.startsWith('image/')) {
					const f = item.getAsFile();
					if (!f) return;
					e.preventDefault();
					accept(f);
					return;
				}
			}
		};
		if (d?.open) window.addEventListener('paste', onPaste);

		return () => {
			window.removeEventListener('paste', onPaste);
			if (preview) URL.revokeObjectURL(preview);
		};
	});

	function accept(f: File | null) {
		error = '';
		if (!f) return;
		try {
			checkImage(f);
		} catch (e) {
			error = e instanceof Error ? e.message : t('new.unsupported');
			return;
		}
		image = f;
		if (preview) URL.revokeObjectURL(preview);
		preview = URL.createObjectURL(f);
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

	function onCancel(e: Event) {
		// Escape and the browser's close request both land here.
		e.preventDefault();
		if (!busy) onclose();
	}

	/** A click on the backdrop (the dialog element itself) closes the modal. */
	function onDialogClick(e: MouseEvent) {
		if (e.target === dialog) onclose();
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (busy) return;
		const f = image;
		if (!f) {
			error = t('quick.pickFirst');
			return;
		}
		busy = true;
		error = '';
		try {
			const { id } = await createInspiration(pb, userId, f, {
				project_id: projectId || null,
				note,
				tags,
				level: level || null
			});
			onsaved(id);
		} catch (e) {
			error = e instanceof Error ? e.message : t('new.saveFailed');
		} finally {
			busy = false;
		}
	}

	function onNoteKey(e: KeyboardEvent) {
		// Enter saves, Shift+Enter keeps the newline.
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			formEl?.requestSubmit();
		}
	}

	/** Enter saves from every control; selects do not submit a form on their own. */
	function onFormKey(e: KeyboardEvent) {
		if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.defaultPrevented) return;
		if (e.target instanceof HTMLTextAreaElement) return;
		e.preventDefault();
		formEl?.requestSubmit();
	}
</script>

<dialog bind:this={dialog} oncancel={onCancel} onclick={onDialogClick}>
	<form bind:this={formEl} onsubmit={save} onkeydown={onFormKey}>
		<header>
			<h2>{t('common.newImage')}</h2>
			<button class="x" type="button" onclick={onclose} aria-label={t('common.close')}>×</button>
		</header>

		<div
			class="drop"
			class:filled={!!preview}
			role="button"
			tabindex="0"
			ondragover={(e) => e.preventDefault()}
			ondrop={onDrop}
			onkeydown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					(e.currentTarget as HTMLElement).querySelector('input')?.click();
				}
			}}
		>
			{#if preview}
				<img src={preview} alt={t('new.preview')} />
				<label class="replace">
					<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" onchange={onPick} />
					{t('quick.change')}
				</label>
			{:else}
				<label class="pick">
					<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" onchange={onPick} />
					<span class="cta">{t('quick.pick')}</span>
					<span class="hint">{t('new.formats')}</span>
				</label>
			{/if}
		</div>

		<label class="field">
			<span>{t('new.note')}</span>
			<textarea
				bind:this={noteEl}
				bind:value={note}
				rows="3"
				placeholder={t('new.notePlaceholder')}
				onkeydown={onNoteKey}
			></textarea>
		</label>

		<div class="field">
			<span>Tags <em>{t('new.tagsLimit')}</em></span>
			<TagInput bind:tags {suggestions} placeholder={t('tags.placeholder')} />
		</div>

		<div class="row">
			<label class="field">
				<span>{t('common.level')}</span>
				<select bind:value={level}>
					<option value="">—</option>
					{#each levelStore.list as l (l.id)}<option value={l.id}>{l.name}</option>{/each}
				</select>
			</label>
			<label class="field">
				<span>Project</span>
				<select bind:value={projectId}>
					<option value="">{t('common.noProject')}</option>
					{#each projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
				</select>
			</label>
		</div>

		{#if error}<p class="err">{error}</p>{/if}

		<div class="actions">
			<button type="button" onclick={onclose}>{t('common.cancel')}</button>
			<button class="primary" type="submit" disabled={busy || !image}>
				{busy ? t('common.saving') : t('common.save')}
			</button>
		</div>
	</form>
</dialog>

<style>
	dialog {
		width: min(560px, 100vw - 32px);
		max-height: calc(100vh - 32px);
		padding: 0;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		overflow: auto;
	}
	dialog::backdrop { background: rgba(0, 0, 0, 0.45); }

	form { display: grid; gap: 12px; padding: 16px; }

	header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
	h2 { font-size: 1rem; margin: 0; }
	.x { border: none; background: none; font-size: 1.2rem; line-height: 1; padding: 0.2rem 0.5rem; color: var(--muted); }
	.x:hover { color: #c0392b; }

	.drop {
		border: 1.5px dashed var(--line);
		border-radius: var(--radius);
		background: var(--surface);
		display: grid;
		place-items: center;
		padding: 20px 16px;
		min-height: 140px;
	}
	.drop.filled { padding: 0; border-style: solid; overflow: hidden; position: relative; }
	.drop img { display: block; width: 100%; max-height: 40vh; object-fit: contain; background: var(--bg); }
	.pick { display: grid; gap: 6px; justify-items: center; cursor: pointer; text-align: center; }
	.pick .cta { font-weight: 600; padding: 0.4rem 1rem; border-radius: 8px; background: var(--accent); color: #fff; font-size: 0.9rem; }
	.pick .hint { color: var(--muted); font-size: 0.8rem; }
	input[type='file'] { display: none; }
	.replace {
		position: absolute;
		right: 8px;
		bottom: 8px;
		cursor: pointer;
		font-size: 0.8rem;
		padding: 0.25rem 0.6rem;
		border-radius: 8px;
		background: rgba(0, 0, 0, 0.65);
		color: #fff;
	}

	.field { display: grid; gap: 4px; font-size: 0.8rem; color: var(--muted); min-width: 0; }
	.field :is(textarea, select) { width: 100%; color: var(--text); }
	.row { display: grid; gap: 10px; }
	@media (min-width: 480px) { .row { grid-template-columns: 1fr 1fr; } }
	em { font-style: normal; opacity: 0.7; }

	.err { color: #c0392b; margin: 0; font-size: 0.85rem; }

	.actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
