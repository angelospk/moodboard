<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import { signUp } from '#lib/inspirations.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let email = $state('');
	let password = $state('');
	let invite = $state('');
	let error = $state('');
	let busy = $state(false);

	function errText(e: unknown): string {
		const r = e as { response?: { message?: string; data?: Record<string, { message?: string }> }; message?: string };
		const field = r.response?.data && Object.entries(r.response.data)[0];
		if (field) return `${field[0]}: ${field[1]?.message ?? ''}`.trim();
		return r.response?.message || r.message || 'άγνωστο σφάλμα';
	}

	async function submit(mode: 'in' | 'up') {
		busy = true;
		error = '';
		try {
			if (mode === 'in') {
				await data.pb.collection('users').authWithPassword(email, password);
			} else {
				if (!invite.trim()) throw new Error('Χρειάζεται κωδικός πρόσκλησης.');
				await signUp(data.pb, email, password, invite);
			}
		} catch (e) {
			error = errText(e);
			busy = false;
			return;
		}
		busy = false;
		await invalidate('app:auth');
		const next = page.url.searchParams.get('next');
		goto(next?.startsWith('/') && !next.startsWith('//') ? next : '/');
	}
</script>

<main>
	<h1>Moodboard</h1>
	<form onsubmit={(e) => { e.preventDefault(); submit('in'); }}>
		<input type="email" placeholder="email" bind:value={email} required autocomplete="email" />
		<input type="password" placeholder="κωδικός" bind:value={password} required minlength="6" autocomplete="current-password" />
		<input type="text" placeholder="Κωδικός πρόσκλησης" bind:value={invite} autocomplete="off" />
		{#if error}<p class="err">{error}</p>{/if}
		<button class="primary" disabled={busy}>Σύνδεση</button>
		<button type="button" disabled={busy} onclick={() => submit('up')}>Νέος λογαριασμός</button>
	</form>
</main>

<style>
	main { max-width: 340px; margin: 12vh auto; padding: 0 16px; }
	form { display: grid; gap: 0.6rem; }
	.err { color: #c0392b; margin: 0; }
</style>
