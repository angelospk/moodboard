<script lang="ts">
	import favicon from '#lib/assets/favicon.svg';
	import { invalidate } from '$app/navigation';
	import { onMount } from 'svelte';
	import type { LayoutProps } from './$types';
	import '#lib/app.css';

	let { children, data }: LayoutProps = $props();

	onMount(() => {
		// Signing in or out must re-run the page loads. A token-only refresh (the layout load's own
		// authRefresh) keeps the same record, so it must not invalidate: that would loop forever.
		let uid = data.pb.authStore.record?.id ?? null;
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

{@render children()}
