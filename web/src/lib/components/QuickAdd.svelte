<script lang="ts">
	// STUB: worker B implements. Contract below is fixed.
	import type { SupabaseClient } from '@supabase/supabase-js';
	import type { Project } from '#lib/types.js';
	interface Props {
		supabase: SupabaseClient;
		userId: string;
		projects: Project[];
		/** Image to preload (e.g. pasted on the map). */
		file?: File | null;
		/** Tags to preselect (e.g. the tag whose "+" was clicked). */
		tags?: string[];
		/** Project to preselect; null = no project. */
		projectId?: string | null;
		/** Past tags for one-click chips. */
		suggestions?: string[];
		onclose: () => void;
		/** Called after a successful save with the new inspiration id. */
		onsaved: (id: string) => void;
	}
	let { onclose }: Props = $props();
</script>

<dialog open><button type="button" onclick={onclose}>×</button></dialog>
