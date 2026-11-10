<script lang="ts">
	// CONTRACT (fixed). One row per region: number, note input, 5 rating squares (click again clears), delete.
	import type { Region } from '#lib/types.js';
	interface Props {
		/** Bindable. Always assign a new array. */
		regions: Region[];
		/** Bindable highlighted index, shared with RegionEditor. */
		active?: number | null;
	}
	let { regions = $bindable([]), active = $bindable(null) }: Props = $props();
</script>

<ol>{#each regions as r, i (i)}<li>{i + 1}. {r.note}</li>{/each}</ol>
