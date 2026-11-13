<script lang="ts">
	import favicon from '#lib/assets/favicon.svg';
	import { invalidate } from '$app/navigation';
	import { navigating } from '$app/state';
	import { t } from '#lib/i18n.js';
	import { onMount } from 'svelte';
	import type { LayoutProps } from './$types';
	import '#lib/app.css';

	let { children, data }: LayoutProps = $props();

	onMount(() => {
		// The first page is on screen: remove the boot screen of app.html.
		document.getElementById('boot')?.remove();
		// Signing in or out must re-run the page loads. A token-only refresh (the layout load's own
		// authRefresh) keeps the same record, so it must not invalidate: that would loop forever.
		// Start from the user the load saw: the background token check can sign them out before this runs.
		let uid = data.user?.id ?? null;
		if (uid !== (data.pb.authStore.record?.id ?? null)) {
			uid = data.pb.authStore.record?.id ?? null;
			void invalidate('app:auth');
		}
		return data.pb.authStore.onChange((_token, record) => {
			const next = record?.id ?? null;
			if (next === uid) return;
			uid = next;
			void invalidate('app:auth');
		});
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Moodboard</title>
</svelte:head>

{#if navigating.to}
	<div class="navbar" role="progressbar" aria-label={t('common.loading')}></div>
{/if}

{@render children()}

<style>
	/* A page change waits for its data: show that something happens. Hidden for the first 150 ms. */
	.navbar {
		position: fixed;
		inset: 0 0 auto 0;
		height: 3px;
		z-index: 1000;
		background: var(--accent);
		transform-origin: left;
		animation: nav-grow 8s cubic-bezier(0.1, 0.7, 0.2, 1) 0.15s both;
		pointer-events: none;
	}
	@keyframes nav-grow {
		from { transform: scaleX(0); }
		to { transform: scaleX(0.92); }
	}
	:global(html:has(.navbar)) { cursor: progress; }
</style>
