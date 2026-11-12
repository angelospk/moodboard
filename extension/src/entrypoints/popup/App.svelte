<script lang="ts">
	import { onMount } from 'svelte';
	import type { AuthRecord } from 'pocketbase';
	import { msg, pb, ready } from '@/lib/pb';
	import { clearPending, getPending, type CaptureResult, type PendingCapture } from '@/lib/pending';
	import TagInput from '@/lib/TagInput.svelte';
	import {
		MIME_EXT,
		normalizeMime,
		type Level,
		type LevelRow,
		type Project,
	} from '@/lib/types';

	const WEB_URL = import.meta.env.WXT_WEB_URL;

	let user = $state<AuthRecord | null>(null);
	let booting = $state(true);
	let updateAvailable = $state(false);

	let email = $state('');
	let password = $state('');
	let invite = $state('');
	let authBusy = $state(false);
	let authError = $state('');

	let pending = $state<PendingCapture | null>(null);
	let projects = $state<Project[]>([]);
	let projectId = $state('');
	let creatingProject = $state(false);
	let newProjectName = $state('');
	let note = $state('');
	let tags = $state<string[]>([]);
	let tagSuggestions = $state<string[]>([]);
	let levels = $state<LevelRow[]>([]);
	let level = $state<Level | ''>('');
	let saving = $state(false);
	let errorMessage = $state('');
	let savedId = $state('');

	onMount(() => {
		let unsubscribe = () => {};
		void (async () => {
			await ready();
			// Renew a still-valid token on open (an expired one cannot be refreshed), so a login lasts
			// as long as the popup is used now and then. Only a 401 signs out; offline keeps the login.
			if (pb.authStore.record && !pb.authStore.isValid) pb.authStore.clear();
			else if (pb.authStore.record) {
				try {
					await pb.collection('users').authRefresh();
				} catch (error) {
					if ((error as { status?: number }).status === 401) pb.authStore.clear();
				}
			}
			user = pb.authStore.record;
			booting = false;
			unsubscribe = pb.authStore.onChange(() => {
				user = pb.authStore.record;
				if (user) void refresh();
			});
			if (user) void refresh();
		})();
		void checkVersion();
		return () => unsubscribe();
	});

	/** The files on disk change after an update, but the running manifest keeps the old version. */
	async function checkVersion() {
		try {
			const response = await fetch(browser.runtime.getURL('/version.json'), { cache: 'no-store' });
			if (!response.ok) return;
			const data = (await response.json()) as { version?: string };
			updateAvailable = !!data.version && data.version !== browser.runtime.getManifest().version;
		} catch {
			updateAvailable = false;
		}
	}

	function restart() {
		browser.runtime.reload();
	}

	async function refresh() {
		pending = await getPending();
		await loadProjects();
		await loadLevels();
		await loadUserTags();
	}

	async function loadUserTags() {
		try {
			const rows = await pb.send<string[]>('/api/mb/tags', { method: 'GET' });
			tagSuggestions = Array.isArray(rows) ? rows : [];
		} catch {
			tagSuggestions = [];
		}
	}

	async function loadLevels() {
		try {
			const rows = await pb.collection('levels').getFullList({ sort: 'position,created_at' });
			levels = rows.map((row) => ({ id: row.id, name: row.name ?? '' }));
			if (level && !levels.some((l) => l.id === level)) level = '';
		} catch {
			levels = [];
		}
	}

	async function loadProjects() {
		try {
			const rows = await pb.collection('projects').getFullList({ sort: 'name' });
			projects = rows.map((row) => ({
				id: row.id,
				name: row.name ?? '',
				description: row.description ?? '',
				created_at: row.created_at,
			}));
		} catch (error) {
			errorMessage = msg(error);
		}
	}

	async function signIn() {
		authBusy = true;
		authError = '';
		try {
			await pb.collection('users').authWithPassword(email, password);
		} catch (error) {
			authError = msg(error);
		} finally {
			authBusy = false;
		}
	}

	async function signUp() {
		authBusy = true;
		authError = '';
		try {
			await pb
				.collection('users')
				.create({ email, password, passwordConfirm: password, invite: invite.trim() });
			await pb.collection('users').authWithPassword(email, password);
		} catch (error) {
			authError = msg(error);
		} finally {
			authBusy = false;
		}
	}

	async function signOut() {
		pb.authStore.clear();
		user = null;
	}

	async function createProject() {
		const name = newProjectName.trim();
		if (!name) return;
		const userId = pb.authStore.record?.id;
		if (!userId) return;
		try {
			const row = await pb
				.collection('projects')
				.create({ user_id: userId, name, description: '' });
			const created: Project = {
				id: row.id,
				name: row.name ?? name,
				description: row.description ?? '',
				created_at: row.created_at,
			};
			projects = [...projects, created].sort((a, b) => a.name.localeCompare(b.name));
			projectId = created.id;
			creatingProject = false;
			newProjectName = '';
		} catch (error) {
			errorMessage = msg(error);
		}
	}

	async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
		const response = await fetch(dataUrl);
		return response.blob();
	}

	/** One multipart request uploads the image file and creates the row. */
	function inspirationForm(blob: Blob, mime: string): FormData {
		const form = new FormData();
		form.append('user_id', pb.authStore.record!.id);
		form.append('project_id', projectId);
		form.append('image', blob, `image.${MIME_EXT[mime]}`);
		form.append('source_url', pending?.sourceUrl ?? '');
		form.append('source_title', pending?.sourceTitle ?? '');
		// The image's own address (not the page), so it can be found again later. Screenshots have none.
		if (/^https?:\/\//.test(pending?.imageUrl ?? '')) form.append('image_url', pending!.imageUrl!);
		form.append('note', note.trim());
		form.append('tags', JSON.stringify(tags));
		form.append('level', level);
		form.append('regions', '[]');
		return form;
	}

	async function save() {
		if (!user || !pending?.dataUrl) return;
		errorMessage = '';
		savedId = '';

		const mime = normalizeMime(pending.mime).startsWith('image/')
			? normalizeMime(pending.mime)
			: normalizeMime((await dataUrlToBlob(pending.dataUrl)).type);
		if (!MIME_EXT[mime]) {
			errorMessage = 'Ο τύπος εικόνας δεν υποστηρίζεται.';
			return;
		}

		saving = true;
		try {
			const blob = await dataUrlToBlob(pending.dataUrl);
			const record = await pb.collection('inspirations').create(inspirationForm(blob, mime));
			savedId = record.id;
			await clearPending();
			pending = null;
		} catch (error) {
			errorMessage = msg(error);
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
		tags = [];
		level = '';
		projectId = '';
		errorMessage = '';
		savedId = '';
		creatingProject = false;
		newProjectName = '';
	}
</script>

{#if updateAvailable}
	<div class="banner">
		<span>Νέα έκδοση διαθέσιμη</span>
		<button type="button" class="banner-button" onclick={restart}>Επανεκκίνηση</button>
	</div>
{/if}

<main>
	<h1>Moodboard</h1>

	{#if booting}
		<p class="muted">Φόρτωση…</p>
	{:else if !user}
		<form class="stack" onsubmit={(event) => { event.preventDefault(); void signIn(); }}>
			<label>Email
				<input type="email" bind:value={email} autocomplete="username" required />
			</label>
			<label>Κωδικός
				<input type="password" bind:value={password} autocomplete="current-password" required />
			</label>
			<label>Κωδικός πρόσκλησης
				<input type="text" bind:value={invite} autocomplete="off" />
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
			<span class="muted ellipsis">{user.email}</span>
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

					<div class="field">
						<span class="field-label">Tags</span>
						<TagInput bind:tags suggestions={tagSuggestions} placeholder="ξύλο, φως" />
					</div>

					<label>Επίπεδο
						<select bind:value={level}>
							<option value="">—</option>
							{#each levels as item (item.id)}
								<option value={item.id}>{item.name}</option>
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
	.banner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 6px 14px;
		background: #eef4f4;
		border-bottom: 1px solid #cfdedf;
		font-size: 0.8rem;
		color: #1b5e64;
	}
	.banner-button {
		font: inherit;
		padding: 4px 10px;
		border-radius: 6px;
		border: 1px solid #1b5e64;
		background: #1b5e64;
		color: #fff;
		cursor: pointer;
	}
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
	.field {
		display: flex;
		flex-direction: column;
		gap: 3px;
		font-size: 0.8rem;
	}
	.field-label {
		color: inherit;
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
