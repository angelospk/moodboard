<script lang="ts">
	// CONTRACT (fixed). Image shown whole with numbered region boxes; drag on the image draws a new region.
	import type { Region } from '#lib/types.js';
	interface Props {
		src: string | null;
		/** Bindable. New regions are appended with note '' and rating null. */
		regions: Region[];
		/** false = view only (no drawing). Default true. */
		editable?: boolean;
		/** Bindable index of the highlighted region (hover/selection sync with RegionList). */
		active?: number | null;
		/** Show region notes as labels on the boxes. Default false. */
		labels?: boolean;
		alt?: string;
	}
	let { src, regions = $bindable([]), editable = true, active = $bindable(null), labels = false, alt = '' }: Props = $props();
</script>

{#if src}<img {src} {alt} />{/if}
