<script lang="ts">
	// «Πηγές»: every website images were saved from, with its images, pages and projects.
	import { SvelteSet } from 'svelte/reactivity';
	import type { Inspiration } from '#lib/types.js';
	import { filterItems, groupSources, type Source, type SourceSort } from '#lib/sources.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let query = $state('');
	/** '' = every project, 'none' = without a project, else a project id. */
	let project = $state('');
	let tag = $state<string | null>(null);
	let sort = $state<SourceSort>('count');
	const open = new SvelteSet<string>();
	/** Sites whose favicon failed: they show a letter instead. */
	const noIcon = new SvelteSet<string>();

	const STRIP = 12;

	const projectName = $derived(new Map(data.projects.map((p) => [p.id, p.name])));

	const filtered = $derived(
		filterItems(data.inspirations, {
			query,
			project: project === '' ? undefined : project === 'none' ? null : project,
			tag
		})
	);
	const grouped = $derived(groupSources(filtered, sort));
	const allSites = $derived(groupSources(data.inspirations).sources.length);

	/** The most used tags of the images that have a source, for one-click filters. */
	const topTags = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const s of groupSources(data.inspirations).sources)
			for (const i of s.items) for (const t of i.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
		return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([t]) => t);
	});

	const filtering = $derived(!!query.trim() || project !== '' || tag !== null);

	function toggle(host: string) {
		if (open.has(host)) open.delete(host);
		else open.add(host);
	}

	function clear() {
		query = '';
		project = '';
		tag = null;
	}

	const dateFmt = new Intl.DateTimeFormat('el-GR', { day: 'numeric', month: 'short' });
	const when = (iso: string) => {
		const d = new Date(iso.replace(' ', 'T'));
		return Number.isNaN(d.getTime()) ? '' : dateFmt.format(d);
	};

	const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

	/** A page's label: its title, else its path. */
	function pageLabel(url: string, title: string | null): string {
		if (title?.trim()) return title.trim();
		try {
			const u = new URL(url);
			return decodeURIComponent(u.pathname + u.search) || u.hostname;
		} catch {
			return url;
		}
	}

	const projectHref = (id: string | null) => `/map?project=${id ?? 'none'}`;
</script>

<svelte:head>
	<title>Πηγές · Moodboard</title>
</svelte:head>

{#snippet strip(items: Inspiration[], limit: number)}
	<ul class="strip">
		{#each items.slice(0, limit) as item (item.id)}
			<li>
				<a href={`/i/${item.id}`} title={item.note || item.source_title || 'Εικόνα'}>
					{#if data.urls[item.image_path]}
						<img src={data.urls[item.image_path]} alt={item.note || ''} loading="lazy" decoding="async" />
					{:else}
						<span class="missing" aria-hidden="true"></span>
					{/if}
				</a>
			</li>
		{/each}
		{#if items.length > limit}
			<li class="more" aria-label={`και άλλες ${items.length - limit}`}>+{items.length - limit}</li>
		{/if}
	</ul>
{/snippet}

{#snippet favicon(host: string)}
	{#if noIcon.has(host)}
		<span class="icon letter" aria-hidden="true">{host[0]?.toUpperCase()}</span>
	{:else}
		<img
			class="icon"
			src={`https://${host}/favicon.ico`}
			alt=""
			width="32"
			height="32"
			loading="lazy"
			referrerpolicy="no-referrer"
			onerror={() => noIcon.add(host)}
		/>
	{/if}
{/snippet}

<header class="appbar">
	<nav class="crumb" aria-label="Διαδρομή">
		<a class="home" href="/">Moodboard</a>
		<span aria-hidden="true">›</span>
		<h1>Πηγές</h1>
	</nav>
	<div class="actions">
		<a class="btn" href="/map">Χάρτης</a>
		<a class="btn" href="/">Projects</a>
	</div>
</header>

<main class="page">
	{#if data.error}
		<p class="err">Σφάλμα φόρτωσης: {data.error}</p>
	{/if}

	<div class="intro">
		<p class="lead">
			Οι ιστότοποι από όπου κράτησες εικόνες.
			<span class="meta">{plural(allSites, 'ιστότοπος', 'ιστότοποι')} · {plural(data.inspirations.length, 'εικόνα', 'εικόνες')}</span>
		</p>
	</div>

	<div class="toolbar">
		<input
			class="search"
			type="search"
			bind:value={query}
			placeholder="Αναζήτηση: ιστότοπος, τίτλος, σημείωση, tag…"
			aria-label="Αναζήτηση"
		/>
		<select bind:value={project} aria-label="Project">
			<option value="">Όλα τα projects</option>
			{#each data.projects as p (p.id)}
				<option value={p.id}>{p.name}</option>
			{/each}
			<option value="none">Χωρίς project</option>
		</select>
		<div class="seg" role="group" aria-label="Ταξινόμηση">
			<button type="button" class:on={sort === 'count'} aria-pressed={sort === 'count'} onclick={() => (sort = 'count')}>Περισσότερες</button>
			<button type="button" class:on={sort === 'recent'} aria-pressed={sort === 'recent'} onclick={() => (sort = 'recent')}>Πρόσφατες</button>
		</div>
	</div>

	{#if topTags.length}
		<div class="tags" role="group" aria-label="Φίλτρο tag">
			{#each topTags as t (t)}
				<button type="button" class="chip" class:on={tag === t} aria-pressed={tag === t} onclick={() => (tag = tag === t ? null : t)}>#{t}</button>
			{/each}
		</div>
	{/if}

	{#if filtering}
		<p class="found">
			{plural(grouped.sources.length, 'ιστότοπος', 'ιστότοποι')} ·
			{plural(grouped.sources.reduce((n, s) => n + s.items.length, 0), 'εικόνα', 'εικόνες')}
			<button type="button" class="btn ghost" onclick={clear}>Καθαρισμός</button>
		</p>
	{/if}

	{#if allSites === 0}
		<div class="empty">
			<p>Δεν υπάρχουν ακόμα πηγές.</p>
			<p class="muted">
				Όταν αποθηκεύεις μια εικόνα με την επέκταση, κρατάμε και τη σελίδα από όπου ήρθε. Θα τη βρεις εδώ.
			</p>
		</div>
	{:else if !grouped.sources.length}
		<div class="empty"><p>Καμία πηγή δεν ταιριάζει.</p></div>
	{/if}

	<ol class="sources">
		{#each grouped.sources as s (s.host)}
			{@const expanded = open.has(s.host)}
			<li class="source">
				<div class="head">
					{@render favicon(s.host)}
					<div class="title">
						<h2>
							<a href={`https://${s.host}`} target="_blank" rel="noopener noreferrer">{s.host}<svg class="ext" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.5h7v7M12.5 3.5l-9 9" /></svg></a>
						</h2>
						<p class="meta">
							{plural(s.items.length, 'εικόνα', 'εικόνες')} · {plural(s.pages.length, 'σελίδα', 'σελίδες')}
							{#if s.last}· τελευταία {when(s.last)}{/if}
						</p>
					</div>
					<ul class="projects" aria-label="Projects">
						{#each s.projects.slice(0, 4) as p (p.id ?? 'none')}
							<li>
								<a class="pill" href={projectHref(p.id)} class:none={!p.id}>
									{p.id ? (projectName.get(p.id) ?? '—') : 'Χωρίς project'}
									<span class="n">{p.count}</span>
								</a>
							</li>
						{/each}
						{#if s.projects.length > 4}<li class="pill more">+{s.projects.length - 4}</li>{/if}
					</ul>
				</div>

				{@render strip(s.items, STRIP)}

				<button type="button" class="pages-toggle" aria-expanded={expanded} onclick={() => toggle(s.host)}>
					<svg viewBox="0 0 16 16" aria-hidden="true" class:rot={expanded}><path d="M6 3l5 5-5 5" /></svg>
					{expanded ? 'Απόκρυψη σελίδων' : `Σελίδες (${s.pages.length})`}
				</button>

				{#if expanded}
					<ul class="pages">
						{#each s.pages as pg (pg.url)}
							<li>
								<div class="page-head">
									<a href={pg.url} target="_blank" rel="noopener noreferrer" title={pg.url}>{pageLabel(pg.url, pg.title)}</a>
									<span class="n">{pg.items.length}</span>
								</div>
								{@render strip(pg.items, 8)}
							</li>
						{/each}
					</ul>
				{/if}
			</li>
		{/each}
	</ol>

	{#if grouped.unsourced.length}
		<section class="unsourced">
			<h2>Χωρίς πηγή <span class="n">{grouped.unsourced.length}</span></h2>
			<p class="muted">Εικόνες από τον υπολογιστή, επικόλληση ή στιγμιότυπο.</p>
			{@render strip(grouped.unsourced, STRIP)}
		</section>
	{/if}
</main>

<style>
	.appbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-height: 56px;
		padding: 10px 20px;
		border-bottom: 1px solid var(--line);
		background: var(--surface);
	}
	.crumb {
		display: flex;
		align-items: baseline;
		gap: 10px;
		min-width: 0;
		color: var(--faint);
	}
	.crumb .home {
		color: var(--muted);
		text-decoration: none;
		font-size: 14px;
	}
	.crumb .home:hover {
		color: var(--text);
	}
	h1 {
		margin: 0;
		font-size: 1.15rem;
		font-weight: 600;
		color: var(--text);
		letter-spacing: -0.01em;
	}
	.actions {
		display: flex;
		gap: 8px;
	}
	.actions .btn {
		font-size: 0.85rem;
	}

	.page {
		max-width: 1080px;
		margin: 0 auto;
		padding: 24px 20px 80px;
	}
	.lead {
		margin: 0 0 16px;
		color: var(--muted);
	}
	.lead .meta {
		color: var(--faint);
		margin-left: 6px;
		white-space: nowrap;
	}

	.toolbar {
		position: sticky;
		top: 0;
		z-index: 2;
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
		padding: 10px 0;
		background: var(--bg);
	}
	.search {
		flex: 1 1 280px;
		min-width: 0;
		min-height: 36px;
	}
	select {
		min-height: 36px;
		max-width: 220px;
	}
	.tags {
		display: flex;
		gap: 6px;
		overflow-x: auto;
		padding: 2px 0 10px;
		scrollbar-width: thin;
	}
	.tags .chip {
		flex: none;
	}
	.found {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 4px 0 8px;
		font-size: 13px;
		color: var(--muted);
	}
	.found .btn {
		font-size: 13px;
	}

	.sources {
		list-style: none;
		margin: 8px 0 0;
		padding: 0;
		display: grid;
		gap: 12px;
	}
	.source {
		background: var(--raised);
		border: 1px solid var(--line);
		border-radius: var(--r-panel);
		padding: 16px;
	}
	.head {
		display: grid;
		grid-template-columns: 32px minmax(0, 1fr) auto;
		gap: 12px;
		align-items: center;
	}
	.icon {
		width: 32px;
		height: 32px;
		border-radius: var(--r-ctl);
		object-fit: contain;
		background: var(--sunk);
	}
	.icon.letter {
		display: grid;
		place-items: center;
		font-family: var(--font-serif);
		font-weight: 600;
		color: var(--muted);
	}
	.title {
		min-width: 0;
	}
	h2 {
		margin: 0;
		font-size: 16px;
		font-family: inherit;
		font-weight: 600;
	}
	h2 a {
		color: var(--text);
		text-decoration: none;
		overflow-wrap: anywhere;
	}
	h2 a:hover {
		text-decoration: underline;
	}
	.ext {
		width: 12px;
		height: 12px;
		margin-left: 5px;
		vertical-align: -1px;
		fill: none;
		stroke: var(--faint);
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.meta {
		margin: 2px 0 0;
		font-size: 12.5px;
		color: var(--muted);
	}
	.projects {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 6px;
		max-width: 360px;
	}
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 28px;
		padding: 2px 10px;
		border-radius: var(--r-pill);
		border: 1px solid var(--line);
		font-size: 12.5px;
		color: var(--text);
		text-decoration: none;
		white-space: nowrap;
	}
	a.pill:hover {
		border-color: var(--muted);
	}
	.pill.none {
		border-style: dashed;
		color: var(--muted);
	}
	.pill.more {
		color: var(--muted);
	}
	.n {
		font-size: 12px;
		color: var(--faint);
		font-variant-numeric: tabular-nums;
	}

	.strip {
		list-style: none;
		margin: 12px 0 0;
		padding: 0 0 4px;
		display: flex;
		gap: 6px;
		overflow-x: auto;
		scrollbar-width: thin;
	}
	.strip li {
		flex: none;
	}
	.strip a {
		display: block;
		border-radius: var(--r-img);
		overflow: hidden;
		background: var(--sunk);
		transition: transform 150ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.strip a:hover {
		transform: translateY(-2px);
	}
	.strip img,
	.strip .missing {
		display: block;
		height: 96px;
		width: auto;
		max-width: 200px;
		min-width: 64px;
		object-fit: cover;
	}
	.strip .missing {
		width: 96px;
	}
	.strip .more {
		display: grid;
		place-items: center;
		height: 96px;
		min-width: 64px;
		padding: 0 12px;
		border-radius: var(--r-img);
		background: var(--sunk);
		color: var(--muted);
		font-size: 13px;
	}

	.pages-toggle {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-top: 10px;
		min-height: 32px;
		padding: 0 8px 0 4px;
		border: 0;
		background: none;
		color: var(--muted);
		font-size: 13px;
	}
	.pages-toggle:hover {
		color: var(--text);
	}
	.pages-toggle svg {
		width: 14px;
		height: 14px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
		transition: transform 150ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.pages-toggle svg.rot {
		transform: rotate(90deg);
	}
	.pages {
		list-style: none;
		margin: 4px 0 0;
		padding: 0 0 0 12px;
		border-left: 1px solid var(--line);
		display: grid;
		gap: 14px;
	}
	.page-head {
		display: flex;
		align-items: baseline;
		gap: 8px;
		font-size: 14px;
	}
	.page-head a {
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}
	.pages .strip {
		margin-top: 6px;
	}
	.pages .strip img,
	.pages .strip .missing,
	.pages .strip .more {
		height: 72px;
	}

	.unsourced {
		margin-top: 28px;
		padding-top: 20px;
		border-top: 1px solid var(--line);
	}
	.unsourced h2 {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}
	.muted {
		color: var(--muted);
		font-size: 13px;
		margin: 4px 0 0;
	}
	.empty {
		padding: 40px 0;
		text-align: center;
	}
	.empty p {
		margin: 0 0 6px;
	}
	.err {
		color: var(--accent);
	}

	@media (max-width: 640px) {
		.appbar {
			padding: 10px 12px;
		}
		.page {
			padding: 16px 12px 64px;
		}
		.head {
			grid-template-columns: 32px minmax(0, 1fr);
		}
		.projects {
			grid-column: 1 / -1;
			justify-content: flex-start;
			max-width: none;
		}
		select {
			flex: 1 1 140px;
			max-width: none;
		}
		.strip img,
		.strip .missing,
		.strip .more {
			height: 80px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.strip a,
		.pages-toggle svg {
			transition: none;
		}
	}
</style>
