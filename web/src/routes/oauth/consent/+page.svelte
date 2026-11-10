<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const d = $derived(data.details);
	let busy = $state(false);
	let error = $state('');

	const host = (u: string) => {
		try {
			return new URL(u).host;
		} catch {
			return u;
		}
	};

	async function decide(approve: boolean) {
		busy = true;
		error = '';
		const oauth = data.supabase.auth.oauth;
		const { data: r, error: e } = approve
			? await oauth.approveAuthorization(d.authorization_id, { skipBrowserRedirect: true })
			: await oauth.denyAuthorization(d.authorization_id, { skipBrowserRedirect: true });
		if (e || !r) {
			busy = false;
			error = e?.message ?? 'Κάτι πήγε στραβά.';
			return;
		}
		window.location.assign(r.redirect_url);
	}
</script>

<svelte:head><title>Σύνδεση εφαρμογής · Moodboard</title></svelte:head>

<main>
	<h1>Σύνδεση εφαρμογής</h1>
	<p>
		Η εφαρμογή <strong>{d.client.name || 'χωρίς όνομα'}</strong> ζητά πρόσβαση στο moodboard σου
		(<strong>{d.user.email}</strong>).
	</p>
	<ul>
		<li>Θα βλέπει τα projects, τις εικόνες, τις σημειώσεις και τα σημάδια σου.</li>
		<li>Θα μπορεί να προσθέτει εικόνες και σημειώσεις.</li>
		<li>Επιστροφή σε: <code>{host(d.redirect_uri)}</code></li>
	</ul>
	{#if error}<p class="err">{error}</p>{/if}
	<div class="actions">
		<button class="primary" disabled={busy} onclick={() => decide(true)}>Επιτρέπω</button>
		<button disabled={busy} onclick={() => decide(false)}>Άρνηση</button>
	</div>
	<p class="muted">Αν δεν ξεκίνησες εσύ αυτή τη σύνδεση, πάτα «Άρνηση».</p>
</main>

<style>
	main { max-width: 460px; margin: 10vh auto; padding: 0 16px; }
	ul { padding-left: 1.2rem; color: var(--muted); line-height: 1.6; }
	code { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 0 0.3rem; }
	.actions { display: flex; gap: 0.6rem; margin: 1.2rem 0; }
	.err { color: #c0392b; }
	.muted { color: var(--muted); font-size: 0.9rem; }
</style>
