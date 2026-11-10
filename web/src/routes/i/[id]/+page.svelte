<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import { BUCKET, LEVELS, type Level, type Region } from '#lib/types.js';
	import { LEVEL_LABELS, normTags } from '#lib/tags.js';
	import { untrack } from 'svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Form state is intentionally initialized once; edits are saved, not reloaded.
	const item = untrack(() => data.inspiration);

	let note = $state(item.note);
	let tags = $state(item.tags.join(', '));
	let level = $state<Level | ''>(item.level ?? '');
	let projectId = $state(item.project_id ?? '');
	let regions = $state<Region[]>(item.regions.map((r) => ({ ...r })));
	let draft = $state<Region | null>(null);
	let dragging = $state(false);
	let busy = $state<'save' | 'delete' | ''>('');
	let message = $state('');
	let error = $state('');

	// Title follows the project picker so a newly chosen project shows at once.
	const projectName = $derived(data.projects.find((p) => p.id === projectId)?.name ?? '');

	let stage = $state<HTMLDivElement | null>(null);
	let origin = { x: 0, y: 0 };

	function fraction(e: PointerEvent): { x: number; y: number } {
		const el = stage;
		if (!el) return { x: 0, y: 0 };
		const box = el.getBoundingClientRect();
		return {
			x: Math.min(Math.max((e.clientX - box.left) / box.width, 0), 1),
			y: Math.min(Math.max((e.clientY - box.top) / box.height, 0), 1)
		};
	}

	function onDown(e: PointerEvent) {
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		const p = fraction(e);
		origin = p;
		draft = { x: p.x, y: p.y, w: 0, h: 0, note: '' };
		dragging = true;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		e.preventDefault();
	}

	function onMove(e: PointerEvent) {
		if (!dragging) return;
		const p = fraction(e);
		draft = {
			x: Math.min(origin.x, p.x),
			y: Math.min(origin.y, p.y),
			w: Math.abs(p.x - origin.x),
			h: Math.abs(p.y - origin.y),
			note: ''
		};
	}

	function onUp(e: PointerEvent) {
		if (!dragging) return;
		dragging = false;
		const el = e.currentTarget as HTMLElement;
		if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
		// A tap or a drag under 1% on either side is not a region.
		if (draft && draft.w >= 0.01 && draft.h >= 0.01) {
			regions = [...regions, draft];
			message = '';
		}
		draft = null;
	}

	function removeRegion(index: number) {
		regions = regions.filter((_, i) => i !== index);
		message = '';
	}

	function pct(v: number) {
		return `${v * 100}%`;
	}

	async function save() {
		if (busy) return;
		busy = 'save';
		message = '';
		error = '';
		const { error: e } = await data.supabase
			.from('inspirations')
			.update({
				note: note.trim(),
				tags: normTags(tags),
				level: level || null,
				project_id: projectId || null,
				regions
			})
			.eq('id', item.id);
		busy = '';
		if (e) {
			error = `Αποτυχία αποθήκευσης: ${e.message}`;
			return;
		}
		tags = normTags(tags).join(', ');
		message = 'Αποθηκεύτηκε.';
		await invalidate('moodboard:data');
	}

	async function remove() {
		if (busy) return;
		if (!confirm('Διαγραφή της εικόνας και των σημειώσεων της;')) return;
		busy = 'delete';
		error = '';
		const { error: e } = await data.supabase.from('inspirations').delete().eq('id', item.id);
		if (e) {
			busy = '';
			error = `Αποτυχία διαγραφής: ${e.message}`;
			return;
		}
		await data.supabase.storage.from(BUCKET).remove([item.image_path]);
		await invalidate('moodboard:data');
		await goto('/');
	}
</script>

<svelte:head>
	<title>Εικόνα · Moodboard</title>
</svelte:head>

<header>
	<a class="back" href="/">← Πίσω</a>
	<h1>{projectName || 'Εικόνα'}</h1>
	<div class="head-actions">
		<button class="primary" type="button" disabled={!!busy} onclick={save}>
			{busy === 'save' ? 'Αποθήκευση…' : 'Αποθήκευση'}
		</button>
		<button class="danger" type="button" disabled={!!busy} onclick={remove}>
			{busy === 'delete' ? 'Διαγραφή…' : 'Διαγραφή'}
		</button>
	</div>
</header>

{#if message}<p class="ok wrap">{message}</p>{/if}
{#if error}<p class="err wrap">{error}</p>{/if}

<div class="shell">
	<div class="stage-col">
		<div
			class="stage"
			class:dragging
			bind:this={stage}
			role="presentation"
			onpointerdown={onDown}
			onpointermove={onMove}
			onpointerup={onUp}
			onpointercancel={onUp}
		>
			{#if data.imageUrl}
				<img src={data.imageUrl} alt="Έμπνευση" draggable="false" />
			{:else}
				<div class="noimg">Η εικόνα δεν βρέθηκε στο storage.</div>
			{/if}

			{#each regions as r, i (i)}
				<div
					class="box"
					style:left={pct(r.x)}
					style:top={pct(r.y)}
					style:width={pct(r.w)}
					style:height={pct(r.h)}
				>
					<span class="num">{i + 1}</span>
				</div>
			{/each}

			{#if draft}
				<div
					class="box draft"
					style:left={pct(draft.x)}
					style:top={pct(draft.y)}
					style:width={pct(draft.w)}
					style:height={pct(draft.h)}
				></div>
			{/if}
		</div>
		<p class="hint">Σύρε πάνω στην εικόνα για να σημειώσεις μια λεπτομέρεια.</p>
	</div>

	<aside>
		<label>
			<span>Σημείωση</span>
			<textarea bind:value={note} rows="6" placeholder="Τι σου αρέσει εδώ;"></textarea>
		</label>

		<label>
			<span>Tags <em>(χωρισμένα με κόμμα, έως 30)</em></span>
			<input bind:value={tags} placeholder="ξύλο, πέργκολα" />
		</label>

		<div class="row">
			<label>
				<span>Επίπεδο</span>
				<select bind:value={level}>
					<option value="">— κανένα —</option>
					{#each LEVELS as l (l)}<option value={l}>{LEVEL_LABELS[l]}</option>{/each}
				</select>
			</label>
			<label>
				<span>Project</span>
				<select bind:value={projectId}>
					<option value="">— χωρίς project —</option>
					{#each data.projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
				</select>
			</label>
		</div>

		{#if item.source_url && /^https?:\/\//i.test(item.source_url)}
			<div class="field">
				<span class="label">Πηγή</span>
				<a class="src" href={item.source_url} target="_blank" rel="noopener noreferrer">
					{item.source_title || item.source_url}
				</a>
			</div>
		{/if}

		<section class="regions">
			<h2>Σημειωμένες λεπτομέρειες ({regions.length})</h2>
			{#if regions.length === 0}
				<p class="muted">Καμία ακόμα. Σύρε πάνω στην εικόνα.</p>
			{/if}
			{#each regions as r, i (i)}
				<div class="region">
					<div class="region-head">
						<span class="num-chip">{i + 1}</span>
						<button class="link" type="button" onclick={() => removeRegion(i)} aria-label={`Διαγραφή περιοχής ${i + 1}`}>
							Διαγραφή
						</button>
					</div>
					<textarea
						rows="2"
						placeholder="Τι σου αρέσει σε αυτό το σημείο;"
						bind:value={r.note}
					></textarea>
				</div>
			{/each}
		</section>

		<button class="primary full" type="button" disabled={!!busy} onclick={save}>
			{busy === 'save' ? 'Αποθήκευση…' : 'Αποθήκευση'}
		</button>
	</aside>
</div>

<style>
	header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px;
		padding: 16px;
		border-bottom: 1px solid var(--line);
		background: var(--surface);
	}
	.back { text-decoration: none; color: var(--muted); font-size: 0.85rem; }
	h1 { font-size: 1.05rem; margin: 0; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.head-actions { display: flex; gap: 8px; margin-left: auto; }
	@media (max-width: 560px) {
		.head-actions { width: 100%; margin-left: 0; }
		.head-actions :is(button) { flex: 1; }
	}
	button.danger { color: #c0392b; border-color: var(--line); }

	.ok { color: #2e7d5e; margin: 12px 16px 0; font-size: 0.85rem; }
	.err { color: #c0392b; margin: 12px 16px 0; font-size: 0.85rem; }
	.wrap { word-break: break-word; }

	.shell { display: grid; gap: 20px; padding: 16px; align-items: start; }
	@media (min-width: 900px) { .shell { grid-template-columns: 1fr 360px; } }

	.stage-col { min-width: 0; }
	.stage {
		position: relative;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		overflow: hidden;
		line-height: 0;
		touch-action: none;
		cursor: crosshair;
		user-select: none;
	}
	.stage.dragging { cursor: grabbing; }
	.stage img { display: block; width: 100%; height: auto; pointer-events: none; }
	.noimg { padding: 60px 16px; text-align: center; color: var(--muted); font-size: 0.85rem; line-height: 1.5; }
	.hint { color: var(--muted); font-size: 0.8rem; margin: 8px 0 0; }

	.box {
		position: absolute;
		border: 2px solid var(--accent);
		background: rgba(180, 83, 42, 0.12);
		border-radius: 3px;
		pointer-events: none;
	}
	.box.draft { border-style: dashed; background: rgba(180, 83, 42, 0.18); }
	.num {
		position: absolute;
		top: -1px;
		left: -1px;
		transform: translate(-50%, -50%);
		background: var(--accent);
		color: #fff;
		font-size: 0.7rem;
		line-height: 1.4;
		min-width: 1.3rem;
		text-align: center;
		border-radius: 999px;
		padding: 0 0.3rem;
		font-variant-numeric: tabular-nums;
	}

	aside { display: grid; gap: 12px; min-width: 0; }
	label { display: grid; gap: 4px; font-size: 0.8rem; color: var(--muted); min-width: 0; }
	label :is(input, select, textarea) { width: 100%; color: var(--text); }
	.field { display: grid; gap: 4px; font-size: 0.8rem; color: var(--muted); min-width: 0; }
	.row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
	em { font-style: normal; opacity: 0.7; }
	.src { color: var(--accent); font-size: 0.85rem; text-decoration: none; overflow-wrap: anywhere; }

	.regions { display: grid; gap: 8px; }
	.regions h2 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 8px 0 0; }
	.muted { color: var(--muted); font-size: 0.82rem; margin: 0; }
	.region { border: 1px solid var(--line); border-radius: var(--radius); padding: 8px; background: var(--surface); display: grid; gap: 6px; }
	.region-head { display: flex; align-items: center; justify-content: space-between; }
	.num-chip { background: var(--accent); color: #fff; border-radius: 999px; font-size: 0.7rem; padding: 0 0.4rem; min-width: 1.3rem; text-align: center; }
	.link { border: none; background: none; padding: 0; color: var(--muted); font-size: 0.78rem; text-decoration: underline; }
	.link:hover { color: #c0392b; }
	.region textarea { width: 100%; }
	.full { width: 100%; }
</style>
