<script lang="ts">
	import { reloadData } from '#lib/reload.js';
	import { goto, preloadCode } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import type { Inspiration, Level } from '#lib/types.js';
	import { levelLabel, levelStore } from '#lib/levels.svelte.js';
	import LevelManager from '#lib/components/LevelManager.svelte';
	import LanguageSwitch from '#lib/components/LanguageSwitch.svelte';
	import AiSwitch from '#lib/components/AiSwitch.svelte';
	import EmbedSwitch from '#lib/components/EmbedSwitch.svelte';
	import ProjectSummary from '#lib/components/ProjectSummary.svelte';
	import { searchByMeaning, SmartSearchError } from '#lib/semantic.js';
	import { needSmart, smart } from '#lib/smart.svelte.js';
	import SourceProjectBar from '#lib/components/SourceProjectBar.svelte';
	import SourceProjectSuggestions from '#lib/components/SourceProjectSuggestions.svelte';
	import { groupBySourceProject, sourceProjectNames, suggestSourceProjects } from '#lib/sourceProjects.js';
	import { SvelteSet } from 'svelte/reactivity';
	import { t, tn, timeAgo } from '#lib/i18n.js';
	import {
		createProject as createProjectRow,
		deleteProject,
		renameProject,
		setProjectArchived,
		updateMany
	} from '#lib/inspirations.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const LAST_PROJECT_KEY = 'moodboard:last-project';
	const GROUP_KEY = 'moodboard:group-by-source-project';
	const DISMISSED_KEY = 'moodboard:dismissed-source-suggestions';

	let query = $state('');
	/** The search box looks for meaning instead of words (needs the smart search consent). */
	let byMeaning = $state(false);
	let meaningBusy = $state(false);
	let meaningError = $state('');
	/** The last meaning search: its text and the ids it found, best first. */
	let meaning = $state<{ q: string; ids: string[] } | null>(null);
	let level = $state<Level | ''>('');
	/** Images split into one section per source project; remembered per browser. */
	let grouped = $state(false);
	/** Select mode: pressing a card ticks it instead of opening it. */
	let selecting = $state(false);
	const picked = new SvelteSet<string>();
	let spBusy = $state(false);
	let spMessage = $state('');
	/** Pages whose suggestion the user dismissed; remembered per browser. */
	let dismissed = $state(new Set<string>());
	let newProject = $state('');
	let creating = $state(false);
	let projectError = $state('');
	let loggingOut = $state(false);
	let managingLevels = $state(false);
	let lastProjectId = $state<string | null>(null);
	/** Client clock; 0 until mounted, so relative times never mismatch on hydration. */
	let now = $state(0);
	let createInput: HTMLInputElement | undefined = $state();

	// Shallow navigations update `page.shallow.url`, not `page.url` (SvelteKit 3).
	const currentUrl = $derived(page.shallow?.url ?? page.url);
	const selected = $derived.by(() => {
		const p = currentUrl.searchParams.get('project');
		return p && p !== 'all' ? p : 'all';
	});

	interface Card {
		/** Project id, or `none` for the orphans. */
		key: string;
		name: string;
		images: Inspiration[];
		count: number;
		tags: string[];
		lastChange: string;
	}

	function topTags(images: Inspiration[], n = 3): string[] {
		const counts = new Map<string, number>();
		for (const i of images) {
			for (const t of i.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
		}
		return [...counts.entries()]
			.sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
			.slice(0, n)
			.map(([t]) => t);
	}

	function lastChangeOf(images: Inspiration[], fallback = ''): string {
		let max = fallback;
		for (const i of images) {
			const t = i.updated_at ?? i.created_at;
			if (t && t > max) max = t;
		}
		return max;
	}

	function relTime(iso: string, nowMs: number): string {
		if (!iso || nowMs <= 0) return '';
		const at = Date.parse(iso);
		if (!Number.isFinite(at)) return '';
		return timeAgo(new Date(Math.min(at, nowMs)), new Date(nowMs));
	}

	function remember(id: string) {
		if (id === 'all' || id === 'none') return;
		if (!data.projects.some((p) => p.id === id)) return;
		lastProjectId = id;
		try {
			localStorage.setItem(LAST_PROJECT_KEY, id);
		} catch {
			/* optional: private mode or no quota */
		}
	}

	function mapHref(key: string) {
		return key === 'none' ? '/map?project=none' : `/map?project=${encodeURIComponent(key)}`;
	}

	function gridHref(key: string) {
		return key === 'none' ? '/?project=none' : `/?project=${encodeURIComponent(key)}`;
	}

	const groups = $derived.by(() => {
		const g = new Map<string, Inspiration[]>();
		for (const i of data.inspirations) {
			const key = i.project_id ?? 'none';
			const list = g.get(key);
			if (list) list.push(i);
			else g.set(key, [i]);
		}
		return g;
	});

	const cards = $derived.by<Card[]>(() => {
		const out: Card[] = data.projects.filter((p) => !p.archived).map((p) => {
			const images = groups.get(p.id) ?? [];
			return {
				key: p.id,
				name: p.name,
				images,
				count: images.length,
				tags: topTags(images),
				lastChange: lastChangeOf(images, p.created_at ?? '')
			};
		});
		const orphans = groups.get('none') ?? [];
		if (orphans.length) {
			out.push({
				key: 'none',
				name: t('common.noProject'),
				images: orphans,
				count: orphans.length,
				tags: topTags(orphans),
				lastChange: lastChangeOf(orphans)
			});
		}
		return out;
	});

	/** The project the user opened last; the most recently changed one as fallback. */
	const resumeCard = $derived.by<Card | null>(() => {
		const real = cards.filter((c) => c.key !== 'none');
		if (!real.length) return null;
		const stored = lastProjectId ? real.find((c) => c.key === lastProjectId) : undefined;
		if (stored) return stored;
		let best = real[0];
		for (const c of real) if (c.lastChange > best.lastChange) best = c;
		return best;
	});

	const archivedCards = $derived.by<Card[]>(() =>
		data.projects
			.filter((p) => p.archived)
			.map((p) => {
				const images = groups.get(p.id) ?? [];
				return { key: p.id, name: p.name, images, count: images.length, tags: [], lastChange: '' };
			})
	);

	const gridCards = $derived(cards.filter((c) => c.key !== resumeCard?.key));

	const filtered = $derived.by(() => {
		if (byMeaning && meaning) {
			const byId = new Map(data.inspirations.map((i) => [i.id, i]));
			return meaning.ids.flatMap((id) => {
				const i = byId.get(id);
				// The ranking covers the whole library (or the project it was asked in); keep to the project shown now.
				const inSelected = selected === 'none' ? i?.project_id === null : selected === 'all' || i?.project_id === selected;
				return i && inSelected && (!level || i.level === level) ? [i] : [];
			});
		}
		const q = query.trim().toLowerCase();
		return data.inspirations.filter((i) => {
			if (selected === 'none' ? i.project_id !== null : selected !== 'all' && i.project_id !== selected) {
				return false;
			}
			if (level && i.level !== level) return false;
			if (q && !i.note.toLowerCase().includes(q) && !i.tags.some((t) => t.includes(q)) && !i.source_project?.toLowerCase().includes(q)) return false;
			return true;
		});
	});

	const sourceNames = $derived(sourceProjectNames(data.inspirations));
	const sections = $derived(
		grouped ? groupBySourceProject(filtered, { noneName: t('sp.none'), ranked: byMeaning && !!meaning }) : null
	);
	const suggestions = $derived(suggestSourceProjects(data.inspirations, dismissed));
	const imageById = $derived(new Map(data.inspirations.map((i) => [i.id, i])));

	function toggleGrouped() {
		grouped = !grouped;
		try {
			localStorage.setItem(GROUP_KEY, grouped ? '1' : '0');
		} catch {
			/* optional: private mode or no quota */
		}
	}

	function togglePicked(id: string) {
		if (picked.has(id)) picked.delete(id);
		else picked.add(id);
	}

	function toggleSelecting() {
		selecting = !selecting;
		picked.clear();
		spMessage = '';
	}

	/** Every id in `ids` is ticked: untick them, else tick them all. */
	function toggleMany(ids: string[]) {
		if (ids.every((id) => picked.has(id))) for (const id of ids) picked.delete(id);
		else for (const id of ids) picked.add(id);
	}

	function dismissSuggestion(key: string) {
		dismissed = new Set([...dismissed, key]);
		try {
			localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissed]));
		} catch {
			/* optional */
		}
	}

	/** Set (`name`) or clear (null) the source project of `ids`. Returns true when every image changed. */
	async function applySourceProject(ids: string[], name: string | null): Promise<boolean> {
		if (spBusy || !ids.length) return false;
		spBusy = true;
		spMessage = '';
		try {
			const out = await updateMany(data.pb, ids, { source_project: name });
			await reloadData();
			const images = tn('common.images', out.ok.length);
			spMessage = out.failed.length
				? t('sp.partial', { ok: out.ok.length, failed: out.failed.length })
				: name
					? t('sp.set', { name, images })
					: t('sp.cleared', { images });
			return out.failed.length === 0;
		} finally {
			spBusy = false;
		}
	}

	async function applyPicked(name: string | null) {
		if (await applySourceProject([...picked], name)) picked.clear();
	}

	const selectedName = $derived(
		selected === 'none'
			? t('common.noProject')
			: (data.projects.find((p) => p.id === selected)?.name ?? t('home.fallbackTitle'))
	);

	const selectedCard = $derived.by<Card | null>(() => {
		const p = data.projects.find((x) => x.id === selected);
		return p ? { key: p.id, name: p.name, images: [], count: 0, tags: [], lastChange: '' } : null;
	});

	const selectedProject = $derived(data.projects.find((p) => p.id === selected) ?? null);
	const aiAllowed = $derived(smart.embed || smart.ai);

	async function runMeaning() {
		const q = query.trim();
		if (!q || meaningBusy) return;
		// Asks for the consent right here when it is missing, instead of sending the user elsewhere.
		if (!(await needSmart('embed'))) {
			meaningError = t('search.meaningOff');
			return;
		}
		meaningBusy = true;
		meaningError = '';
		try {
			// A project page looks only inside that project; "no project" has no project to ask for.
			const scope = selected !== 'all' && selected !== 'none' ? selected : '';
			const out = await searchByMeaning(data.pb, q, scope);
			if (!out.enabled) {
				meaningError = t('search.meaningUnavailable');
				return;
			}
			let ids = out.results.map((h) => h.id);
			if (selected === 'none') {
				const orphans = new Set((groups.get('none') ?? []).map((i) => i.id));
				ids = ids.filter((id) => orphans.has(id));
			}
			meaning = { q, ids };
			if (!ids.length) meaningError = t('search.meaningNone');
		} catch (e) {
			meaningError = e instanceof SmartSearchError && e.kind === 'limit' ? t('search.meaningLimit') : t('search.meaningFailed');
		} finally {
			meaningBusy = false;
		}
	}

	function clearMeaning() {
		meaning = null;
		meaningError = '';
		query = '';
	}

	const orphanCount = $derived((groups.get('none') ?? []).length);

	// Visiting /?project=<id> counts as opening that project.
	$effect(() => {
		const id = selected;
		if (id !== 'all' && id !== 'none') remember(id);
	});

	onMount(() => {
		now = Date.now();
		// Most visits go on to the map: fetch its code while the browser is idle, so it opens at once.
		const idle = globalThis.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 1500));
		idle(() => void preloadCode('/map').catch(() => {}));
		try {
			grouped = localStorage.getItem(GROUP_KEY) === '1';
			const saved: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]');
			if (Array.isArray(saved)) dismissed = new Set(saved.filter((k): k is string => typeof k === 'string'));
		} catch {
			/* optional: private mode, or unreadable value */
		}
		if (selected !== 'all' && selected !== 'none') return;
		try {
			lastProjectId = localStorage.getItem(LAST_PROJECT_KEY);
		} catch {
			lastProjectId = null;
		}
	});

	async function createProject(e: SubmitEvent) {
		e.preventDefault();
		const name = newProject.trim();
		if (!name || creating) return;
		creating = true;
		projectError = '';
		try {
			const row = await createProjectRow(data.pb, data.user!.id, name);
			newProject = '';
			await reloadData();
			selectProject(row.id);
		} catch (err) {
			const message = err instanceof Error ? err.message : t('common.failed');
			projectError = /unique|υπάρχει|already/i.test(message)
				? t('home.projectExists')
				: message;
		} finally {
			creating = false;
		}
	}

	// ---------- rename, archive, delete ----------
	/** Project whose "⋯" menu is open. */
	let menuFor = $state<string | null>(null);
	/** Project being renamed, and the draft name. */
	let editing = $state<string | null>(null);
	let draft = $state('');
	/** Project waiting for the delete confirmation. */
	let confirming = $state<string | null>(null);
	let manageBusy = $state(false);
	let manageError = $state('');

	function closeManage() {
		menuFor = null;
		confirming = null;
	}

	function startRename(card: Card) {
		closeManage();
		manageError = '';
		draft = card.name;
		editing = card.key;
	}

	function focusSelect(el: HTMLInputElement) {
		el.focus();
		el.select();
	}

	async function commitRename(card: Card) {
		if (editing !== card.key || manageBusy) return;
		const name = draft.trim();
		if (!name || name === card.name) {
			editing = null;
			return;
		}
		manageBusy = true;
		try {
			await renameProject(data.pb, card.key, name);
			editing = null;
			await reloadData();
		} catch (err) {
			const message = err instanceof Error ? err.message : t('common.failed');
			manageError = /unique|υπάρχει|already/i.test(message)
				? t('home.projectExists')
				: message;
		} finally {
			manageBusy = false;
		}
	}

	async function manage(action: () => Promise<unknown>, after?: () => void) {
		if (manageBusy) return;
		manageBusy = true;
		manageError = '';
		try {
			await action();
			closeManage();
			after?.();
			await reloadData();
		} catch (err) {
			manageError = err instanceof Error ? err.message : t('common.failed');
		} finally {
			manageBusy = false;
		}
	}

	const archive = (card: Card, on: boolean) => manage(() => setProjectArchived(data.pb, card.key, on));
	const removeProject = (card: Card) =>
		manage(
			() => deleteProject(data.pb, card.key),
			() => {
				if (selected === card.key) selectProject('all');
			}
		);

	function selectProject(id: string) {
		const url = id === 'all' ? '/' : `/?project=${encodeURIComponent(id)}`;
		goto(url, { shallow: true, replace: true, reset: false });
	}

	function focusCreate() {
		if (!createInput) {
			void goto('/');
			return;
		}
		createInput.focus();
		createInput.scrollIntoView({ block: 'center' });
	}

	async function logout() {
		loggingOut = true;
		data.pb.authStore.clear();
		await goto('/login');
	}
</script>

<svelte:head>
	<title>Moodboard</title>
</svelte:head>

<header class="appbar">
	<a class="brand" href="/">
		<h1>Moodboard</h1>
		<span class="who">{data.user?.email ?? ''}</span>
	</a>
	<div class="actions">
		<a class="btn" href={selected === 'all' ? '/map' : `/map?project=${encodeURIComponent(selected)}`}>{t('common.map')}</a>
		<a class="btn" href="/sources">{t('common.sources')}</a>
		<button class="btn" type="button" onclick={() => (managingLevels = true)}>{t('common.levels')}</button>
		<a class="btn primary new-image" href="/new">{t('common.newImagePlus')}</a>
		<AiSwitch />
		<EmbedSwitch pb={data.pb} />
		<LanguageSwitch />
		<button class="btn" type="button" disabled={loggingOut} onclick={logout}>
			{loggingOut ? '…' : t('common.logout')}
		</button>
	</div>
</header>

<div class="page">
	{#if data.error}
		<p class="err">{t('home.loadError', { error: data.error })}</p>
	{/if}

	{#if selected === 'all'}
		<section class="projects">
			<div class="sec-head">
				<h2>Projects</h2>
				<span class="sec-meta">
					{tn('common.projects', data.projects.length)} · {tn('common.images', data.inspirations.length)}{#if orphanCount > 0}
						· {orphanCount} {t('home.noProjectCount')}{/if}
				</span>
			</div>

			{#if resumeCard}
				<article class="pcard resume">
					{@render collage(resumeCard.images)}
					<span class="resume-label">{t('home.resumeLabel')}</span>
					{@render projectMenu(resumeCard)}
					<div class="pmeta">
						<div class="headrow">
							{@render projectTitle(resumeCard)}
							<a
								class="btn primary cta"
								href={mapHref(resumeCard.key)}
								onclick={() => remember(resumeCard.key)}
							>
								{t('home.openMap')}
							</a>
						</div>
						<div class="prow">
							<span>
								{tn('common.images', resumeCard.count)}
								{#if relTime(resumeCard.lastChange, now)}· {relTime(resumeCard.lastChange, now)}{/if}
							</span>
						</div>
						{#if resumeCard.tags.length}
							<div class="chips">
								{#each resumeCard.tags as t (t)}<span class="chip">{t}</span>{/each}
							</div>
						{/if}
					</div>
					<a
						class="stretch"
						href={mapHref(resumeCard.key)}
						onclick={() => remember(resumeCard.key)}
						tabindex={-1}
						aria-hidden="true"
					></a>
				</article>
			{/if}

			<div class="pgrid">
				{#each gridCards as card (card.key)}
					{@render projectCard(card)}
				{/each}
				{@render newProjectCard()}
			</div>
			{#if manageError && !editing}<p class="err">{manageError}</p>{/if}
			{#if archivedCards.length}
				<details class="archive">
					<summary>{t('home.archive', { n: archivedCards.length })}</summary>
					<ul>
						{#each archivedCards as card (card.key)}
							<li>
								<span class="aname">{card.name}</span>
								<span class="ameta">{tn('common.images', card.count)}</span>
								{#if confirming === card.key}
									<span class="confirm">
										{t('home.confirmDeleteShort')}
										<button class="btn danger" type="button" disabled={manageBusy} onclick={() => removeProject(card)}>{t('common.yesDelete')}</button>
										<button class="btn ghost" type="button" onclick={() => (confirming = null)}>{t('common.cancel')}</button>
									</span>
								{:else}
									<button class="btn" type="button" disabled={manageBusy} onclick={() => archive(card, false)}>{t('common.restore')}</button>
									<button class="btn ghost" type="button" onclick={() => (confirming = card.key)}>{t('common.delete')}</button>
								{/if}
							</li>
						{/each}
					</ul>
				</details>
			{/if}
		</section>
	{:else}
		<section class="images">
			<a class="back" href="/">{t('home.allProjects')}</a>
			<div class="sec-head">
				{#if selectedCard && editing === selectedCard.key}
					{@render renameInput(selectedCard, 'h2')}
				{:else}
					<h2>{selectedName}</h2>
					{#if selectedCard}
						<button class="btn ghost edit" type="button" onclick={() => startRename(selectedCard)}>{t('common.rename')}</button>
					{/if}
				{/if}
				<span class="sec-meta">{tn('common.images', filtered.length)}</span>
				{#if manageError && selectedCard && editing === selectedCard.key}<span class="err">{manageError}</span>{/if}
			</div>
			{#if selectedProject}
				{#key selectedProject.id}
					<ProjectSummary
						pb={data.pb}
						projectId={selectedProject.id}
						description={selectedProject.description}
						{aiAllowed}
						onsaved={() => void reloadData()}
					/>
				{/key}
			{/if}
			{@render filters()}
			{@render imageGrid()}
		</section>
	{/if}

	{#if selected === 'all'}
		<section class="images">
			<div class="sec-head">
				<h2>{t('home.allImages')}</h2>
				{#if data.inspirations.length > 0}
					<span class="sec-meta">{t('home.countOf', { n: filtered.length, total: data.inspirations.length })}</span>
				{/if}
			</div>
			{#if !selecting}
				<SourceProjectSuggestions
					{suggestions}
					byId={imageById}
					urls={data.urls}
					names={sourceNames}
					busy={spBusy}
					onapply={(ids, name) => void applySourceProject(ids, name)}
					ondismiss={dismissSuggestion}
				/>
				{#if spMessage}<p class="mhint spmsg" role="status">{spMessage}</p>{/if}
			{/if}
			{@render filters()}
			{@render imageGrid()}
		</section>
	{/if}
</div>

{#snippet collage(images: Inspiration[])}
	<div class="collage" data-count={Math.min(images.length, 3)}>
		{#if images.length === 0}
			<span class="collage-none">{t('common.imageCollageNone')}</span>
		{:else}
			{#each images.slice(0, 3) as img, idx (img.id)}
				{#if data.urls[img.image_path]}
					<img
						class:cover={idx === 0}
						src={data.urls[img.image_path]}
						alt=""
						loading="lazy"
						decoding="async"
					/>
				{:else}
					<span class="ph-missing" class:cover={idx === 0}></span>
				{/if}
			{/each}
		{/if}
	</div>
{/snippet}

{#snippet projectCard(card: Card)}
	<article class="pcard">
		{@render collage(card.images)}
		{@render projectMenu(card)}
		<div class="pmeta">
			{@render projectTitle(card)}
			<div class="prow">
				<span>{tn('common.images', card.count)}</span>
				<span>{relTime(card.lastChange, now)}</span>
			</div>
			{#if card.tags.length}
				<div class="chips">
					{#each card.tags as t (t)}<span class="chip">{t}</span>{/each}
				</div>
			{/if}
			<div class="prow">
				<a class="sub" href={gridHref(card.key)}>{t('home.table')}</a>
			</div>
		</div>
		<a
			class="stretch"
			href={mapHref(card.key)}
			onclick={() => remember(card.key)}
			aria-label={t('home.openMapFor', { name: card.name })}
		></a>
	</article>
{/snippet}

{#snippet renameInput(card: Card, tag: 'h2' | 'h3')}
	<form
		class="rename"
		class:big={tag === 'h2'}
		onsubmit={(e) => {
			e.preventDefault();
			void commitRename(card);
		}}
	>
		<input
			bind:value={draft}
			{@attach focusSelect}
			maxlength="120"
			aria-label={t('home.projectName')}
			disabled={manageBusy}
			onkeydown={(e) => e.key === 'Escape' && (editing = null)}
			onblur={() => void commitRename(card)}
		/>
	</form>
{/snippet}

{#snippet projectTitle(card: Card)}
	{#if editing === card.key}
		{@render renameInput(card, 'h3')}
		{#if manageError}<p class="err rename-err">{manageError}</p>{/if}
	{:else}
		<h3>{card.name}</h3>
	{/if}
{/snippet}

{#snippet projectMenu(card: Card)}
	<div class="pmenu">
		<button
			type="button"
			class="dots"
			aria-label={t('home.options', { name: card.name })}
			aria-haspopup="true"
			aria-expanded={menuFor === card.key}
			onclick={() => {
				confirming = null;
				manageError = '';
				menuFor = menuFor === card.key ? null : card.key;
			}}>⋯</button
		>
		{#if menuFor === card.key}
			<div class="scrim" role="presentation" onpointerdown={closeManage}></div>
			<div class="mpop" role="menu" aria-label={card.name}>
				{#if confirming === card.key}
					<p class="mwarn">{t('home.confirmDelete', { name: card.name })}</p>
					<button type="button" class="mi danger" disabled={manageBusy} onclick={() => removeProject(card)}>{t('common.yesDelete')}</button>
					<button type="button" class="mi" onclick={() => (confirming = null)}>{t('common.cancel')}</button>
				{:else}
					<button type="button" role="menuitem" class="mi" onclick={() => startRename(card)}>{t('common.rename')}</button>
					<button type="button" role="menuitem" class="mi" disabled={manageBusy} onclick={() => archive(card, true)}>{t('common.archive')}</button>
					<button type="button" role="menuitem" class="mi danger" onclick={() => (confirming = card.key)}>{t('common.deleteEllipsis')}</button>
				{/if}
				{#if manageError}<p class="err">{manageError}</p>{/if}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet newProjectCard()}
	<article class="pcard new">
		<form onsubmit={createProject}>
			<label class="np-label" for="new-project-name">{t('common.newProjectPlus')}</label>
			<div class="np-row">
				<input
					id="new-project-name"
					bind:this={createInput}
					bind:value={newProject}
					placeholder={t('home.newProjectName')}
					maxlength="120"
				/>
				<button class="btn" type="submit" disabled={creating}>{creating ? '…' : t('common.create')}</button>
			</div>
			{#if projectError}<p class="err">{projectError}</p>{/if}
		</form>
	</article>
{/snippet}

{#snippet filters()}
	<div class="filters">
		<input
			type="search"
			placeholder={byMeaning ? t('search.meaningPlaceholder') : t('home.searchPlaceholder')}
			bind:value={query}
			aria-label={t('home.search')}
			onkeydown={(e) => {
				if (byMeaning && e.key === 'Enter') {
					e.preventDefault();
					void runMeaning();
				}
			}}
		/>
		<button
			type="button"
			class={['chip', byMeaning && 'on']}
			aria-pressed={byMeaning}
			title={t('search.meaningTitle')}
			onclick={async () => {
				meaningError = '';
				if (!byMeaning && !(await needSmart('embed'))) return;
				byMeaning = !byMeaning;
				if (!byMeaning) meaning = null;
			}}
		>
			⌕ {t('search.meaning')}
		</button>
		<button
			type="button"
			class={['chip', grouped && 'on']}
			aria-pressed={grouped}
			title={t('sp.groupTitle')}
			onclick={toggleGrouped}
		>
			{t('sp.group')}
		</button>
		{#if data.inspirations.length}
			<button type="button" class={['chip', selecting && 'on']} aria-pressed={selecting} onclick={toggleSelecting}>
				{selecting ? t('bulk.done') : t('bulk.select')}
			</button>
		{/if}
		<select bind:value={level} aria-label={t('common.level')}>
			<option value="">{t('home.allLevels')}</option>
			{#each levelStore.list as l (l.id)}<option value={l.id}>{l.name}</option>{/each}
		</select>
	</div>
	{#if byMeaning}
		<p class="mhint" aria-live="polite">
			{#if meaningBusy}
				{t('search.meaningBusy')}
			{:else if meaningError}
				<span class="err">{meaningError}</span>
			{:else if meaning}
				{t('search.meaningResults', { q: meaning.q })}
				<button type="button" class="clear" onclick={clearMeaning}>{t('search.meaningClear')}</button>
			{:else}
				{t('search.meaningTitle')}
			{/if}
		</p>
	{/if}
{/snippet}

{#snippet imageGrid()}
	{#if data.inspirations.length === 0}
		<div class="empty-state">
			<p class="empty-title">{t('home.emptyTitle')}</p>
			<p class="empty-body">{t('home.emptyBody')}</p>
			<div class="empty-actions">
				<button class="btn" type="button" onclick={focusCreate}>{t('common.newProjectPlus')}</button>
				<a class="btn primary" href="/new">{t('common.newImagePlus')}</a>
			</div>
		</div>
	{:else if filtered.length === 0}
		<p class="empty">
			{t('home.noMatch')}
			<a href="/new">{t('home.addImage')}</a>
		</p>
	{:else if sections}
		<div class="psecs">
			{#each sections as sec (sec.key)}
				{@const ids = sec.items.map((i) => i.id)}
				<section class="psec">
					<h3 class="psec-head">
						<span class={['psec-name', !sec.key && 'none']}>{sec.name}</span>
						<span class="sec-meta">{tn('common.images', sec.items.length)}</span>
						{#if selecting}
							<button type="button" class="btn ghost" onclick={() => toggleMany(ids)}>
								{ids.every((id) => picked.has(id)) ? t('sp.bar.sectionNone') : t('sp.bar.sectionAll')}
							</button>
						{/if}
					</h3>
					<div class="grid">
						{#each sec.items as item (item.id)}{@render imageCard(item)}{/each}
					</div>
				</section>
			{/each}
		</div>
	{:else}
		<div class="grid">
			{#each filtered as item (item.id)}{@render imageCard(item)}{/each}
		</div>
	{/if}
{/snippet}

{#snippet cardBody(item: Inspiration)}
	<div class="thumb">
		{#if data.urls[item.image_path]}
			<img src={data.urls[item.image_path]} alt="" loading="lazy" decoding="async" />
		{:else}
			<span class="missing">{t('common.noImage')}</span>
		{/if}
		{#if levelLabel(item.level)}
			<span class="badge">{levelLabel(item.level)}</span>
		{/if}
		{#if selecting}
			<span class="tick" aria-hidden="true">{picked.has(item.id) ? '✓' : ''}</span>
		{/if}
	</div>
	<div class="body">
		{#if item.note}
			<p class="note">{item.note.length > 140 ? `${item.note.slice(0, 140).trimEnd()}…` : item.note}</p>
		{/if}
		{#if item.source_project && !sections}
			<p class="sp">{t('sp.on', { name: item.source_project })}</p>
		{/if}
		{#if item.tags.length}
			<p class="tags">{item.tags.slice(0, 4).join(' · ')}</p>
		{/if}
	</div>
{/snippet}

{#snippet imageCard(item: Inspiration)}
	{#if selecting}
		<button
			type="button"
			class={['card', 'pick', picked.has(item.id) && 'picked']}
			role="checkbox"
			aria-checked={picked.has(item.id)}
			aria-label={`${t('bulk.check')}: ${item.note ? item.note.slice(0, 60) : t('item.alt')}`}
			onclick={() => togglePicked(item.id)}
		>
			{@render cardBody(item)}
		</button>
	{:else}
		<a class="card" href={`/i/${item.id}`}>{@render cardBody(item)}</a>
	{/if}
{/snippet}

<a class="fab" href="/new" aria-label={t('common.newImage')}>+</a>

{#if selecting}
	<SourceProjectBar
		count={picked.size}
		names={sourceNames}
		busy={spBusy}
		message={spMessage}
		onset={(name) => void applyPicked(name)}
		onclear={() => void applyPicked(null)}
		onall={() => {
			for (const i of filtered) picked.add(i.id);
		}}
		onnone={() => picked.clear()}
		ondone={toggleSelecting}
	/>
{/if}

{#if managingLevels && data.user}
	<LevelManager pb={data.pb} userId={data.user.id} onclose={() => {
			managingLevels = false;
			if (level && !levelLabel(level)) level = '';
		}} />
{/if}

<style>
	.appbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 12px;
		min-height: 56px;
		padding: 10px 20px;
		border-bottom: 1px solid var(--line);
		background: var(--surface);
	}
	.brand {
		display: flex;
		align-items: baseline;
		gap: 12px;
		min-width: 0;
		text-decoration: none;
	}
	h1 {
		font-family: var(--font-serif);
		font-size: 1.15rem;
		font-weight: 600;
		margin: 0;
		letter-spacing: -0.01em;
	}
	.who {
		color: var(--muted);
		font-size: 0.8rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 34vw;
	}
	.actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
	.actions .btn { font-size: 0.85rem; }
	.actions .btn:disabled { opacity: 0.6; cursor: default; }

	.page { max-width: 1280px; margin: 0 auto; padding: 24px 16px 72px; }
	.sec-head {
		display: flex;
		align-items: baseline;
		gap: 12px;
		flex-wrap: wrap;
		margin: 0 0 16px;
	}
	h2 { font-size: 1.05rem; font-weight: 600; margin: 0; }
	.sec-meta { color: var(--muted); font-size: 0.8rem; }
	.err { color: var(--accent); font-size: 0.8rem; margin: 0; }
	.back {
		display: inline-block;
		color: var(--muted);
		font-size: 0.85rem;
		text-decoration: none;
		margin-bottom: 10px;
	}
	.back:hover { color: var(--text); }

	.projects { margin-bottom: 36px; }
	.pgrid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 16px;
	}

	.pcard {
		position: relative;
		display: flex;
		flex-direction: column;
		min-width: 0;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--r-panel);
		overflow: hidden;
		text-decoration: none;
	}
	.pcard:hover { border-color: var(--line-strong); box-shadow: var(--shadow); }
	.pcard.resume {
		margin-bottom: 18px;
		border-color: var(--line-strong);
	}
	.stretch { position: absolute; inset: 0; z-index: 1; border-radius: inherit; }
	.stretch:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
	.resume-label {
		position: absolute;
		left: 12px;
		top: 12px;
		z-index: 2;
		pointer-events: none;
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.07em;
		color: var(--accent);
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--r-pill);
		padding: 4px 10px;
	}

	.collage {
		display: grid;
		gap: 3px;
		height: 180px;
		background: var(--sunk);
	}
	.collage[data-count='1'] { grid-template-columns: 1fr; }
	.collage[data-count='2'] {
		grid-template-columns: 2fr 1fr;
		grid-template-rows: minmax(0, 1fr);
	}
	.collage[data-count='2'] img,
	.collage[data-count='2'] .ph-missing { grid-row: span 1; }
	.collage[data-count='3'] {
		grid-template-columns: 2fr 1fr;
		grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
	}
	.collage[data-count='3'] .cover { grid-row: span 2; }
	.collage[data-count='0'] {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--muted);
		font-size: 0.8rem;
	}
	.collage img { width: 100%; height: 100%; min-width: 0; min-height: 0; object-fit: cover; display: block; }
	.ph-missing { display: block; width: 100%; height: 100%; min-height: 0; background: var(--surface); }
	.pcard.resume .collage { height: 260px; }
	/* The resume card is wide: three equal tiles, so no small source image is stretched into a blur. */
	.pcard.resume .collage[data-count='3'] {
		grid-template-columns: repeat(3, minmax(0, 1fr));
		grid-template-rows: minmax(0, 1fr);
	}
	.pcard.resume .collage[data-count='3'] .cover { grid-row: auto; }
	.pcard.resume .collage[data-count='2'] { grid-template-columns: repeat(2, minmax(0, 1fr)); }

	.pmeta { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px 14px; }
	.headrow {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}
	.pmeta h3 {
		font-family: var(--font-serif);
		font-size: 1.05rem;
		font-weight: 600;
		margin: 0;
		overflow-wrap: anywhere;
	}
	.prow {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		color: var(--muted);
		font-size: 0.78rem;
	}
	.sub {
		position: relative;
		z-index: 2;
		color: var(--muted);
		font-size: 0.78rem;
		text-decoration: none;
	}
	.sub:hover { color: var(--accent); }
	.cta { position: relative; z-index: 2; align-self: flex-start; font-size: 0.85rem; }

	.pcard.new { border-style: dashed; background: none; }
	.pcard.new form { display: flex; flex-direction: column; gap: 10px; padding: 18px 16px; }
	.np-label {
		font-family: var(--font-serif);
		font-size: 1.05rem;
		color: var(--text);
		cursor: pointer;
	}
	.np-row { display: flex; gap: 6px; }
	.np-row input { flex: 1; min-width: 0; }

	.filters { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
	.filters input[type='search'] { flex: 1 1 220px; min-width: 0; }
	.mhint { margin: -6px 0 12px; font-size: 0.82rem; color: var(--muted); }
	.mhint .err { color: var(--accent); }
	.mhint .clear { border: 0; background: none; padding: 0 4px; text-decoration: underline; text-underline-offset: 3px; font-size: inherit; color: var(--text); }
	.filters select { flex: 0 1 auto; max-width: 100%; }
	.empty { color: var(--muted); padding: 32px 0; }
	.empty a { color: var(--accent); margin-left: 4px; }

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 8px;
		max-width: 520px;
		padding: 28px 24px;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--r-panel);
	}
	.empty-title { font-family: var(--font-serif); font-size: 1.1rem; margin: 0; }
	.empty-body { color: var(--muted); font-size: 0.9rem; margin: 0; }
	.empty-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }

	.grid {
		columns: 1;
		column-gap: 16px;
	}
	@media (min-width: 560px) { .grid { columns: 2; } }
	@media (min-width: 900px) { .grid { columns: 3; } }
	@media (min-width: 1300px) { .grid { columns: 4; } }

	.card {
		display: block;
		break-inside: avoid;
		margin: 0 0 16px;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		overflow: hidden;
		text-decoration: none;
		transition: transform 0.12s ease, box-shadow 0.12s ease;
	}
	.card:hover { transform: translateY(-2px); box-shadow: 0 6px 18px rgba(0, 0, 0, 0.07); }
	.thumb { position: relative; background: var(--bg); }
	.thumb img { display: block; width: 100%; height: auto; }
	.missing { display: block; padding: 40px 12px; text-align: center; color: var(--muted); font-size: 0.8rem; }
	.badge {
		position: absolute;
		top: 8px;
		left: 8px;
		background: rgba(0, 0, 0, 0.6);
		color: #fff;
		font-size: 0.7rem;
		padding: 2px 8px;
		border-radius: 999px;
		backdrop-filter: blur(4px);
	}
	.body { padding: 10px 12px 12px; }
	.sp { margin: 6px 0 0; font-size: 0.76rem; color: var(--accent); overflow-wrap: anywhere; }
	.spmsg { margin: 0 0 12px; }
	button.card { width: 100%; padding: 0; text-align: left; font: inherit; color: inherit; cursor: pointer; }
	.card.picked { outline: 2px solid var(--accent); outline-offset: -2px; }
	.tick {
		position: absolute;
		top: 8px;
		right: 8px;
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		border-radius: 999px;
		background: var(--raised);
		box-shadow: 0 0 0 1px var(--line-strong);
		font-size: 14px;
		line-height: 1;
	}
	.card.picked .tick { background: var(--accent); color: #fff; box-shadow: none; }
	.psec { margin-bottom: 12px; }
	.psec-head {
		display: flex;
		align-items: baseline;
		gap: 10px;
		flex-wrap: wrap;
		margin: 8px 0 12px;
		padding-top: 12px;
		border-top: 1px solid var(--line);
		font-family: var(--font-serif);
		font-size: 1.05rem;
		font-weight: 600;
	}
	.psec:first-child .psec-head { border-top: 0; padding-top: 0; margin-top: 0; }
	.psec-name { overflow-wrap: anywhere; min-width: 0; }
	.psec-name.none { color: var(--muted); }
	.psec-head .sec-meta { font-family: var(--font-sans); font-weight: 400; }
	.psec-head .btn { font-family: var(--font-sans); font-size: 0.8rem; font-weight: 400; }
	.note { margin: 0; font-size: 0.88rem; line-height: 1.45; white-space: pre-line; }
	.tags { margin: 6px 0 0; color: var(--muted); font-size: 0.76rem; }

	.pmenu { position: absolute; top: 8px; right: 8px; z-index: 3; }
	.dots {
		width: 32px;
		height: 32px;
		padding: 0;
		display: grid;
		place-items: center;
		font-size: 18px;
		line-height: 1;
		background: var(--surface);
		opacity: 0.92;
	}
	.dots:hover { border-color: var(--muted); }
	.pcard.resume .pmenu { left: auto; }
	.scrim { position: fixed; inset: 0; z-index: 4; }
	.mpop {
		position: absolute;
		top: 38px;
		right: 0;
		z-index: 5;
		min-width: 190px;
		max-width: 260px;
		display: flex;
		flex-direction: column;
		padding: 5px;
		background: var(--raised);
		border-radius: 10px;
		box-shadow: 0 12px 32px -12px rgb(0 0 0 / 0.3), 0 0 0 1px var(--line);
	}
	.mi {
		border: 0;
		background: none;
		text-align: left;
		padding: 8px 10px;
		min-height: 36px;
		font-size: 0.85rem;
		border-radius: 6px;
	}
	.mi:hover:not(:disabled) { background: var(--sunk); }
	.mi.danger { color: var(--accent); }
	.mwarn { margin: 6px 10px 8px; font-size: 0.8rem; line-height: 1.4; color: var(--muted); }
	.rename { display: flex; flex: 1; min-width: 0; position: relative; z-index: 3; }
	.rename input { width: 100%; font-family: var(--font-serif); font-size: 1.05rem; font-weight: 600; }
	.rename.big input { font-size: 1.05rem; max-width: 420px; }
	.rename-err { flex-basis: 100%; }
	.edit { font-size: 0.8rem; }

	.archive { margin-top: 20px; color: var(--muted); font-size: 0.85rem; }
	.archive summary { cursor: pointer; padding: 6px 0; }
	.archive ul { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
	.archive li {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		padding: 8px 12px;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--r-ctl);
	}
	.aname { font-family: var(--font-serif); color: var(--text); font-size: 0.95rem; flex: 1; min-width: 120px; overflow-wrap: anywhere; }
	.confirm { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }

	.fab { display: none; }

	@media (max-width: 560px) {
		.appbar { padding: 10px 12px; }
		.who { display: none; }
		.actions { gap: 6px; margin-left: auto; }
		.new-image { display: none; }
		.page { padding: 16px 12px 96px; }
		.pgrid { grid-template-columns: 1fr; }
		.pcard .collage { height: 130px; }
		.pcard.resume .collage { height: 170px; }
		.pmeta { padding: 10px 12px 12px; }
		.fab {
			display: grid;
			place-items: center;
			position: fixed;
			right: 18px;
			bottom: 22px;
			z-index: 7;
			width: 56px;
			height: 56px;
			border-radius: var(--r-pill);
			background: var(--accent);
			color: var(--on-accent);
			text-decoration: none;
			font-size: 28px;
			line-height: 1;
			box-shadow: var(--shadow);
		}
	}
</style>
