<script lang="ts">
	// «Κοινοποίηση»: make, copy or revoke the read-only link of one board. The server keeps only a hash
	// of the token, so the link can be copied right after it is made; later, «Νέος σύνδεσμος» replaces it.
	import type PocketBase from 'pocketbase';
	import { createShare, revokeShare, shareLink, shareStatus, type ShareStatus } from '#lib/share.js';
	import Icon from './Icon.svelte';

	let { pb, projectId }: { pb: PocketBase; projectId: string } = $props();

	let open = $state(false);
	let status = $state<ShareStatus | null>(null);
	let link = $state<string | null>(null);
	let busy = $state(false);
	let msg = $state('');

	async function run(fn: () => Promise<void>) {
		busy = true;
		msg = '';
		try {
			await fn();
		} catch (e) {
			msg = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	const load = () => run(async () => void (status = await shareStatus(pb, projectId)));

	function toggle() {
		open = !open;
		if (open && !status) void load();
	}

	const make = () =>
		run(async () => {
			link = shareLink(await createShare(pb, projectId));
			status = { active: true };
			await copy();
		});

	const revoke = () =>
		run(async () => {
			await revokeShare(pb, projectId);
			link = null;
			status = { active: false };
			msg = 'Ο σύνδεσμος ανακλήθηκε.';
		});

	async function copy() {
		if (!link) return;
		try {
			await navigator.clipboard.writeText(link);
			msg = 'Αντιγράφηκε ✓';
		} catch {
			msg = 'Αντέγραψε τον σύνδεσμο από το πεδίο.';
		}
	}
</script>

<div class="share">
	<button type="button" class="btn ghost" aria-haspopup="dialog" aria-expanded={open} onclick={toggle} title="Κοινοποίηση">
		<Icon name="open" size={15} /> <span class="lbl">Κοινοποίηση</span>
	</button>
	{#if open}
		<div class="scrim" role="presentation" onpointerdown={() => (open = false)}></div>
		<div class="pop" role="dialog" aria-label="Κοινοποίηση">
			<p class="head">Σύνδεσμος μόνο για προβολή</p>
			<p class="hint">Όποιος έχει τον σύνδεσμο βλέπει αυτό το board χωρίς λογαριασμό. Δεν μπορεί να αλλάξει τίποτα.</p>
			{#if link}
				<div class="row">
					<input readonly value={link} aria-label="Σύνδεσμος" onfocus={(e) => e.currentTarget.select()} />
					<button type="button" class="btn" onclick={copy}><Icon name="copy" size={14} /> Αντιγραφή</button>
				</div>
			{:else if status?.active}
				<p class="hint">Υπάρχει ενεργός σύνδεσμος. Για να τον αντιγράψεις ξανά, φτιάξε νέο (ο παλιός σταματά).</p>
			{/if}
			<div class="row">
				{#if status === null && !busy}
					<button type="button" class="btn" onclick={load}>Δοκίμασε ξανά</button>
				{:else if status === null}
					<span class="hint">Φόρτωση…</span>
				{:else}
					<button type="button" class="btn primary" disabled={busy} onclick={make}>
						{status.active ? 'Νέος σύνδεσμος' : 'Δημιουργία συνδέσμου'}
					</button>
					{#if status.active}
						<button type="button" class="btn ghost danger" disabled={busy} onclick={revoke}>Ανάκληση</button>
					{/if}
				{/if}
			</div>
			{#if msg}<p class="msg" role="status">{msg}</p>{/if}
		</div>
	{/if}
</div>

<style>
	.share {
		position: relative;
	}
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 30;
	}
	.pop {
		position: absolute;
		right: 0;
		top: calc(100% + 8px);
		z-index: 31;
		width: min(360px, calc(100vw - 32px));
		padding: 14px;
		background: var(--raised);
		border-radius: var(--r-panel);
		box-shadow: 0 12px 32px -12px rgb(0 0 0 / 0.3), 0 0 0 1px var(--line);
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.head {
		margin: 0;
		font-size: 12.5px;
		font-weight: 600;
		color: var(--muted);
	}
	.hint,
	.msg {
		margin: 0;
		font-size: 12.5px;
		color: var(--muted);
	}
	.msg {
		color: var(--text);
	}
	.row {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	input {
		flex: 1;
		min-width: 0;
		font: inherit;
		font-size: 12.5px;
		padding: 6px 8px;
		border: 1px solid var(--line-strong);
		border-radius: var(--r-ctl);
		background: var(--surface);
		color: var(--text);
	}
	.danger {
		color: var(--accent);
	}
	@media (max-width: 900px) {
		.lbl {
			display: none;
		}
	}
	@media (max-width: 640px) {
		.pop {
			position: fixed;
			top: 64px;
			left: 16px;
			right: 16px;
			width: auto;
		}
	}
</style>
