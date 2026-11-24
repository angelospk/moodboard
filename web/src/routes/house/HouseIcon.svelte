<script lang="ts" module>
	// The 3D editor's icons, same stroke set as the board's (1.5px, 16px grid, round caps).
	const PATHS = {
		select: 'M3.5 2.5l8.5 4-3.7 1.4-1.4 3.7z',
		paint: 'M8 2.5c2.5 3 4 5 4 6.8a4 4 0 0 1-8 0c0-1.8 1.5-3.8 4-6.8z',
		wall: 'M2.5 13.5V2.5h11M5 13.5V5h8.5',
		slab: 'M4.5 5h9l-2 6h-9z',
		window: 'M3 3h10v10H3zM8 3v10M3 8h10',
		door: 'M4 13.5V2.5h8v11M2.5 13.5h11M9.6 8.2v.1',
		pool: 'M2.5 4h11v8h-11zM4.5 8.5c1-1 2-1 3 0s2 1 3 0 1.5-.6 2 0',
		box: 'M8 2.5l5 2.5v6L8 13.5 3 11V5zM3 5l5 2.5L13 5M8 7.5v6',
		undo: 'M5.5 3.5L3 6l2.5 2.5M3 6h6.5a3.5 3.5 0 0 1 0 7H7',
		redo: 'M10.5 3.5L13 6l-2.5 2.5M13 6H6.5a3.5 3.5 0 0 0 0 7H9',
		download: 'M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13.5h10',
		history: 'M8 2.5a5.5 5.5 0 1 1-5.2 3.7M2.5 2.5v3.7h3.7M8 5v3.2l2.2 1.4',
		fit: 'M2.5 6V3.5a1 1 0 0 1 1-1H6M10 2.5h2.5a1 1 0 0 1 1 1V6M13.5 10v2.5a1 1 0 0 1-1 1H10M6 13.5H3.5a1 1 0 0 1-1-1V10',
		trash: 'M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6',
		x: 'M4 4l8 8M12 4l-8 8',
		check: 'M3 8.5l3 3 7-7',
		chevronRight: 'M6 4l4 4-4 4',
		cube: 'M8 2.5l5 2.5v6L8 13.5 3 11V5zM3 5l5 2.5L13 5M8 7.5v6'
	} as const;
	export type HouseIconName = keyof typeof PATHS;
</script>

<script lang="ts">
	let { name, size = 18 }: { name: HouseIconName; size?: number } = $props();
</script>

<svg
	class="icon"
	width={size}
	height={size}
	viewBox="0 0 16 16"
	fill="none"
	stroke="currentColor"
	stroke-width="1.5"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
>
	<path d={PATHS[name]} />
</svg>

<style>
	.icon {
		flex: none;
		display: block;
	}
</style>
