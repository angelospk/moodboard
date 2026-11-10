<script lang="ts">
	import favicon from '#lib/assets/favicon.svg';
	import { invalidate } from '$app/navigation';
	import { onMount } from 'svelte';
	import type { LayoutProps } from './$types';
	import '#lib/app.css';

	let { children, data }: LayoutProps = $props();

	onMount(() => {
		const { data: sub } = data.supabase.auth.onAuthStateChange((_event, s) => {
			if (s?.expires_at !== data.session?.expires_at) invalidate('supabase:auth');
		});
		return () => sub.subscription.unsubscribe();
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Moodboard</title>
</svelte:head>

{@render children()}
