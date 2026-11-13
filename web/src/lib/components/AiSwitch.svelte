<script lang="ts">
	import { t } from '#lib/i18n.js';
	import { untrack } from 'svelte';
	import type PocketBase from 'pocketbase';
	import { setAiEnabled } from '#lib/suggest.js';

	let { pb }: { pb: PocketBase } = $props();

	let on = $state(untrack(() => !!pb.authStore.record?.ai_enabled));
	let busy = $state(false);
	let failed = $state(false);

	async function toggle() {
		const next = !on;
		const id = pb.authStore.record?.id;
		if (busy || !id) return;
		// Turning it on sends images to Google: ask once, in plain words.
		if (next && !confirm(t('ai.consent'))) return;
		busy = true;
		failed = false;
		try {
			await setAiEnabled(pb, id, next);
			on = next;
		} catch {
			failed = true;
		} finally {
			busy = false;
		}
	}
</script>

<button
	class="btn"
	class:primary={on}
	type="button"
	role="switch"
	aria-checked={on}
	disabled={busy}
	title={failed ? t('ai.failed') : t('ai.title')}
	onclick={toggle}
>
	✦ {t('ai.label')}: {on ? t('ai.on') : t('ai.off')}
</button>
