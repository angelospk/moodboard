<script lang="ts">
	import { t } from '#lib/i18n.js';
	import Editor from './Editor.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head><title>{t('house.title')} · {data.project.name || 'Moodboard'}</title></svelte:head>

{#key `${data.userId}:${data.project.id}`}
	<Editor {data} />
{/key}
