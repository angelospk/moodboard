<script lang="ts">
	import { goto, invalidate, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { LEVELS, type Level } from '#lib/types.js';
	import { LEVEL_LABELS } from '#lib/tags.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let query = $state('');
	let level = $state<Level | ''>('');
	let newProject = $state('');
	let creating = $state(false);
	let projectError = $state('');
	let loggingOut = $state(false);

	// Shallow navigations update `page.shallow.url`, not `page.url` (SvelteKit 3).
	const currentUrl = $derived(page.shallow?.url ?? page.url);
	const selected = $derived(currentUrl.searchParams.get('project') ?? 'all');

	const counts = $derived.by(() => {
		const m = new Map<string, number>();
		for (const i of data.inspirations) {
			if (i.project_id) m.set(i.project_id, (m.get(i.project_id) ?? 0) + 1);
		}
		return m;
	});

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

	function selectProject(id: string) {
		const url = id === 'all' ? '/' : `/?project=${encodeURIComponent(id)}`;
		goto(url, { shallow: true, replace: true, reset: false });
	}

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

<header>
	<div class="brand">
		<h1>Moodboard</h1>
		<span class="who">{data.user?.email ?? ''}</span>
	</div>
	<div class="actions">
		<a class="btn" href="/map">Χάρτης</a>
		<a class="btn primary" href="/new">+ Νέα εικόνα</a>
		<button type="button" disabled={loggingOut} onclick={logout}>Αποσύνδεση</button>
	</div>
</header>

<div class="shell">
	<aside>
		<h2>Projects</h2>
		<nav>
			<button class:active={selected === 'all'} onclick={() => selectProject('all')}>
				<span>Όλα</span><span class="n">{data.inspirations.length}</span>
			</button>
			{#each data.projects as p (p.id)}
				<button class:active={selected === p.id} onclick={() => selectProject(p.id)}>
					<span>{p.name}</span><span class="n">{counts.get(p.id) ?? 0}</span>
				</button>
			{/each}
			<button
				class:active={selected === 'none'}
				onclick={() => selectProject('none')}
			>
				<span>Χωρίς project</span>
				<span class="n">{data.inspirations.filter((i) => i.project_id === null).length}</span>
			</button>
		</nav>

		<form class="newproject" onsubmit={createProject}>
			<input placeholder="Νέο project" bind:value={newProject} maxlength="120" aria-label="Όνομα νέου project" />
			<button type="submit" disabled={creating}>+</button>
		</form>
		{#if projectError}<p class="err">{projectError}</p>{/if}
	</aside>

	<main>
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

		{#if data.error}
			<p class="err">Σφάλμα φόρτωσης: {data.error}</p>
		{:else if filtered.length === 0}
			<p class="empty">
				{data.inspirations.length === 0 ? 'Κανένα moodboard ακόμα.' : 'Καμία εικόνα με αυτά τα φίλτρα.'}
				<a href="/new">Πρόσθεσε την πρώτη εικόνα →</a>
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
	</main>
</div>

<style>
	header {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
		align-items: center;
		justify-content: space-between;
		padding: 16px;
		border-bottom: 1px solid var(--line);
		background: var(--surface);
	}
	.brand { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
	h1 { font-size: 1.25rem; margin: 0; letter-spacing: -0.01em; }
	.who { color: var(--muted); font-size: 0.8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 45vw; }
	.actions { display: flex; gap: 8px; }
	.btn { display: inline-flex; align-items: center; text-decoration: none; border-radius: 8px; padding: 0.45rem 0.9rem; border: 1px solid var(--line); }
	.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }

	.shell { display: grid; grid-template-columns: 220px 1fr; gap: 24px; padding: 16px; align-items: start; }
	@media (max-width: 760px) {
		.shell { grid-template-columns: 1fr; gap: 16px; }
	}

	aside { min-width: 0; }
	h2 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 0 0 8px; }
	nav { display: grid; gap: 2px; }
	nav button {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		width: 100%;
		text-align: left;
		border: 1px solid transparent;
		background: none;
		padding: 0.35rem 0.5rem;
		border-radius: 8px;
	}
	nav button > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	nav button.active { background: var(--surface); border-color: var(--line); font-weight: 600; }
	nav button:disabled { opacity: 0.4; cursor: default; }
	.n { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 0.8rem; }

	.newproject { display: flex; gap: 6px; margin-top: 12px; }
	.newproject input { flex: 1; min-width: 0; }
	.err { color: #c0392b; font-size: 0.8rem; margin: 6px 0 0; }

	main { min-width: 0; }
	.filters { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
	.filters input[type='search'] { flex: 1 1 220px; min-width: 0; }
	.filters select { flex: 0 1 auto; max-width: 100%; }
	.empty { color: var(--muted); padding: 32px 0; }
	.empty a { color: var(--accent); margin-left: 4px; }

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
</style>
