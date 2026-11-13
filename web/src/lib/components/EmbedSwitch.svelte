<script lang="ts">
	import { t } from '#lib/i18n.js';
	import type PocketBase from 'pocketbase';
	import { embedStatus, setEmbedEnabled, type EmbedStatus } from '#lib/semantic.js';

	// The user's consent for smart search: all their images (old ones too) go once to the AI to get
	// an embedding. While it runs in the background, the button shows how far it is.
	let { pb, on = $bindable(false) }: { pb: PocketBase; on?: boolean } = $props();

	let busy = $state(false);
	let failed = $state(false);
	let status = $state<EmbedStatus | null>(null);

	async function toggle() {
		const next = !on;
		const id = pb.authStore.record?.id;
		if (busy || !id) return;
		// Turning it on sends every image to Google: ask once, in plain words.
		if (next && !confirm(t('embed.consent'))) return;
		busy = true;
		failed = false;
		try {
			await setEmbedEnabled(pb, id, next);
			on = next;
		} catch {
			failed = true;
		} finally {
			busy = false;
		}
	}

	// Poll the progress every few seconds while images are still being analysed.
	$effect(() => {
		if (!on) {
			status = null;
			return;
		}
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const tick = async () => {
			try {
				status = await embedStatus(pb);
			} catch {
				status = null;
			}
			if (!stopped && status?.enabled && status.embedded < status.total) timer = setTimeout(tick, 6000);
		};
		void tick();
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	});

	const running = $derived(on && status?.enabled && status.embedded < status.total ? status : null);
</script>

<button
	class="btn"
	class:primary={on}
	type="button"
	role="switch"
	aria-checked={on}
	disabled={busy}
	title={failed ? t('ai.failed') : t('embed.title')}
	onclick={toggle}
>
	⌕ {t('embed.label')}: {on ? t('ai.on') : t('ai.off')}
</button>
{#if running}
	<span class="prog" aria-live="polite">{t('embed.progress', { done: running.embedded, total: running.total })}</span>
{/if}

<style>
	.prog {
		font-size: 0.78rem;
		color: var(--muted);
		white-space: nowrap;
	}
</style>
