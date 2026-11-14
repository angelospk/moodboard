<script lang="ts">
	import { t } from '#lib/i18n.js';
	import { beforeNavigate, goto } from '$app/navigation';
	import type { Inspiration, Level, Region } from '#lib/types.js';
	import { levelStore } from '#lib/levels.svelte.js';
	import {
		deleteInspiration,
		imageUrls,
		listInspirationsByIds,
		thumbUrl,
		cleanSource,
		updateInspiration,
		updateMany,
		type EditableFields
	} from '#lib/inspirations.js';
	import { duplicatesOf } from '#lib/semantic.js';
	import { smart } from '#lib/smart.svelte.js';
	import SourceProjectField from '#lib/components/SourceProjectField.svelte';
	import SimilarImages from '#lib/components/SimilarImages.svelte';
	import SmartSuggest from '#lib/components/SmartSuggest.svelte';
	import ChatSearch from '#lib/components/ChatSearch.svelte';
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
	let sourceProject = $state<string | null>(item.source_project);
	let regions = $state<Region[]>(item.regions.map((r) => ({ ...r })));
	let active = $state<number | null>(null);

	let source = $state({ url: item.source_url, title: item.source_title });

	const project = $derived(data.projects.find((p) => p.id === projectId) ?? null);
	const safeSource = $derived(source.url && /^https?:\/\//i.test(source.url) ? source.url : null);
	const sourceLabel = $derived.by(() => {
		if (source.title) return source.title;
		try {
			const u = new URL(safeSource ?? '');
			return u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 ? u.pathname : '');
		} catch {
			return safeSource ?? '';
		}
	});

	// ---------- smart search: near-duplicates, chat links (label ideas: SmartSuggest) ----------
	let dups = $state<Inspiration[]>([]);
	let dupUrls = $state<Record<string, string>>({});
	let chatOpen = $state(false);

	$effect(() => {
		if (!smart.embed) return;
		let alive = true;
		duplicatesOf(data.pb, item.id)
			.then(async (ids) => {
				if (!ids.length) return;
				const rows = await listInspirationsByIds(data.pb, ids);
				const urls = await imageUrls(data.pb, rows);
				if (alive) [dups, dupUrls] = [rows, urls];
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	});

	const chatContext = $derived({
		projectName: project?.name ?? null,
		levelName: levelStore.list.find((l) => l.id === level)?.name ?? null,
		tags,
		note,
		colors: item.colors,
		sourceUrl: safeSource
	});

	function addTag(tag: string) {
		if (tags.includes(tag)) return;
		tags = [...tags, tag];
		change('tags', tags);
	}

	// ---------- similar images picked together: one project, one common source ----------
	let similar: SimilarImages | undefined = $state();
	let picked = $state<string[]>([]);
	let picking = $state(false);
	let bulkProject = $state('');
	let bulkSource = $state('');
	let bulkBusy = $state(false);
	let bulkMsg = $state('');

	async function applyBulk(e: SubmitEvent) {
		e.preventDefault();
		if (bulkBusy || !picked.length) return;
		const src = bulkSource.trim() ? cleanSource(bulkSource) : null;
		if (bulkSource.trim() && !src) {
			bulkMsg = t('bulk.badSource');
			return;
		}
		if (!bulkProject && !src) return;
		const fields: EditableFields = {};
		if (bulkProject) fields.project_id = bulkProject === '-' ? null : bulkProject;
		if (src) Object.assign(fields, { source_url: src, source_title: null });
		bulkBusy = true;
		bulkMsg = '';
		// This image goes through its own autosave (queued first, so a later edit of the form wins),
		// so the form and the saved row never disagree; the other images are saved at the same time.
		if (fields.project_id !== undefined) {
			projectId = fields.project_id ?? '';
			change('project_id', fields.project_id);
		}
		if (src) {
			source = { url: src, title: null };
			change('source_url', src);
			change('source_title', null);
		}
		const [out, selfSaved] = await Promise.all([updateMany(data.pb, picked, fields), saver.flush()]);
		bulkBusy = false;
		const ok = out.ok.length + (selfSaved ? 1 : 0);
		const failed = out.failed.length + (selfSaved ? 0 : 1);
		bulkMsg = failed ? t('bulk.partial', { ok, failed }) : t('bulk.changed', { n: ok });
		if (!failed) {
			bulkProject = '';
			bulkSource = '';
			picking = false;
			picked = [];
			similar?.refresh();
		} else {
			picked = out.failed;
		}
	}

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
			if (ok || confirm(t('item.leaveConfirm'))) {
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
		if (deleting || !confirm(t('item.deleteConfirm'))) return;
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
		<nav class="crumb" aria-label={t('common.breadcrumb')}>
			<a class="home" href="/">Moodboard</a>
			<span aria-hidden="true">›</span>
			{#if project}
				<a class="proj" href={`/map?project=${encodeURIComponent(project.id)}`}>{project.name}</a>
			{:else}
				<a class="proj" href="/map?project=none">{t('common.noProject')}</a>
			{/if}
		</nav>
		<span class="grow"></span>
		<span class={['status', status]} aria-live="polite">
			{#if status === 'saving' || status === 'pending'}
				{t('common.saving')}
			{:else if status === 'saved'}
				{t('item.saved')}
			{:else if status === 'error'}
				<span class="err">{t('item.notSaved')}</span>
				<button type="button" class="retry" onclick={() => void saver.retry()}>{t('item.retry')}</button>
			{/if}
		</span>
	</header>

	<main class="editor">
		<section class="stage" aria-label={t('item.stage')}>
			<RegionEditor
				src={data.imageUrl}
				alt={note || t('item.alt')}
				labels
				bind:regions={() => regions, (v) => ((regions = v), change('regions', v))}
				bind:active
			/>
			<p class="hint">
				{t('item.dragHint')}
				{#if safeSource}
					· <a href={safeSource} target="_blank" rel="noopener noreferrer">{sourceLabel}</a>
				{/if}
			</p>
		</section>

		<aside>
			<div class="body">
				{#if failure}<p class="banner" role="alert">{failure}</p>{/if}

				{#if dups.length}
					<div class="field">
						<span class="lbl">{t('dup.title')}</span>
						<p class="msg">{t('dup.body')}</p>
						<ul class="mini">
							{#each dups as d (d.id)}
								<li>
									<!-- A full load: this page keeps its editor state per page load (see `item`). -->
									<a href={`/i/${d.id}`} data-sveltekit-reload aria-label={d.note ? d.note.slice(0, 60) : t('item.alt')}>
										{#if dupUrls[d.image_path]}<img src={thumbUrl(dupUrls[d.image_path])} alt="" loading="lazy" decoding="async" />{/if}
									</a>
								</li>
							{/each}
						</ul>
					</div>
				{/if}

				{#if item.colors.length}
					<div class="field">
						<span class="lbl">{t('colors.title')}</span>
						<div class="swatches">
							{#each item.colors as c (c)}<span class="sw" style:background={c} title={c} role="img" aria-label={c}></span>{/each}
						</div>
					</div>
				{/if}

				<div class="field">
					<span class="lbl">{t('item.regions')}{regions.length ? ` · ${regions.length}` : ''}</span>
					<RegionList bind:regions={() => regions, (v) => ((regions = v), change('regions', v))} bind:active />
				</div>

				<label class="field">
					<span class="lbl">{t('item.imageNote')}</span>
					<textarea
						bind:value={() => note, (v) => ((note = v), change('note', v))}
						{@attach autogrow}
						rows="3"
						placeholder={t('item.notePlaceholder')}
					></textarea>
				</label>

				<div class="field">
					<label class="lbl" for="item-tags">Tags</label>
					<TagInput
						id="item-tags"
						bind:tags={() => tags, (v) => ((tags = v), change('tags', v))}
						suggestions={data.tags}
						placeholder={t('item.tagsPlaceholder')}
					/>
				</div>

				<div class="field">
					<span class="lbl" id="item-level">{t('common.level')}</span>
					<div class="chips" role="group" aria-labelledby="item-level">
						{#each levelStore.list as l (l.id)}
							<button type="button" class={['chip', level === l.id && 'on']} aria-pressed={level === l.id} onclick={() => setLevel(l.id)}>
								{l.name}
							</button>
						{/each}
					</div>
				</div>

				<SmartSuggest
					pb={data.pb}
					id={item.id}
					{tags}
					{level}
					onaddtag={addTag}
					onsetlevel={(l) => {
						level = l;
						change('level', l);
					}}
				/>

				<label class="field">
					<span class="lbl">Project</span>
					<select bind:value={() => projectId, (v) => ((projectId = v), change('project_id', v || null))}>
						<option value="">{t('common.noProject')}</option>
						{#each data.projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
					</select>
				</label>

				<SourceProjectField
					value={sourceProject}
					names={data.sourceProjects}
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

				<SimilarImages bind:this={similar} pb={data.pb} id={item.id} selectable bind:selected={picked} bind:selecting={picking} />
				{#if picking}
					<form class="bulk" onsubmit={applyBulk}>
						<p class="msg">{picked.length ? t('bulk.count', { n: picked.length }) : t('bulk.hint')}</p>
						{#if picked.length}
							<select bind:value={bulkProject} aria-label={t('bulk.moveTo')}>
								<option value="">{t('bulk.moveTo')}</option>
								{#each data.projects.filter((p) => !p.archived) as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
								<option value="-">{t('common.noProject')}</option>
							</select>
							<!-- type=text: the browser's URL check would refuse "pinterest.com/…"; cleanSource checks it. -->
							<input
								type="text"
								inputmode="url"
								bind:value={bulkSource}
								placeholder={`${t('bulk.source')}: https://…`}
								aria-label={t('bulk.source')}
								maxlength="2000"
							/>
							<button type="submit" class="btn primary" disabled={bulkBusy || (!bulkProject && !bulkSource.trim())}>
								{bulkBusy ? '…' : t('bulk.apply')}
							</button>
						{/if}
					</form>
				{/if}
				{#if bulkMsg}<p class="msg" role="status">{bulkMsg}</p>{/if}

				<div class="field">
					<button type="button" class="btn" onclick={() => (chatOpen = true)}>{t('chat.button')}</button>
				</div>
			</div>

			<footer>
				<span class="grow"></span>
				<button type="button" class="btn ghost danger" disabled={deleting} onclick={remove}>
					{deleting ? t('item.deleting') : t('common.delete')}
				</button>
			</footer>
		</aside>
	</main>
</div>

{#if chatOpen}
	<ChatSearch context={chatContext} onclose={() => (chatOpen = false)} />
{/if}

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

	.msg {
		margin: 0;
		font-size: 12.5px;
		color: var(--muted);
	}
	.bulk {
		display: grid;
		gap: 8px;
		padding: 10px 12px;
		background: var(--sunk);
		border: 1px solid var(--line);
		border-radius: var(--r-ctl);
	}
	.bulk input {
		width: 100%;
		border: 1px solid var(--line-strong);
		background: var(--raised);
		border-radius: var(--r-ctl);
		padding: 9px 11px;
		font-size: 14px;
		color: var(--text);
	}
	.bulk .btn {
		justify-self: start;
	}
	.swatches {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.sw {
		width: 28px;
		height: 28px;
		border-radius: 6px;
		border: 1px solid var(--line-strong);
	}
	.mini {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.mini a {
		display: block;
		width: 72px;
		height: 72px;
		overflow: hidden;
		border-radius: var(--r-ctl);
		background: var(--sunk);
	}
	.mini img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
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
