<script lang="ts">
	import { onMount } from 'svelte';
	import type { Session } from '@supabase/supabase-js';
	import { supabase } from '@/lib/supabase';
	import { clearPending, getPending, type CaptureResult, type PendingCapture } from '@/lib/pending';
	import {
		BUCKET,
		LEVELS,
		LEVEL_LABELS,
		MIME_EXT,
		normalizeMime,
		parseTags,
		type Level,
		type Project,
	} from '@/lib/types';

	const WEB_URL = import.meta.env.WXT_WEB_URL;

	let session = $state<Session | null>(null);
	let booting = $state(true);

	let email = $state('');
	let password = $state('');
	let authBusy = $state(false);
	let authError = $state('');

	let pending = $state<PendingCapture | null>(null);
	let projects = $state<Project[]>([]);
	let projectId = $state('');
	let creatingProject = $state(false);
	let newProjectName = $state('');
	let note = $state('');
	let tagsInput = $state('');
	let level = $state<Level | ''>('');
	let saving = $state(false);
	let errorMessage = $state('');
	let savedId = $state('');

	onMount(() => {
		supabase.auth.getSession().then(({ data }) => {
			session = data.session;
			booting = false;
			if (session) void refresh();
		});
		const { data } = supabase.auth.onAuthStateChange((_event, next) => {
			session = next;
			if (next) void refresh();
		});
		return () => data.subscription.unsubscribe();
	});

	async function refresh() {
		pending = await getPending();
		await loadProjects();
	}

	async function loadProjects() {
		const result = await supabase
			.from('projects')
			.select('id, name, description, created_at')
			.order('name');
		if (result.error) {
			errorMessage = result.error.message;
			return;
		}
		projects = (result.data ?? []) as Project[];
	}

	async function signIn() {
		authBusy = true;
		authError = '';
		const { error } = await supabase.auth.signInWithPassword({ email, password });
		if (error) authError = error.message;
		authBusy = false;
	}

	async function signUp() {
		authBusy = true;
		authError = '';
		const { error } = await supabase.auth.signUp({ email, password });
		if (error) authError = error.message;
		authBusy = false;
	}

	async function signOut() {
		await supabase.auth.signOut();
		session = null;
	}

	async function createProject() {
		const name = newProjectName.trim();
		if (!name) return;
		const { data, error } = await supabase
			.from('projects')
			.insert({ name })
			.select('id, name, description, created_at')
			.single();
		if (error) {
			errorMessage = error.message;
			return;
		}
		const created = data as Project;
		projects = [...projects, created].sort((a, b) => a.name.localeCompare(b.name));
		projectId = created.id;
		creatingProject = false;
		newProjectName = '';
	}

	async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
		const response = await fetch(dataUrl);
		return response.blob();
	}

	async function save() {
		if (!session || !pending?.dataUrl) return;
		errorMessage = '';
		savedId = '';

		const mime = normalizeMime(pending.mime).startsWith('image/')
			? normalizeMime(pending.mime)
			: normalizeMime((await dataUrlToBlob(pending.dataUrl)).type);
		const ext = MIME_EXT[mime];
		if (!ext) {
			errorMessage = 'Ο τύπος εικόνας δεν υποστηρίζεται.';
			return;
		}

		saving = true;
		const userId = session.user.id;
		const path = `${userId}/${crypto.randomUUID()}.${ext}`;

		try {
			const blob = await dataUrlToBlob(pending.dataUrl);
			const upload = await supabase.storage.from(BUCKET).upload(path, blob, {
				contentType: mime,
				upsert: false,
			});
			if (upload.error) {
				errorMessage = upload.error.message;
				return;
			}

			const insert = await supabase
				.from('inspirations')
				.insert({
					image_path: path,
					project_id: projectId || null,
					note: note.trim(),
					tags: parseTags(tagsInput),
					level: level || null,
					source_url: pending.sourceUrl,
					source_title: pending.sourceTitle,
				})
				.select('id')
				.single();

			if (insert.error || !insert.data) {
				await supabase.storage.from(BUCKET).remove([path]);
				errorMessage = insert.error?.message ?? 'Η αποθήκευση απέτυχε.';
				return;
			}

			savedId = (insert.data as { id: string }).id;
			await clearPending();
			pending = null;
		} finally {
			saving = false;
		}
	}

	async function captureActiveTab() {
		errorMessage = '';
		const response = (await browser.runtime.sendMessage({
			type: 'capture-active-tab',
		})) as CaptureResult | undefined;
		pending = await getPending();
		if (!pending && response && !response.ok) {
			errorMessage = response.error ?? 'Το στιγμιότυπο απέτυχε.';
		}
	}

	function resetCapture() {
		void clearPending();
		pending = null;
		note = '';
		tagsInput = '';
		level = '';
		projectId = '';
		errorMessage = '';
		creatingProject = false;
		newProjectName = '';
	}
</script>

<main>
	<h1>Moodboard</h1>

	{#if booting}
		<p class="muted">Φόρτωση…</p>
	{:else if !session}
		<form class="stack" onsubmit={(event) => { event.preventDefault(); void signIn(); }}>
			<label>Email
				<input type="email" bind:value={email} autocomplete="username" required />
			</label>
			<label>Κωδικός
				<input type="password" bind:value={password} autocomplete="current-password" required />
			</label>
			<div class="row">
				<button type="submit" disabled={authBusy}>Σύνδεση</button>
				<button
					type="button"
					class="secondary"
					disabled={authBusy}
					onclick={() => void signUp()}
				>Νέος λογαριασμός</button>
			</div>
			{#if authError}<p class="error">{authError}</p>{/if}
		</form>
	{:else}
		<div class="row between user">
			<span class="muted ellipsis">{session.user.email}</span>
			<button type="button" class="link" onclick={() => void signOut()}>Αποσύνδεση</button>
		</div>

		{#if savedId}
			<p class="success">
				Αποθηκεύτηκε ·
				<a href={`${WEB_URL}/i/${savedId}`} target="_blank" rel="noreferrer">Άνοιγμα</a>
			</p>
			<button type="button" class="secondary" onclick={resetCapture}>Νέα αποθήκευση</button>
		{:else if pending}
			{#if pending.error}
				<p class="error">{pending.error}</p>
				<button type="button" class="secondary" onclick={resetCapture}>Κλείσιμο</button>
			{:else}
				<img class="preview" src={pending.dataUrl} alt="Προεπισκόπηση" />
				{#if pending.sourceTitle}<p class="muted ellipsis">{pending.sourceTitle}</p>{/if}

				<div class="stack">
					<label>Project
						<select bind:value={projectId}>
							<option value="">—</option>
							{#each projects as project (project.id)}
								<option value={project.id}>{project.name}</option>
							{/each}
						</select>
					</label>
					{#if creatingProject}
						<div class="row">
							<input placeholder="Όνομα project" bind:value={newProjectName} />
							<button type="button" onclick={() => void createProject()}>Προσθήκη</button>
						</div>
					{:else}
						<button type="button" class="link left" onclick={() => (creatingProject = true)}>
							+ νέο project
						</button>
					{/if}

					<label>Σημείωση
						<textarea rows="3" bind:value={note}></textarea>
					</label>

					<label>Tags (χωρισμένα με κόμμα)
						<input bind:value={tagsInput} placeholder="ξύλο, φως" />
					</label>

					<label>Επίπεδο
						<select bind:value={level}>
							<option value="">—</option>
							{#each LEVELS as item (item)}
								<option value={item}>{LEVEL_LABELS[item]}</option>
							{/each}
						</select>
					</label>

					<div class="row">
						<button type="button" disabled={saving} onclick={() => void save()}>
							{saving ? 'Αποθήκευση…' : 'Αποθήκευση'}
						</button>
						<button type="button" class="secondary" disabled={saving} onclick={resetCapture}>
							Άκυρο
						</button>
					</div>
					{#if errorMessage}<p class="error">{errorMessage}</p>{/if}
				</div>
			{/if}
		{:else}
			<div class="stack">
				<p class="muted">Κάνε δεξί κλικ σε μια εικόνα και επίλεξε «Αποθήκευση εικόνας στο Moodboard».</p>
				<button type="button" onclick={() => void captureActiveTab()}>
					Στιγμιότυπο αυτής της σελίδας
				</button>
				<a href={WEB_URL} target="_blank" rel="noreferrer">Άνοιγμα moodboard</a>
				{#if errorMessage}<p class="error">{errorMessage}</p>{/if}
			</div>
		{/if}
	{/if}
</main>

<style>
	main {
		width: 360px;
		padding: 14px;
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	h1 {
		font-size: 1.05rem;
		margin: 0;
	}
	.stack {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.row {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.row.between {
		justify-content: space-between;
	}
	.user {
		font-size: 0.82rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 3px;
		font-size: 0.8rem;
	}
	input,
	select,
	textarea {
		font: inherit;
		padding: 6px 8px;
		border: 1px solid #cfcfcf;
		border-radius: 6px;
		background: #fff;
		color: #171717;
		box-sizing: border-box;
		width: 100%;
	}
	textarea {
		resize: vertical;
	}
	button {
		font: inherit;
		padding: 7px 12px;
		border-radius: 6px;
		border: 1px solid #1b5e64;
		background: #1b5e64;
		color: #fff;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.6;
		cursor: default;
	}
	button.secondary {
		background: #fff;
		color: #1b5e64;
	}
	button.link {
		border: none;
		background: none;
		color: #1b5e64;
		padding: 0;
		touch-action: manipulation;
	}
	button.link.left {
		align-self: flex-start;
		text-align: left;
	}
	a {
		color: #1b5e64;
	}
	.preview {
		width: 100%;
		max-height: 190px;
		object-fit: contain;
		border-radius: 6px;
		background: #f2f2f2;
	}
	.muted {
		color: #6b6b6b;
		margin: 0;
	}
	.ellipsis {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.error {
		color: #a52626;
		margin: 0;
		font-size: 0.8rem;
	}
	.success {
		color: #1b5e64;
		margin: 0;
		font-size: 0.85rem;
	}
</style>
