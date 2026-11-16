<script lang="ts">
	// Unknown address or a failed load: a page in the app's language with a way home (QA 2026-11-15 F7).
	import { page } from '$app/state';
	import { t } from '#lib/i18n.js';
</script>

<svelte:head><title>{page.status} · Moodboard</title></svelte:head>

<main class="error-page">
	<h1>{page.status === 404 ? t('error.notFound') : t('error.generic')}</h1>
	<a class="btn" href="/">{t('error.home')}</a>
</main>

<style>
	.error-page {
		display: grid;
		justify-items: center;
		gap: 16px;
		padding: 20vh 16px;
		text-align: center;
	}
	h1 {
		font-family: var(--font-serif);
		font-weight: 500;
		font-size: 1.4rem;
		margin: 0;
	}
</style>
