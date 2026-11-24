<script lang="ts">
	// An image that shows only its crop (see crop.ts). 'natural': the frame takes the crop's shape and the
	// parent sets one side (width or height). 'cover': the frame fills a box the parent sizes, like
	// object-fit: cover, so square tiles and collage cells show the kept part only.
	import type { Crop } from '#lib/types.js';
	import { cropAspect, placementStyle, validCrop } from '#lib/crop.js';

	interface Props {
		src: string;
		crop: Crop | null | undefined;
		fit?: 'natural' | 'cover';
		alt?: string;
		class?: string;
	}
	let { src, crop, fit = 'natural', alt = '', class: cls = '' }: Props = $props();

	const c = $derived(validCrop(crop));
	let imageAspect = $state(0);
	const ratio = $derived(cropAspect(c, imageAspect));

	function measure(el: HTMLImageElement) {
		const done = () => {
			if (el.naturalWidth && el.naturalHeight) imageAspect = el.naturalWidth / el.naturalHeight;
		};
		if (el.complete) done();
		el.addEventListener('load', done);
		return () => el.removeEventListener('load', done);
	}
</script>

{#if c}
	<span class={['ci', fit, cls]} style:--r={ratio}>
		<span class="frame">
			<img {src} {alt} loading="lazy" decoding="async" draggable="false" style={placementStyle(c)} {@attach measure} />
		</span>
	</span>
{:else}
	<img class={['plain', fit, cls]} {src} {alt} loading="lazy" decoding="async" draggable="false" />
{/if}

<style>
	.plain {
		display: block;
		width: 100%;
		height: auto;
	}
	.plain.cover {
		height: 100%;
		object-fit: cover;
	}
	/* The box is a size container; the crop frame covers it, centred. In 'natural' mode the box already has
	   the crop's shape, so the frame matches it exactly; a parent that clamps a side still gets no stretch. */
	.ci {
		position: relative;
		display: block;
		overflow: hidden;
		container-type: size;
	}
	.ci.natural {
		aspect-ratio: var(--r);
		width: 100%;
	}
	.ci.cover {
		width: 100%;
		height: 100%;
	}
	.frame {
		position: absolute;
		left: 50%;
		top: 50%;
		width: max(100cqw, 100cqh * var(--r));
		aspect-ratio: var(--r);
		translate: -50% -50%;
		overflow: hidden;
	}
	.frame img {
		position: absolute;
		max-width: none;
		max-height: none;
		display: block;
	}
</style>
