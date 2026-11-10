<script lang="ts">
	// CONTRACT (fixed). Inline editor for one inspiration with autosave (see DESIGN.md "Inspiration panel").
	import type { SupabaseClient } from '@supabase/supabase-js';
	import type { Inspiration, Project } from '#lib/types.js';
	interface Props {
		supabase: SupabaseClient;
		userId: string;
		item: Inspiration;
		imageUrl: string | null;
		projects: Project[];
		/** Past tags for one-click chips. */
		suggestions: string[];
		/** Focus the note on open (e.g. right after a new image was added). */
		focusNote?: boolean;
		/** After each successful autosave, with the saved row. */
		onsaved: (item: Inspiration) => void;
		/** After a successful copy. */
		oncopied: (projectName: string | null) => void;
		/** After a successful delete. */
		ondeleted: (id: string) => void;
		onclose: () => void;
		/** Undefined hides the arrow. */
		onprev?: () => void;
		onnext?: () => void;
	}
	let { item, onclose }: Props = $props();
</script>

<aside><button type="button" onclick={onclose}>×</button>{item.note}</aside>
