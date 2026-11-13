<script lang="ts">
	import { t } from '#lib/i18n.js';
	import type PocketBase from 'pocketbase';
	import { embedStatus, type EmbedStatus } from '#lib/semantic.js';
	import { setSmart, smart } from '#lib/smart.svelte.js';

	// The user's consent for smart search: all their images (old ones too) go once to the AI to get
	// an embedding. While it runs in the background, the button shows how far it is.
	let { pb }: { pb: PocketBase } = $props();

	let busy = $state(false);
	let failed = $state(false);
	let status = $state<EmbedStatus | null>(null);
	const on = $derived(smart.embed);

	async function toggle() {
		if (busy) return;
		busy = true;
		failed = false;
		try {
			// Turning it on sends every image to Google: setSmart asks once, in plain words.
			await setSmart('embed', !on);
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
