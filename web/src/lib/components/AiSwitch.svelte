<script lang="ts">
	import { t } from '#lib/i18n.js';
	import { setSmart, smart } from '#lib/smart.svelte.js';

	let busy = $state(false);
	let failed = $state(false);

	async function toggle() {
		if (busy) return;
		busy = true;
		failed = false;
		try {
			// Turning it on sends images to Google: setSmart asks once, in plain words.
			await setSmart('ai', !smart.ai);
		} catch {
			failed = true;
		} finally {
			busy = false;
		}
	}
</script>

<button
	class="btn"
	class:primary={smart.ai}
	type="button"
	role="switch"
	aria-checked={smart.ai}
	disabled={busy}
	title={failed ? t('ai.failed') : t('ai.title')}
	onclick={toggle}
>
	✦ {t('ai.label')}: {smart.ai ? t('ai.on') : t('ai.off')}
</button>
