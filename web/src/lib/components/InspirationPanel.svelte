<script lang="ts">
	import { t } from '#lib/i18n.js';
	// CONTRACT (fixed). Inline editor for one inspiration with autosave (see DESIGN.md "Inspiration panel").
	import type PocketBase from 'pocketbase';
	import type { Inspiration, Project } from '#lib/types.js';
	import type { Level, Region, Suggestion } from '#lib/types.js';
	import { levelLabel, levelStore } from '#lib/levels.svelte.js';
	import { acceptSuggestion, copyInspiration, deleteInspiration, updateInspiration, type EditableFields } from '#lib/inspirations.js';
	import TagInput from '#lib/components/TagInput.svelte';
	import RegionEditor from '#lib/components/RegionEditor.svelte';
	import RegionList from '#lib/components/RegionList.svelte';
	import SmartSuggest from '#lib/components/SmartSuggest.svelte';
	import SimilarImages from '#lib/components/SimilarImages.svelte';
	import SourceProjectField from '#lib/components/SourceProjectField.svelte';
	import { tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { Autosaver, type SaveState } from '#lib/autosave.js';
	interface Props {
		pb: PocketBase;
		userId: string;
		item: Inspiration;
		imageUrl: string | null;
		projects: Project[];
		/** Past tags for one-click chips. */
		suggestions: string[];
		/** Source project names already in use, for the suggestions list. */
		sourceProjects?: string[];
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
		/** Open the image full screen (view and crop). Undefined hides the button. */
		onexpand?: () => void;
		/** Open another image in this panel (a similar image was pressed). */
		onpick?: (id: string) => void;
	}
	let {
		pb,
		userId,
		item,
		imageUrl,
		projects,
		suggestions,
		sourceProjects = [],
		focusNote = false,
		onsaved,
		oncopied,
		ondeleted,
		onclose,
		onprev,
		onnext,
		onexpand,
		onpick
	}: Props = $props();

	// Local editable copies. A change of `item` with the same id only refreshes fields the user has
	// no unsaved edit for, so a row coming back from the parent (or a retag on the board) shows up
	// without overwriting what the user is typing.
	let id = '';
	let note = $state('');
	let tags = $state<string[]>([]);
	let level = $state<Level | null>(null);
	let regions = $state<Region[]>([]);
	let suggestion = $state<Suggestion | null>(null);
	let sourceProject = $state<string | null>(null);
	let active = $state<number | null>(null);

	let status = $state<SaveState>('idle');
	let failure = $state('');
	let busy = $state<'' | 'copy' | 'delete' | 'leave'>('');
	let actionError = $state('');
	let noteEl = $state<HTMLTextAreaElement | null>(null);

	// One saver for the panel's lifetime: it keeps unsaved edits per item id across item switches.
	const saver = new Autosaver<EditableFields>(
		(target, f) => updateInspiration(pb, target, f).then((row) => onsaved(row)),
		700,
		(s, e) => {
			status = s;
			failure = e;
		}
	);

	/** Show the stored item, with the newest unsaved edits of that item on top. */
	function sync(it: Inspiration) {
		const d = saver.draft(it.id);
		note = d.note !== undefined ? (d.note ?? '') : (it.note ?? '');
		tags = [...((d.tags !== undefined ? d.tags : it.tags) ?? [])];
		level = d.level !== undefined ? d.level : (it.level ?? null);
		suggestion = d.suggestion !== undefined ? d.suggestion : (it.suggestion ?? null);
		sourceProject = d.source_project !== undefined ? d.source_project : (it.source_project ?? null);
		regions = ((d.regions !== undefined ? d.regions : it.regions) ?? []).map((r) => ({ ...r }));
	}

	$effect.pre(() => {
		const it = item;
		untrack(() => {
			if (it.id === id) {
				sync(it);
				return;
			}
			if (id) void saver.flush();
			id = it.id;
			sync(it);
			active = null;
			actionError = '';
			if (focusNote) tick().then(() => noteEl?.focus());
		});
	});

	// Send pending edits when the panel goes away.
	$effect(() => () => void saver.flush());

	function change<K extends keyof EditableFields>(key: K, value: EditableFields[K]) {
		saver.set(id, key, value);
	}

	/** Close only once the edits are stored; on failure stay open with the error and «Ξανά». */
	export async function close() {
		if (busy) return;
		busy = 'leave';
		const ok = await saver.flush();
		busy = '';
		if (ok || confirm(t('panel.leaveConfirm'))) onclose();
	}

	async function openFull() {
		if (busy) return;
		const target = id;
		busy = 'leave';
		const ok = await saver.flush();
		busy = '';
		if (ok) await goto(`/i/${target}`);
	}

	function setLevel(l: Level) {
		level = level === l ? null : l;
		change('level', level);
	}

	/** Apply the AI suggestion (its level, plus its tags) and clear it, in one autosave. */
	function accept() {
		if (!suggestion) return;
		// A level the user has deleted since the AI proposed it is dropped; the tags still apply.
		// With no levels loaded (a failed fetch) nothing can be told apart, so the level stays.
		const known = suggestion.level && (levelLabel(suggestion.level) || !levelStore.list.length) ? suggestion.level : null;
		const next = acceptSuggestion({ level, tags }, { ...suggestion, level: known });
		level = next.level;
		tags = next.tags;
		suggestion = null;
		change('level', level);
		change('tags', tags);
		change('suggestion', null);
	}

	function dismiss() {
		suggestion = null;
		change('suggestion', null);
	}

	async function copyTo(e: Event & { currentTarget: HTMLSelectElement }) {
		const sel = e.currentTarget;
		const value = sel.value;
		sel.value = '';
		if (!value || busy) return;
		const target = id;
		const projectId = value === '-' ? null : value;
		busy = 'copy';
		actionError = '';
		try {
			// The copy reads the stored row, so store the latest edits first.
			if (!(await saver.flush())) throw new Error(t('panel.notSavedYet'));
			await copyInspiration(pb, userId, target, projectId);
			oncopied(projectId ? (projects.find((p) => p.id === projectId)?.name ?? null) : null);
		} catch (err) {
			actionError = err instanceof Error ? err.message : String(err);
		} finally {
			busy = '';
		}
	}

	async function remove() {
		if (busy || !confirm(t('item.deleteConfirm'))) return;
		const target = id;
		busy = 'delete';
		actionError = '';
		try {
			await saver.flush();
			await deleteInspiration(pb, target);
			saver.discard(target);
			ondeleted(target);
		} catch (err) {
			actionError = err instanceof Error ? err.message : String(err);
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

<svelte:window onpagehide={() => void saver.flush()} />

<section class="panel" aria-label={t('panel.aria')}>
	<header>
		<div class="title">
			<span class="lvl">{levelLabel(level) || t('panel.image')}</span>
			<span class={['status', status]} aria-live="polite">
				{#if status === 'saving' || status === 'pending'}
					{t('common.saving')}
				{:else if status === 'saved'}
					{t('item.saved')}
				{:else if status === 'error'}
					<span class="err" title={failure}>{t('item.notSaved')}</span>
					<button type="button" class="retry" onclick={() => void saver.retry()}>{t('item.retry')}</button>
				{/if}
			</span>
		</div>
		<div class="nav">
			{#if onprev}
				<button type="button" class="icon" aria-label={t('panel.prevImage')} title={t('panel.prevTitle')} onclick={onprev}>
					<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
				</button>
			{/if}
			{#if onnext}
				<button type="button" class="icon" aria-label={t('panel.nextImage')} title={t('panel.nextTitle')} onclick={onnext}>
					<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" /></svg>
				</button>
			{/if}
			<button type="button" class="icon" aria-label={t('common.close')} title={t('panel.closeTitle')} onclick={close}>
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
			</button>
		</div>
	</header>

	<div class="body">
		{#if status === 'error' && failure}
			<p class="banner" role="alert">{failure}</p>
		{/if}

		<div class="well">
			{#if onexpand && imageUrl}
				<button type="button" class="expand" aria-label={t('panel.fullscreen')} title={t('panel.fullscreenTitle')} onclick={onexpand}>
					<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /></svg>
				</button>
			{/if}
			<RegionEditor
				src={imageUrl}
				alt={note || t('item.alt')}
				bind:regions={() => regions, (v) => ((regions = v), change('regions', v))}
				bind:active
			/>
		</div>

		<label class="field">
			<span class="lbl">{t('panel.noteLabel')}</span>
			<textarea
				bind:this={noteEl}
				bind:value={() => note, (v) => ((note = v), change('note', v))}
				{@attach autogrow}
				rows="2"
				placeholder={t('item.notePlaceholder')}
			></textarea>
		</label>

		{#if suggestion}
			<div class="suggest" role="group" aria-labelledby="panel-suggest">
				<span class="lbl" id="panel-suggest">{t('panel.suggestion')}</span>
				<p class="chips">
					{#if levelLabel(suggestion.level)}<span class="chip on">{levelLabel(suggestion.level)}</span>{/if}
					{#each suggestion.tags as t (t)}<span class={['chip', tags.includes(t) && 'have']}>#{t}</span>{/each}
				</p>
				<div class="sbtns">
					<button type="button" class="btn primary" onclick={accept}>{t('panel.accept')}</button>
					<button type="button" class="btn ghost" onclick={dismiss}>{t('panel.dismiss')}</button>
				</div>
			</div>
		{/if}

		<div class="field">
			<label class="lbl" for="panel-tags">Tags</label>
			<TagInput
				id="panel-tags"
				bind:tags={() => tags, (v) => ((tags = v), change('tags', v))}
				{suggestions}
				placeholder={t('item.tagsPlaceholder')}
			/>
		</div>

		<div class="field">
			<span class="lbl" id="panel-level">{t('common.level')}</span>
			<div class="chips" role="group" aria-labelledby="panel-level">
				{#each levelStore.list as l (l.id)}
					<button type="button" class={['chip', level === l.id && 'on']} aria-pressed={level === l.id} onclick={() => setLevel(l.id)}>
						{l.name}
					</button>
				{/each}
			</div>
		</div>

		<SmartSuggest
			{pb}
			id={item.id}
			{tags}
			{level}
			onaddtag={(tg) => {
				if (tags.includes(tg)) return;
				tags = [...tags, tg];
				change('tags', tags);
			}}
			onsetlevel={(l) => {
				level = l;
				change('level', l);
			}}
		/>

		<div class="field">
			<span class="lbl">{t('item.regions')}{regions.length ? ` · ${regions.length}` : ''}</span>
			<RegionList bind:regions={() => regions, (v) => ((regions = v), change('regions', v))} bind:active />
		</div>

		<SourceProjectField
			{pb}
			id={item.id}
			value={sourceProject}
			names={sourceProjects}
			onchange={(v) => {
				sourceProject = v;
				change('source_project', v);
			}}
		/>

		{#if safeSource}
			<div class="field">
				<span class="lbl">{t('item.source')}</span>
				<a class="src" href={safeSource} target="_blank" rel="noopener noreferrer">{sourceLabel}</a>
			</div>
		{/if}

		<SimilarImages {pb} id={item.id} {onpick} />

		{#if actionError}<p class="banner" role="alert">{actionError}</p>{/if}
	</div>

	<footer>
		<label class="copy">
			<span class="sr">{t('panel.copyToProject')}</span>
			<select onchange={copyTo} disabled={!!busy}>
				<option value="" selected>{busy === 'copy' ? t('panel.copying') : t('panel.copyTo')}</option>
				{#each projects.filter((p) => !p.archived) as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
				<option value="-">{t('common.noProject')}</option>
			</select>
			<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5 8 10l3.5-3.5" /></svg>
		</label>
		<a class="btn ghost" href={`/i/${item.id}`} onclick={(e) => { e.preventDefault(); void openFull(); }}>{t('panel.fullPage')}</a>
		<span class="grow"></span>
		<button type="button" class="btn ghost danger" disabled={!!busy} onclick={remove}>
			{busy === 'delete' ? t('item.deleting') : t('common.delete')}
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
		font-size: 14px;
		font-weight: 600;
		color: var(--text);
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
		position: relative;
		background: var(--sunk);
		border-radius: var(--r-ctl);
		padding: 12px;
		--re-max-h: min(52vh, 440px);
	}

	/* On the tool row above the image (the well's padding is 12px), same look as the Πλαίσιο / Ελεύθερο buttons. */
	.expand {
		position: absolute;
		top: 12px;
		right: 12px;
		z-index: 2;
		display: grid;
		place-items: center;
		box-sizing: border-box;
		width: 30px;
		height: 30px;
		padding: 0;
		border-radius: var(--r-ctl);
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--muted);
		cursor: pointer;
		transition: color 150ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.expand:hover {
		color: var(--text);
	}
	.expand svg {
		width: 16px;
		height: 16px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.field {
		display: grid;
		gap: 6px;
		min-width: 0;
	}
	.suggest {
		display: grid;
		gap: 8px;
		padding: 10px 12px;
		background: var(--sunk);
		border: 1px solid var(--line);
		border-radius: var(--r-ctl);
	}
	.suggest .chips {
		margin: 0;
	}
	.suggest .chip {
		cursor: default;
	}
	.suggest .chip.have {
		color: var(--faint);
	}
	.sbtns {
		display: flex;
		gap: 8px;
	}
	.lbl {
		font-size: 12.5px;
		font-weight: 600;
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
