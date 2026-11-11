<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import { forgetFileToken, signUp } from '#lib/inspirations.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let email = $state('');
	let password = $state('');
	let invite = $state('');
	let error = $state('');
	let busy = $state(false);
	/** 'in' = sign in (email + password only); 'up' = new account, which needs an invite code. */
	let mode = $state<'in' | 'up'>('in');

	function switchMode(next: 'in' | 'up') {
		mode = next;
		error = '';
	}

	function errText(e: unknown): string {
		if ((e as { url?: string; status?: number }).status === 400 && /auth-with-password/.test((e as { url?: string }).url ?? ''))
			return 'Λάθος email ή κωδικός.';
		const r = e as { response?: { message?: string; data?: Record<string, { message?: string }> }; message?: string };
		const field = r.response?.data && Object.entries(r.response.data)[0];
		if (field) return `${field[0]}: ${field[1]?.message ?? ''}`.trim();
		return r.response?.message || r.message || 'άγνωστο σφάλμα';
	}

	async function submit() {
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
		forgetFileToken(data.pb); // a password change since the last visit makes the cached one invalid
		await invalidate('app:auth');
		const next = page.url.searchParams.get('next');
		goto(next?.startsWith('/') && !next.startsWith('//') ? next : '/');
	}
</script>

<main>
	<h1>Moodboard</h1>
	<form onsubmit={(e) => { e.preventDefault(); submit(); }}>
		<input type="email" placeholder="email" bind:value={email} required autocomplete="email" />
		{#if mode === 'in'}
			<input type="password" placeholder="κωδικός" bind:value={password} required minlength="6" autocomplete="current-password" />
		{:else}
			<input type="password" placeholder="κωδικός (τουλάχιστον 8 χαρακτήρες)" bind:value={password} required minlength="8" autocomplete="new-password" />
			<input type="text" placeholder="κωδικός πρόσκλησης" bind:value={invite} required autocomplete="off" />
		{/if}
		{#if error}<p class="err">{error}</p>{/if}
		<button class="primary" disabled={busy}>{mode === 'in' ? 'Σύνδεση' : 'Δημιουργία λογαριασμού'}</button>
		{#if mode === 'in'}
			<button type="button" class="link" onclick={() => switchMode('up')}>Νέος λογαριασμός (με πρόσκληση)</button>
		{:else}
			<button type="button" class="link" onclick={() => switchMode('in')}>Έχω ήδη λογαριασμό</button>
		{/if}
	</form>
</main>

<style>
	main { max-width: 340px; margin: 12vh auto; padding: 0 16px; }
	form { display: grid; gap: 0.6rem; }
	.err { color: #c0392b; margin: 0; }
	.link { background: none; border: none; padding: 0.2rem; color: inherit; opacity: 0.75; text-decoration: underline; cursor: pointer; }
</style>
