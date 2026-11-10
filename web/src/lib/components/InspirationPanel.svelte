<script lang="ts">
	// CONTRACT (fixed). Inline editor for one inspiration with autosave (see DESIGN.md "Inspiration panel").
	import type { SupabaseClient } from '@supabase/supabase-js';
	import type { Inspiration, Project } from '#lib/types.js';
	import { LEVELS, type Level, type Region } from '#lib/types.js';
	import { LEVEL_LABELS } from '#lib/tags.js';
	import { copyInspiration, deleteInspiration, updateInspiration, type EditableFields } from '#lib/inspirations.js';
	import TagInput from '#lib/components/TagInput.svelte';
	import RegionEditor from '#lib/components/RegionEditor.svelte';
	import RegionList from '#lib/components/RegionList.svelte';
	import { tick, untrack } from 'svelte';
	interface Props {
		supabase: SupabaseClient;
		userId: string;
		item: Inspiration;
		imageUrl: string | null;
		projects: Project[];
		/** Past tags for one-click chips. */
		suggestions: string[];
		/** Focus the note on open (e.g. right after a new image was added). */
		focusNote?: boolean;
		/** After each successful autosave, with the saved row. */
		onsaved: (item: Inspiration) => void;
		/** After a successful copy. */
		oncopied: (projectName: string | null) => void;
		/** After a successful delete. */
		ondeleted: (id: string) => void;
		onclose: () => void;
		/** Undefined hides the arrow. */
		onprev?: () => void;
		onnext?: () => void;
	}
	let {
		supabase,
		userId,
		item,
		imageUrl,
		projects,
		suggestions,
		focusNote = false,
		onsaved,
		oncopied,
		ondeleted,
		onclose,
		onprev,
		onnext
	}: Props = $props();

	const DELAY = 700;

	// Local editable copies. They follow `item` only when its id changes, so a saved row coming
	// back from the parent never overwrites what the user is typing.
	let id = '';
	let note = $state('');
	let tags = $state<string[]>([]);
	let level = $state<Level | null>(null);
	let regions = $state<Region[]>([]);
	let active = $state<number | null>(null);

	type Status = 'idle' | 'pending' | 'saving' | 'saved' | 'error';
	let status = $state<Status>('idle');
	let failure = $state('');
	let busy = $state<'' | 'copy' | 'delete'>('');
	let actionError = $state('');
	let noteEl = $state<HTMLTextAreaElement | null>(null);

	let dirty = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inflight: Promise<void> | null = null;
	/** The last failed save, kept so «Ξανά» can resend it even after the user moved to another image. */
	let failed: { id: string; fields: EditableFields } | null = null;

	function load(it: Inspiration) {
		id = it.id;
		note = it.note ?? '';
		tags = [...(it.tags ?? [])];
		level = it.level ?? null;
		regions = (it.regions ?? []).map((r) => ({ ...r }));
		active = null;
		dirty = false;
		actionError = '';
		if (status !== 'error') status = 'idle';
	}

	$effect.pre(() => {
		const it = item;
		untrack(() => {
			if (it.id === id) return;
			if (id) void flush();
			load(it);
			if (focusNote) tick().then(() => noteEl?.focus());
		});
	});

	// Flush a pending save when the panel goes away.
	$effect(() => () => void flush());

	function fields(): EditableFields {
		return { note, tags: $state.snapshot(tags), level, regions: $state.snapshot(regions) };
	}

	function touch() {
		dirty = true;
		if (status !== 'saving') status = 'pending';
		clearTimeout(timer);
		timer = setTimeout(() => void flush(), DELAY);
	}

	function send(target: string, f: EditableFields): Promise<void> {
		status = 'saving';
		failure = '';
		const run = updateInspiration(supabase, target, f)
			.then((row) => {
				if (failed?.id === target) failed = null;
				onsaved(row);
				if (status === 'saving' || status === 'error') status = dirty ? 'pending' : 'saved';
			})
			.catch((e: unknown) => {
				failed = { id: target, fields: f };
				failure = e instanceof Error ? e.message : String(e);
				status = 'error';
			})
			.finally(() => {
				if (inflight === run) inflight = null;
			});
		inflight = run;
		return run;
	}

	/** Save now if anything changed. Resolves when every save so far has finished. */
	async function flush(): Promise<void> {
		clearTimeout(timer);
		timer = undefined;
		if (inflight) await inflight;
		if (!dirty) return;
		dirty = false;
		await send(id, fields());
		// Edits made while that save ran.
		if (dirty) return flush();
	}

	function retry() {
		const f = failed;
		if (!f) return;
		failed = null;
		if (f.id === id) {
			dirty = true;
			void flush();
		} else {
			void send(f.id, f.fields);
		}
	}

	function close() {
		void flush();
		onclose();
	}

	function setLevel(l: Level) {
		level = level === l ? null : l;
		touch();
	}

	async function copyTo(e: Event & { currentTarget: HTMLSelectElement }) {
		const sel = e.currentTarget;
		const value = sel.value;
		sel.value = '';
		if (!value || busy) return;
		const projectId = value === '-' ? null : value;
		busy = 'copy';
		actionError = '';
		try {
			// The copy reads the stored row, so store the latest edits first.
			await flush();
			await copyInspiration(supabase, userId, id, projectId);
			oncopied(projectId ? (projects.find((p) => p.id === projectId)?.name ?? null) : null);
		} catch (err) {
			actionError = err instanceof Error ? err.message : String(err);
		} finally {
			busy = '';
		}
	}

	async function remove() {
		if (busy || !confirm('Διαγραφή αυτής της εικόνας;')) return;
		const target = id;
		busy = 'delete';
		actionError = '';
		clearTimeout(timer);
		dirty = false;
		try {
			if (inflight) await inflight;
			await deleteInspiration(supabase, target);
			ondeleted(target);
		} catch (err) {
			actionError = err instanceof Error ? err.message : String(err);
			// The row is still there: keep saving the edits.
			if (target === id) touch();
		} finally {
			busy = '';
		}
	}

	function autogrow(el: HTMLTextAreaElement) {
		// Reading `note` re-runs this when the text changes, also when another item loads.
		void note;
		el.style.height = 'auto';
		el.style.height = `${el.scrollHeight + 2}px`;
	}

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
</script>

<svelte:window onpagehide={() => void flush()} />

<section class="panel" aria-label="Επεξεργασία εικόνας">
	<header>
		<div class="title">
			<span class="lvl">{level ? LEVEL_LABELS[level] : 'Εικόνα'}</span>
			<span class={['status', status]} aria-live="polite">
				{#if status === 'saving' || status === 'pending'}
					Αποθήκευση…
				{:else if status === 'saved'}
					Αποθηκεύτηκε ✓
				{:else if status === 'error'}
					<span class="err" title={failure}>Δεν αποθηκεύτηκε</span>
					<button type="button" class="retry" onclick={retry}>Ξανά</button>
				{/if}
			</span>
		</div>
		<div class="nav">
			{#if onprev}
				<button type="button" class="icon" aria-label="Προηγούμενη εικόνα" title="Προηγούμενη (←)" onclick={onprev}>
					<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
				</button>
			{/if}
			{#if onnext}
				<button type="button" class="icon" aria-label="Επόμενη εικόνα" title="Επόμενη (→)" onclick={onnext}>
					<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" /></svg>
				</button>
			{/if}
			<button type="button" class="icon" aria-label="Κλείσιμο" title="Κλείσιμο (Esc)" onclick={close}>
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
			</button>
		</div>
	</header>

	<div class="body">
		{#if status === 'error' && failure}
			<p class="banner" role="alert">{failure}</p>
		{/if}

		<div class="well">
			<RegionEditor
				src={imageUrl}
				alt={note || 'Έμπνευση'}
				bind:regions={() => regions, (v) => ((regions = v), touch())}
				bind:active
			/>
		</div>

		<label class="field">
			<span class="lbl">Σημείωση</span>
			<textarea
				bind:this={noteEl}
				bind:value={() => note, (v) => ((note = v), touch())}
				{@attach autogrow}
				rows="2"
				placeholder="Τι σου αρέσει εδώ;"
			></textarea>
		</label>

		<div class="field">
			<label class="lbl" for="panel-tags">Tags</label>
			<TagInput
				id="panel-tags"
				bind:tags={() => tags, (v) => ((tags = v), touch())}
				{suggestions}
				placeholder="ξύλο, φως…"
			/>
		</div>

		<div class="field">
			<span class="lbl" id="panel-level">Επίπεδο</span>
			<div class="chips" role="group" aria-labelledby="panel-level">
				{#each LEVELS as l (l)}
					<button type="button" class={['chip', level === l && 'on']} aria-pressed={level === l} onclick={() => setLevel(l)}>
						{LEVEL_LABELS[l]}
					</button>
				{/each}
			</div>
		</div>

		<div class="field">
			<span class="lbl">Περιοχές{regions.length ? ` · ${regions.length}` : ''}</span>
			<RegionList bind:regions={() => regions, (v) => ((regions = v), touch())} bind:active />
		</div>

		{#if safeSource}
			<div class="field">
				<span class="lbl">Πηγή</span>
				<a class="src" href={safeSource} target="_blank" rel="noopener noreferrer">{sourceLabel}</a>
			</div>
		{/if}

		{#if actionError}<p class="banner" role="alert">{actionError}</p>{/if}
	</div>

	<footer>
		<label class="copy">
			<span class="sr">Αντιγραφή σε project</span>
			<select onchange={copyTo} disabled={!!busy}>
				<option value="" selected>{busy === 'copy' ? 'Αντιγραφή…' : 'Αντιγραφή σε…'}</option>
				{#each projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
				<option value="-">Χωρίς project</option>
			</select>
			<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5 8 10l3.5-3.5" /></svg>
		</label>
		<a class="btn ghost" href={`/i/${item.id}`}>Πλήρης σελίδα</a>
		<span class="grow"></span>
		<button type="button" class="btn ghost danger" disabled={!!busy} onclick={remove}>
			{busy === 'delete' ? 'Διαγραφή…' : 'Διαγραφή'}
		</button>
	</footer>
</section>

<style>
	.panel {
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		background: var(--surface);
		color: var(--text);
		font-size: 14px;
		line-height: 1.45;
		scrollbar-width: thin;
		scrollbar-color: var(--line-strong) transparent;
	}

	header,
	footer {
		position: sticky;
		z-index: 3;
		display: flex;
		align-items: center;
		gap: 8px;
		background: var(--surface);
	}
	header {
		top: 0;
		justify-content: space-between;
		min-height: 52px;
		padding: 8px 12px 8px 20px;
		border-bottom: 1px solid var(--line);
	}
	footer {
		bottom: 0;
		margin-top: auto;
		padding: 10px 14px;
		border-top: 1px solid var(--line);
		gap: 4px;
	}

	.title {
		display: flex;
		align-items: baseline;
		gap: 10px;
		min-width: 0;
	}
	.lvl {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--muted);
		white-space: nowrap;
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
		color: var(--text);
		font-size: 12.5px;
		font-weight: 600;
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.nav {
		display: flex;
		gap: 2px;
		flex: none;
	}
	.icon {
		width: 32px;
		height: 32px;
		display: grid;
		place-items: center;
		padding: 0;
		border: 0;
		background: none;
		border-radius: var(--r-ctl);
		color: var(--muted);
	}
	.icon:hover {
		background: var(--sunk);
		color: var(--text);
	}
	svg {
		width: 16px;
		height: 16px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.body {
		padding: 16px 20px 24px;
		display: grid;
		gap: 18px;
		align-content: start;
	}

	.well {
		background: var(--sunk);
		border-radius: var(--r-ctl);
		padding: 12px;
		--re-max-h: min(52vh, 440px);
	}

	.field {
		display: grid;
		gap: 6px;
		min-width: 0;
	}
	.lbl {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--muted);
	}

	textarea {
		width: 100%;
		min-height: 64px;
		resize: none;
		overflow: hidden;
		border: 1px solid var(--line-strong);
		background: var(--raised);
		border-radius: var(--r-ctl);
		padding: 9px 11px;
		font-size: 15px;
		line-height: 1.5;
		color: var(--text);
	}
	textarea::placeholder {
		color: var(--faint);
	}
	textarea:focus {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
		border-color: var(--accent);
	}

	.chip {
		min-height: 32px;
		padding: 5px 12px;
		transition:
			background-color 150ms cubic-bezier(0.2, 0.8, 0.2, 1),
			border-color 150ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}

	.src {
		color: var(--text);
		font-size: 13px;
		text-decoration: underline;
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
		color: var(--text);
		font-size: 12.5px;
		overflow-wrap: anywhere;
	}

	.copy {
		position: relative;
		display: inline-flex;
		align-items: center;
	}
	.copy select {
		appearance: none;
		border: 1px solid transparent;
		background: none;
		border-radius: var(--r-ctl);
		padding: 7px 28px 7px 12px;
		font-size: 13px;
		color: var(--muted);
		cursor: pointer;
		max-width: 150px;
		text-overflow: ellipsis;
	}
	.copy select:hover:not(:disabled) {
		background: var(--sunk);
		color: var(--text);
	}
	.copy select option {
		color: var(--text);
		background: var(--raised);
	}
	.copy svg {
		position: absolute;
		right: 9px;
		width: 14px;
		height: 14px;
		pointer-events: none;
		color: var(--muted);
	}
	.btn:disabled,
	select:disabled {
		opacity: 0.55;
		cursor: default;
	}
	.grow {
		flex: 1;
	}
	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	@media (pointer: coarse) {
		.icon {
			width: 40px;
			height: 40px;
		}
		.chip {
			min-height: 40px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.chip {
			transition: none;
		}
	}
</style>
