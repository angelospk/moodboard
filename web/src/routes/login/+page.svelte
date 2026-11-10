<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';

	let { data } = $props();
	let email = $state('');
	let password = $state('');
	let error = $state('');
	let busy = $state(false);

	async function submit(mode: 'in' | 'up') {
		busy = true;
		error = '';
		const auth = data.supabase.auth;
		const { error: e } = mode === 'in'
			? await auth.signInWithPassword({ email, password })
			: await auth.signUp({ email, password });
		busy = false;
		if (e) { error = e.message; return; }
		await invalidate('supabase:auth');
		const next = page.url.searchParams.get('next');
		goto(next?.startsWith('/') && !next.startsWith('//') ? next : '/');
	}
</script>

<main>
	<h1>Moodboard</h1>
	<form onsubmit={(e) => { e.preventDefault(); submit('in'); }}>
		<input type="email" placeholder="email" bind:value={email} required autocomplete="email" />
		<input type="password" placeholder="κωδικός" bind:value={password} required minlength="6" autocomplete="current-password" />
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
