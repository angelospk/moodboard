<script lang="ts" module>
	// One stroke set (1.5px, 16px grid, round caps) for the board's controls.
	const PATHS = {
		plus: 'M8 3v10M3 8h10',
		notes: 'M3 4h10M3 8h10M3 12h6',
		fit: 'M2.5 6V3.5a1 1 0 0 1 1-1H6M10 2.5h2.5a1 1 0 0 1 1 1V6M13.5 10v2.5a1 1 0 0 1-1 1H10M6 13.5H3.5a1 1 0 0 1-1-1V10',
		layout: 'M2.5 3h4.5v4.5H2.5zM9.5 3h4v3h-4zM9.5 8.5h4v4.5h-4zM2.5 10h4.5v3H2.5z',
		chevronDown: 'M4 6l4 4 4-4',
		chevronRight: 'M6 4l4 4-4 4',
		chevronLeft: 'M10 4L6 8l4 4',
		search: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM10.6 10.6L14 14',
		filter: 'M2.5 4.5h11M4.5 8h7M6.5 11.5h3',
		image: 'M2.5 3.5h11v9h-11zM2.5 10.5l3-3 3 3 2-2 3 3M10.5 6.2a.7.7 0 1 0 0-.01',
		paste: 'M5.5 3H4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1h-1.5M5.5 2h5v2.5h-5z',
		copy: 'M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3',
		open: 'M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3',
		trash: 'M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6',
		x: 'M4 4l8 8M12 4l-8 8',
		check: 'M3 8.5l3 3 7-7',
		upload: 'M8 11V3M4.5 6.5L8 3l3.5 3.5M3 13h10',
		contrast: 'M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 0 0 0-11zM8 2.5v11M8 5h3.8M8 8h5.5M8 11h3.8'
	} as const;
	export type IconName = keyof typeof PATHS;
</script>

<script lang="ts">
	let { name, size = 16 }: { name: IconName; size?: number } = $props();
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
