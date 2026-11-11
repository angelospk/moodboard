<script lang="ts">
	import { beforeNavigate, goto } from '$app/navigation';
	import { LEVELS, type Level, type Region } from '#lib/types.js';
	import { LEVEL_LABELS } from '#lib/tags.js';
	import { deleteInspiration, updateInspiration, type EditableFields } from '#lib/inspirations.js';
	import TagInput from '#lib/components/TagInput.svelte';
	import RegionEditor from '#lib/components/RegionEditor.svelte';
	import RegionList from '#lib/components/RegionList.svelte';
	import { untrack } from 'svelte';
	import { Autosaver, type SaveState } from '#lib/autosave.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Form state is intentionally initialized once; edits autosave, they are not reloaded.
	const item = untrack(() => data.inspiration);

	let note = $state(item.note);
	let tags = $state<string[]>([...item.tags]);
	let level = $state<Level | null>(item.level ?? null);
	let projectId = $state(item.project_id ?? '');
	let regions = $state<Region[]>(item.regions.map((r) => ({ ...r })));
	let active = $state<number | null>(null);

	const project = $derived(data.projects.find((p) => p.id === projectId) ?? null);
	const safeSource = $derived(item.source_url && /^https?:\/\//i.test(item.source_url) ? item.source_url : null);
	const sourceLabel = $derived.by(() => {
		if (item.source_title) return item.source_title;
		try {
			const u = new URL(safeSource ?? '');
			return u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 ? u.pathname : '');
		} catch {
			return safeSource ?? '';
		}
	});

	// ---------- autosave: the shared Autosaver (same engine as InspirationPanel) ----------
	let status = $state<SaveState>('idle');
	let failure = $state('');
	let deleting = $state(false);
	let leaving = false;

	const saver = new Autosaver<EditableFields>(
		(id, f) => updateInspiration(data.pb, id, f),
		700,
		(s, e) => {
			status = s;
			failure = e;
		}
	);

	function change<K extends keyof EditableFields>(key: K, value: EditableFields[K]) {
		saver.set(item.id, key, value);
	}

	const unsaved = () => status === 'pending' || status === 'saving' || status === 'error';

	// Hold in-app navigation until the edits are stored; on failure ask before leaving them.
	beforeNavigate((nav) => {
		if (leaving || deleting || nav.type === 'leave' || !unsaved()) return;
		nav.cancel();
		const to = nav.to?.url;
		void saver.flush().then((ok) => {
			if (!to) return;
			if (ok || confirm('Οι αλλαγές δεν αποθηκεύτηκαν. Φεύγεις χωρίς αποθήκευση;')) {
				leaving = true;
				void goto(to);
			}
		});
	});
	$effect(() => () => void saver.flush());

	function onBeforeUnload(e: BeforeUnloadEvent) {
		if (!unsaved()) return;
		void saver.flush();
		e.preventDefault();
	}

	function setLevel(l: Level) {
		level = level === l ? null : l;
		change('level', level);
	}

	async function remove() {
		if (deleting || !confirm('Διαγραφή αυτής της εικόνας;')) return;
		deleting = true;
		try {
			await saver.flush();
			await deleteInspiration(data.pb, item.id);
			saver.discard(item.id);
			await goto(project ? `/map?project=${encodeURIComponent(project.id)}` : '/');
		} catch (err) {
			deleting = false;
			failure = err instanceof Error ? err.message : String(err);
			status = 'error';
		}
	}

	function autogrow(el: HTMLTextAreaElement) {
		void note;
		el.style.height = 'auto';
		el.style.height = `${el.scrollHeight + 2}px`;
	}
</script>

<svelte:head>
	<title>{note.trim() ? `${note.trim().slice(0, 40)} · ` : ''}Moodboard</title>
</svelte:head>

<svelte:window onbeforeunload={onBeforeUnload} onpagehide={() => void saver.flush()} />

<div class="page">
	<header>
		<nav class="crumb" aria-label="Διαδρομή">
			<a class="home" href="/">Moodboard</a>
			<span aria-hidden="true">›</span>
			{#if project}
				<a class="proj" href={`/map?project=${encodeURIComponent(project.id)}`}>{project.name}</a>
			{:else}
				<a class="proj" href="/map?project=none">Χωρίς project</a>
			{/if}
		</nav>
		<span class="grow"></span>
		<span class={['status', status]} aria-live="polite">
			{#if status === 'saving' || status === 'pending'}
				Αποθήκευση…
			{:else if status === 'saved'}
				Αποθηκεύτηκε ✓
			{:else if status === 'error'}
				<span class="err">Δεν αποθηκεύτηκε</span>
				<button type="button" class="retry" onclick={() => void saver.retry()}>Ξανά</button>
			{/if}
		</span>
	</header>

	<main class="editor">
		<section class="stage" aria-label="Εικόνα και περιοχές">
			<RegionEditor
				src={data.imageUrl}
				alt={note || 'Έμπνευση'}
				labels
				bind:regions={() => regions, (v) => ((regions = v), change('regions', v))}
				bind:active
			/>
			<p class="hint">
				Σύρε πάνω στην εικόνα για να σημειώσεις μια λεπτομέρεια
				{#if safeSource}
					· <a href={safeSource} target="_blank" rel="noopener noreferrer">{sourceLabel}</a>
				{/if}
			</p>
		</section>

		<aside>
			<div class="body">
				{#if failure}<p class="banner" role="alert">{failure}</p>{/if}

				<div class="field">
					<span class="lbl">Περιοχές{regions.length ? ` · ${regions.length}` : ''}</span>
					<RegionList bind:regions={() => regions, (v) => ((regions = v), change('regions', v))} bind:active />
				</div>

				<label class="field">
					<span class="lbl">Σημείωση εικόνας</span>
					<textarea
						bind:value={() => note, (v) => ((note = v), change('note', v))}
						{@attach autogrow}
						rows="3"
						placeholder="Τι σου αρέσει εδώ;"
					></textarea>
				</label>

				<div class="field">
					<label class="lbl" for="item-tags">Tags</label>
					<TagInput
						id="item-tags"
						bind:tags={() => tags, (v) => ((tags = v), change('tags', v))}
						suggestions={data.tags}
						placeholder="ξύλο, φως…"
					/>
				</div>

				<div class="field">
					<span class="lbl" id="item-level">Επίπεδο</span>
					<div class="chips" role="group" aria-labelledby="item-level">
						{#each LEVELS as l (l)}
							<button type="button" class={['chip', level === l && 'on']} aria-pressed={level === l} onclick={() => setLevel(l)}>
								{LEVEL_LABELS[l]}
							</button>
						{/each}
					</div>
				</div>

				<label class="field">
					<span class="lbl">Project</span>
					<select bind:value={() => projectId, (v) => ((projectId = v), change('project_id', v || null))}>
						<option value="">Χωρίς project</option>
						{#each data.projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
					</select>
				</label>

				{#if safeSource}
					<div class="field">
						<span class="lbl">Πηγή</span>
						<a class="src" href={safeSource} target="_blank" rel="noopener noreferrer">{sourceLabel}</a>
					</div>
				{/if}
			</div>

			<footer>
				<span class="grow"></span>
				<button type="button" class="btn ghost danger" disabled={deleting} onclick={remove}>
					{deleting ? 'Διαγραφή…' : 'Διαγραφή'}
				</button>
			</footer>
		</aside>
	</main>
</div>

<style>
	.page {
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
		background: var(--bg);
		color: var(--text);
		font-size: 14px;
		line-height: 1.45;
	}

	header {
		position: sticky;
		top: 0;
		z-index: 5;
		height: 56px;
		flex: none;
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 0 20px;
		background: var(--surface);
		border-bottom: 1px solid var(--line);
	}
	.crumb {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		color: var(--muted);
	}
	.crumb a {
		text-decoration: none;
		white-space: nowrap;
	}
	.home {
		color: var(--muted);
		font-size: 13px;
	}
	.home:hover {
		color: var(--text);
	}
	.proj {
		font-family: var(--font-serif);
		font-size: 16px;
		font-weight: 600;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.proj:hover {
		text-decoration: underline;
		text-decoration-color: var(--line-strong);
		text-underline-offset: 4px;
	}
	.grow {
		flex: 1;
	}

	.status {
		display: inline-flex;
		align-items: baseline;
		gap: 6px;
		font-size: 12.5px;
		color: var(--muted);
		white-space: nowrap;
	}
	.status.saved {
		color: var(--ok);
	}
	.status .err {
		color: var(--accent);
	}
	.retry {
		border: 0;
		background: none;
		padding: 0;
		font-size: 12.5px;
		font-weight: 600;
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.editor {
		flex: 1;
		display: grid;
		min-height: 0;
	}
	.stage {
		background: var(--sunk);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 12px;
		padding: 16px;
		min-width: 0;
		--re-max-h: 62vh;
	}
	.hint {
		margin: 0;
		color: var(--muted);
		font-size: 12.5px;
		text-align: center;
		overflow-wrap: anywhere;
	}
	.hint a {
		color: var(--text);
		text-decoration-color: var(--line-strong);
		text-underline-offset: 3px;
	}

	aside {
		display: flex;
		flex-direction: column;
		min-width: 0;
		background: var(--surface);
	}
	.body {
		padding: 20px;
		display: grid;
		gap: 20px;
		align-content: start;
	}
	footer {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 14px;
		border-top: 1px solid var(--line);
		background: var(--surface);
	}

	.field {
		display: grid;
		gap: 6px;
		min-width: 0;
	}
	.lbl {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--muted);
	}
	textarea,
	select {
		width: 100%;
		border: 1px solid var(--line-strong);
		background: var(--raised);
		border-radius: var(--r-ctl);
		padding: 9px 11px;
		font-size: 14px;
		color: var(--text);
	}
	textarea {
		min-height: 72px;
		resize: none;
		overflow: hidden;
		font-size: 15px;
		line-height: 1.5;
	}
	textarea::placeholder {
		color: var(--faint);
	}
	textarea:focus,
	select:focus {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
		border-color: var(--accent);
	}
	.chip {
		min-height: 32px;
		padding: 5px 12px;
	}
	.src {
		color: var(--text);
		font-size: 13px;
		text-decoration-color: var(--line-strong);
		text-underline-offset: 3px;
		overflow-wrap: anywhere;
	}
	.src:hover {
		text-decoration-color: var(--accent);
	}
	.banner {
		margin: 0;
		padding: 8px 12px;
		border-radius: var(--r-ctl);
		background: var(--accent-soft);
		font-size: 12.5px;
		overflow-wrap: anywhere;
	}
	.btn:disabled {
		opacity: 0.55;
		cursor: default;
	}

	/* Desktop: image fills the left, the form is a 400px column with its own scroll. */
	@media (min-width: 900px) {
		.page {
			height: 100dvh;
			min-height: 0;
		}
		.editor {
			grid-template-columns: minmax(0, 1fr) 400px;
			overflow: hidden;
		}
		.stage {
			padding: 24px;
			--re-max-h: calc(100dvh - 56px - 48px - 36px);
		}
		aside {
			border-left: 1px solid var(--line);
			overflow-y: auto;
			overscroll-behavior: contain;
			scrollbar-width: thin;
			scrollbar-color: var(--line-strong) transparent;
		}
		footer {
			position: sticky;
			bottom: 0;
			margin-top: auto;
		}
	}

	@media (pointer: coarse) {
		.chip {
			min-height: 40px;
		}
	}
</style>
