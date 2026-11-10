<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { BUCKET, LEVELS, type Level } from '#lib/types.js';
	import { LEVEL_LABELS, normTags } from '#lib/tags.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const EXT: Record<string, string> = {
		'image/png': 'png',
		'image/jpeg': 'jpg',
		'image/webp': 'webp',
		'image/gif': 'gif',
		'image/avif': 'avif'
	};
	const MAX_BYTES = 10 * 1024 * 1024;

	let file = $state<File | null>(null);
	let preview = $state('');
	let projectId = $state('');
	let note = $state('');
	let tags = $state('');
	let level = $state<Level | ''>('');
	let busy = $state(false);
	let error = $state('');

	function accept(f: File | null) {
		error = '';
		if (!f) return;
		if (!EXT[f.type]) {
			error = 'Επιτρέπονται μόνο png, jpeg, webp, gif ή avif.';
			return;
		}
		if (f.size > MAX_BYTES) {
			error = 'Η εικόνα είναι μεγαλύτερη από 10MB.';
			return;
		}
		file = f;
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

	onMount(() => {
		function onPaste(e: ClipboardEvent) {
			const items = e.clipboardData?.items;
			if (!items) return;
			for (const item of items) {
				if (item.kind === 'file' && item.type.startsWith('image/')) {
					const f = item.getAsFile();
					if (f) {
						accept(f);
						e.preventDefault();
					}
					return;
				}
			}
		}
		window.addEventListener('paste', onPaste);
		return () => {
			window.removeEventListener('paste', onPaste);
			if (preview) URL.revokeObjectURL(preview);
		};
	});

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (!file || busy) return;
		const f = file;
		const ext = EXT[f.type];
		if (!ext) { error = 'Μη υποστηριζόμενος τύπος εικόνας.'; return; }
		if (!data.user) { error = 'Δεν βρέθηκε χρήστης. Συνδέσου ξανά.'; return; }

		busy = true;
		error = '';

		const path = `${data.user.id}/${crypto.randomUUID()}.${ext}`;
		const up = await data.supabase.storage.from(BUCKET).upload(path, f, { contentType: f.type });
		if (up.error) {
			busy = false;
			error = `Αποτυχία ανεβάσματος: ${up.error.message}`;
			return;
		}

		const { data: row, error: insErr } = await data.supabase
			.from('inspirations')
			.insert({
				image_path: path,
				project_id: projectId || null,
				note: note.trim(),
				tags: normTags(tags),
				level: level || null
			})
			.select('id')
			.single();

		if (insErr || !row) {
			await data.supabase.storage.from(BUCKET).remove([path]);
			busy = false;
			error = `Αποτυχία αποθήκευσης: ${insErr?.message ?? 'άγνωστο σφάλμα'}`;
			return;
		}

		await goto(`/i/${row.id}`);
	}
</script>

<svelte:head>
	<title>Νέα εικόνα · Moodboard</title>
</svelte:head>

<header>
	<a class="back" href="/">← Πίσω</a>
	<h1>Νέα εικόνα</h1>
</header>

<main>
	<form onsubmit={save}>
		<div
			class="drop"
			class:filled={!!preview}
			role="button"
			tabindex="0"
			ondragover={(e) => e.preventDefault()}
			ondrop={onDrop}
			onkeydown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') (e.currentTarget as HTMLElement).querySelector('input')?.click();
			}}
		>
			{#if preview}
				<img src={preview} alt="Προεπισκόπηση" />
				<label class="replace">
					<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" onchange={onPick} />
					Αλλαγή εικόνας
				</label>
			{:else}
				<label class="pick">
					<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" onchange={onPick} />
					<span class="cta">Επίλεξε εικόνα</span>
					<span class="hint">ή σύρε τη εδώ, ή κάνε επικόλληση (Ctrl+V)</span>
					<span class="hint">png · jpeg · webp · gif · avif — έως 10MB</span>
				</label>
			{/if}
		</div>

		<div class="fields">
			<label>
				<span>Project</span>
				<select bind:value={projectId}>
					<option value="">— χωρίς project —</option>
					{#each data.projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
				</select>
			</label>

			<label>
				<span>Επίπεδο</span>
				<select bind:value={level}>
					<option value="">— κανένα —</option>
					{#each LEVELS as l (l)}<option value={l}>{LEVEL_LABELS[l]}</option>{/each}
				</select>
			</label>

			<label class="wide">
				<span>Σημείωση</span>
				<textarea bind:value={note} rows="4" placeholder="Τι σου αρέσει εδώ; Φως, υλικό, αναλογίες…"></textarea>
			</label>

			<label class="wide">
				<span>Tags <em>(χωρισμένα με κόμμα, έως 30)</em></span>
				<input bind:value={tags} placeholder="ξύλο, πέργκολα, ζεστό φως" />
			</label>
		</div>

		{#if error}<p class="err">{error}</p>{/if}

		<div class="submit">
			<button class="primary" type="submit" disabled={busy || !file}>
				{busy ? 'Αποθήκευση…' : 'Αποθήκευση'}
			</button>
			<a href="/">Άκυρο</a>
		</div>
	</form>
</main>

<style>
	header { display: flex; align-items: center; gap: 12px; padding: 16px; border-bottom: 1px solid var(--line); background: var(--surface); }
	h1 { font-size: 1.1rem; margin: 0; }
	.back { text-decoration: none; color: var(--muted); font-size: 0.85rem; }

	main { padding: 16px; max-width: 720px; margin: 0 auto; }
	form { display: grid; gap: 16px; }

	.drop {
		border: 1.5px dashed var(--line);
		border-radius: var(--radius);
		background: var(--surface);
		display: grid;
		place-items: center;
		padding: 28px 16px;
		min-height: 220px;
	}
	.drop.filled { padding: 0; border-style: solid; overflow: hidden; position: relative; }
	.drop img { display: block; width: 100%; max-height: 60vh; object-fit: contain; background: var(--bg); }
	.pick { display: grid; gap: 6px; justify-items: center; cursor: pointer; text-align: center; }
	.pick .cta { font-weight: 600; padding: 0.5rem 1.1rem; border-radius: 8px; background: var(--accent); color: #fff; }
	.pick .hint { color: var(--muted); font-size: 0.8rem; }
	input[type='file'] { display: none; }
	.replace {
		position: absolute;
		right: 10px;
		bottom: 10px;
		cursor: pointer;
		font-size: 0.8rem;
		padding: 0.3rem 0.7rem;
		border-radius: 8px;
		background: rgba(0, 0, 0, 0.65);
		color: #fff;
	}

	.fields { display: grid; gap: 12px; }
	@media (min-width: 560px) { .fields { grid-template-columns: 1fr 1fr; } }
	label { display: grid; gap: 4px; font-size: 0.82rem; color: var(--muted); min-width: 0; }
	label :is(input, select, textarea) { width: 100%; color: var(--text); }
	.wide { grid-column: 1 / -1; }
	em { font-style: normal; opacity: 0.7; }

	.err { color: #c0392b; margin: 0; font-size: 0.85rem; }
	.submit { display: flex; align-items: center; gap: 16px; }
	.submit a { color: var(--muted); text-decoration: none; font-size: 0.85rem; }
</style>
