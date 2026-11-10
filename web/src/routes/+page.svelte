<script lang="ts">
	import { goto, invalidate, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { LEVELS, type Inspiration, type Level } from '#lib/types.js';
	import { LEVEL_LABELS } from '#lib/tags.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const LAST_PROJECT_KEY = 'moodboard:last-project';

	let query = $state('');
	let level = $state<Level | ''>('');
	let newProject = $state('');
	let creating = $state(false);
	let projectError = $state('');
	let loggingOut = $state(false);
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
		const t = Date.parse(iso);
		if (!Number.isFinite(t)) return '';
		const minutes = Math.floor(Math.max(0, nowMs - t) / 60000);
		if (minutes < 1) return 'μόλις τώρα';
		if (minutes < 60) return `πριν ${minutes} ${minutes === 1 ? 'λεπτό' : 'λεπτά'}`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `πριν ${hours} ${hours === 1 ? 'ώρα' : 'ώρες'}`;
		const days = Math.floor(hours / 24);
		if (days === 1) return 'χθες';
		if (days < 7) return `πριν ${days} μέρες`;
		if (days < 30) {
			const weeks = Math.floor(days / 7);
			return weeks === 1 ? 'πριν 1 εβδομάδα' : `πριν ${weeks} εβδομάδες`;
		}
		const months = Math.floor(days / 30);
		if (months < 12) return months === 1 ? 'πριν 1 μήνα' : `πριν ${months} μήνες`;
		const years = Math.floor(days / 365);
		return years <= 1 ? 'πριν 1 χρόνο' : `πριν ${years} χρόνια`;
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
		const out: Card[] = data.projects.map((p) => {
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
				name: 'Χωρίς project',
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

	const gridCards = $derived(cards.filter((c) => c.key !== resumeCard?.key));

	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return data.inspirations.filter((i) => {
			if (selected === 'none' ? i.project_id !== null : selected !== 'all' && i.project_id !== selected) {
				return false;
			}
			if (level && i.level !== level) return false;
			if (q && !i.note.toLowerCase().includes(q) && !i.tags.some((t) => t.includes(q))) return false;
			return true;
		});
	});

	const selectedName = $derived(
		selected === 'none'
			? 'Χωρίς project'
			: (data.projects.find((p) => p.id === selected)?.name ?? 'Εικόνες')
	);

	const orphanCount = $derived((groups.get('none') ?? []).length);

	// Visiting /?project=<id> counts as opening that project.
	$effect(() => {
		const id = selected;
		if (id !== 'all' && id !== 'none') remember(id);
	});

	onMount(() => {
		now = Date.now();
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
		const { data: row, error } = await data.supabase
			.from('projects')
			.insert({ name })
			.select('id')
			.single();
		creating = false;
		if (error || !row) {
			projectError = error?.code === '23505' ? 'Υπάρχει ήδη project με αυτό το όνομα.' : error?.message ?? 'Αποτυχία.';
			return;
		}
		newProject = '';
		await invalidate('moodboard:data');
		selectProject(row.id as string);
	}

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
		await data.supabase.auth.signOut();
		await invalidateAll();
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
		<a class="btn" href={selected === 'all' ? '/map' : `/map?project=${encodeURIComponent(selected)}`}>Χάρτης</a>
		<a class="btn primary new-image" href="/new">+ Νέα εικόνα</a>
		<button class="btn" type="button" disabled={loggingOut} onclick={logout}>
			{loggingOut ? '…' : 'Αποσύνδεση'}
		</button>
	</div>
</header>

<div class="page">
	{#if data.error}
		<p class="err">Σφάλμα φόρτωσης: {data.error}</p>
	{/if}

	{#if selected === 'all'}
		<section class="projects">
			<div class="sec-head">
				<h2>Projects</h2>
				<span class="sec-meta">
					{data.projects.length}
					{data.projects.length === 1 ? 'project' : 'projects'} · {data.inspirations.length}
					{data.inspirations.length === 1 ? 'εικόνα' : 'εικόνες'}{#if orphanCount > 0}
						· {orphanCount} χωρίς project{/if}
				</span>
			</div>

			{#if resumeCard}
				<article class="pcard resume">
					{@render collage(resumeCard.images)}
					<span class="resume-label">ΣΥΝΕΧΙΣΕ ΕΔΩ</span>
					<div class="pmeta">
						<div class="headrow">
							<h3>{resumeCard.name}</h3>
							<a
								class="btn primary cta"
								href={mapHref(resumeCard.key)}
								onclick={() => remember(resumeCard.key)}
							>
								Άνοιγμα χάρτη →
							</a>
						</div>
						<div class="prow">
							<span>
								{resumeCard.count}
								{resumeCard.count === 1 ? 'εικόνα' : 'εικόνες'}
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
		</section>
	{:else}
		<section class="images">
			<a class="back" href="/">← Όλα τα projects</a>
			<div class="sec-head">
				<h2>{selectedName}</h2>
				<span class="sec-meta">{filtered.length} εικόνες</span>
			</div>
			{@render filters()}
			{@render imageGrid()}
		</section>
	{/if}

	{#if selected === 'all'}
		<section class="images">
			<div class="sec-head">
				<h2>Όλες οι εικόνες</h2>
				{#if data.inspirations.length > 0}
					<span class="sec-meta">{filtered.length} από {data.inspirations.length}</span>
				{/if}
			</div>
			{@render filters()}
			{@render imageGrid()}
		</section>
	{/if}
</div>

{#snippet collage(images: Inspiration[])}
	<div class="collage" data-count={Math.min(images.length, 3)}>
		{#if images.length === 0}
			<span class="collage-none">χωρίς εικόνες</span>
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
		<div class="pmeta">
			<h3>{card.name}</h3>
			<div class="prow">
				<span>{card.count} {card.count === 1 ? 'εικόνα' : 'εικόνες'}</span>
				<span>{relTime(card.lastChange, now)}</span>
			</div>
			{#if card.tags.length}
				<div class="chips">
					{#each card.tags as t (t)}<span class="chip">{t}</span>{/each}
				</div>
			{/if}
			<div class="prow">
				<a class="sub" href={gridHref(card.key)}>Πίνακας</a>
			</div>
		</div>
		<a
			class="stretch"
			href={mapHref(card.key)}
			onclick={() => remember(card.key)}
			aria-label={`Άνοιγμα χάρτη: ${card.name}`}
		></a>
	</article>
{/snippet}

{#snippet newProjectCard()}
	<article class="pcard new">
		<form onsubmit={createProject}>
			<label class="np-label" for="new-project-name">+ Νέο project</label>
			<div class="np-row">
				<input
					id="new-project-name"
					bind:this={createInput}
					bind:value={newProject}
					placeholder="Όνομα project"
					maxlength="120"
				/>
				<button class="btn" type="submit" disabled={creating}>{creating ? '…' : 'Δημιουργία'}</button>
			</div>
			{#if projectError}<p class="err">{projectError}</p>{/if}
		</form>
	</article>
{/snippet}

{#snippet filters()}
	<div class="filters">
		<input
			type="search"
			placeholder="Αναζήτηση σε σημειώσεις και tags"
			bind:value={query}
			aria-label="Αναζήτηση"
		/>
		<select bind:value={level} aria-label="Επίπεδο">
			<option value="">Όλα τα επίπεδα</option>
			{#each LEVELS as l (l)}<option value={l}>{LEVEL_LABELS[l]}</option>{/each}
		</select>
	</div>
{/snippet}

{#snippet imageGrid()}
	{#if data.inspirations.length === 0}
		<div class="empty-state">
			<p class="empty-title">Εδώ θα ζουν τα moodboards σου.</p>
			<p class="empty-body">Ξεκίνα ένα project και πρόσθεσε την πρώτη εικόνα.</p>
			<div class="empty-actions">
				<button class="btn" type="button" onclick={focusCreate}>+ Νέο project</button>
				<a class="btn primary" href="/new">+ Νέα εικόνα</a>
			</div>
		</div>
	{:else if filtered.length === 0}
		<p class="empty">
			Καμία εικόνα με αυτά τα φίλτρα.
			<a href="/new">Πρόσθεσε μια εικόνα →</a>
		</p>
	{:else}
		<div class="grid">
			{#each filtered as item (item.id)}
				<a class="card" href={`/i/${item.id}`}>
					<div class="thumb">
						{#if data.urls[item.image_path]}
							<img src={data.urls[item.image_path]} alt="" loading="lazy" decoding="async" />
						{:else}
							<span class="missing">χωρίς εικόνα</span>
						{/if}
						{#if item.level}
							<span class="badge">{LEVEL_LABELS[item.level]}</span>
						{/if}
					</div>
					<div class="body">
						{#if item.note}
							<p class="note">{item.note.length > 140 ? `${item.note.slice(0, 140).trimEnd()}…` : item.note}</p>
						{/if}
						{#if item.tags.length}
							<p class="tags">{item.tags.slice(0, 4).join(' · ')}</p>
						{/if}
					</div>
				</a>
			{/each}
		</div>
	{/if}
{/snippet}

<a class="fab" href="/new" aria-label="Νέα εικόνα">+</a>

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
	.note { margin: 0; font-size: 0.88rem; line-height: 1.45; white-space: pre-line; }
	.tags { margin: 6px 0 0; color: var(--muted); font-size: 0.76rem; }

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
