<script lang="ts">
	// CONTRACT (fixed). Image shown whole with numbered region boxes; drag on the image draws a new region.
	import type { Region } from '#lib/types.js';
	import { regionFromStroke, svgPoints, type Pt } from '#lib/shape.js';
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

	/** A box smaller than this (fraction of the image) on either side is a tap, not a region. */
	const MIN = 0.02;

	type Box = Pick<Region, 'x' | 'y' | 'w' | 'h'>;

	let stage = $state<HTMLDivElement | null>(null);
	let draft = $state<Box | null>(null);
	/** 'box' = drag a rectangle; 'free' = draw any outline around what matters. */
	let tool = $state<'box' | 'free'>('box');
	let stroke = $state<Pt[]>([]);
	let origin = { x: 0, y: 0 };
	let pointerId: number | null = null;

	function clamp01(v: number) {
		return Math.min(Math.max(v, 0), 1);
	}

	function point(e: PointerEvent) {
		const box = stage!.getBoundingClientRect();
		return { x: clamp01((e.clientX - box.left) / box.width), y: clamp01((e.clientY - box.top) / box.height) };
	}

	function onDown(e: PointerEvent) {
		if (!editable || !stage || pointerId !== null) return;
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		pointerId = e.pointerId;
		origin = point(e);
		if (tool === 'free') stroke = [[origin.x, origin.y]];
		draft = { ...origin, w: 0, h: 0 };
		stage.setPointerCapture(e.pointerId);
		e.preventDefault();
	}

	function onMove(e: PointerEvent) {
		if (e.pointerId !== pointerId || !draft) return;
		const p = point(e);
		if (tool === 'free') {
			const last = stroke[stroke.length - 1];
			if (Math.hypot(p.x - last[0], p.y - last[1]) > 0.003) stroke = [...stroke, [p.x, p.y]];
			return;
		}
		draft = {
			x: Math.min(origin.x, p.x),
			y: Math.min(origin.y, p.y),
			w: Math.abs(p.x - origin.x),
			h: Math.abs(p.y - origin.y)
		};
	}

	function end(e: PointerEvent, keep: boolean) {
		if (e.pointerId !== pointerId) return;
		if (stage?.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
		pointerId = null;
		const d = draft;
		draft = null;
		if (tool === 'free') {
			const s = stroke;
			stroke = [];
			const r = keep ? regionFromStroke(s) : null;
			if (!r) return;
			regions = [...regions, r];
			active = regions.length - 1;
			return;
		}
		if (!keep || !d || d.w < MIN || d.h < MIN) return;
		// A new array, so bindable parents see the change.
		regions = [...regions, { ...d, note: '', rating: null }];
		active = regions.length - 1;
	}

	function onKey(e: KeyboardEvent) {
		// Esc cancels a draft. The event still propagates (the board uses Esc too).
		if (e.key !== 'Escape' || !draft) return;
		if (pointerId !== null && stage?.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId);
		pointerId = null;
		draft = null;
		stroke = [];
	}

	function pct(v: number) {
		return `${v * 100}%`;
	}
</script>

<svelte:window onkeydown={onKey} />

<div class="re">
	{#if src && editable}
		<div class="tools" role="group" aria-label="Εργαλείο σήμανσης">
			<button type="button" class:on={tool === 'box'} aria-pressed={tool === 'box'} onclick={() => (tool = 'box')}>
				<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="1" /></svg>
				Πλαίσιο
			</button>
			<button type="button" class:on={tool === 'free'} aria-pressed={tool === 'free'} onclick={() => (tool = 'free')}>
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 11c-1-4 2-8 6-8s5 3 3.5 6S6 14 3 11z" /></svg>
				Ελεύθερο
			</button>
		</div>
	{/if}
	{#if src}
		<div
			class={['stage', editable && 'editable', draft && 'drawing', active !== null && 'focus']}
			bind:this={stage}
			role="presentation"
			onpointerdown={onDown}
			onpointermove={onMove}
			onpointerup={(e) => end(e, true)}
			onpointercancel={(e) => end(e, false)}
			onlostpointercapture={(e) => end(e, true)}
		>
			<img {src} {alt} draggable="false" />

			{#each regions as r, i (i)}
				<div
					class={['box', active === i && 'on', r.points && 'shape']}
					style:left={pct(r.x)}
					style:top={pct(r.y)}
					style:width={pct(r.w)}
					style:height={pct(r.h)}
					role="presentation"
					onpointerenter={() => {
						if (!draft) active = i;
					}}
					onpointerleave={() => {
						if (!draft && active === i) active = null;
					}}
				>
					<span class="tag">
						<b>{i + 1}</b>
						{#if labels && r.note.trim()}<span class="note">{r.note}</span>{/if}
					</span>
				</div>
			{/each}

			<svg class="shapes" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
				{#each regions as r, i (i)}
					{#if r.points}<polygon points={svgPoints(r.points)} class:on={active === i} />{/if}
				{/each}
				{#if stroke.length > 1}<polyline points={svgPoints(stroke)} class="draft" />{/if}
			</svg>

			{#if draft && tool === 'box'}
				<div
					class={['box', 'draft', (draft.w < MIN || draft.h < MIN) && 'tiny']}
					style:left={pct(draft.x)}
					style:top={pct(draft.y)}
					style:width={pct(draft.w)}
					style:height={pct(draft.h)}
				></div>
			{/if}
		</div>
	{:else}
		<div class="missing">Η εικόνα δεν βρέθηκε.</div>
	{/if}
</div>

<style>
	/* Parents size the image with --re-max-h (default 70vh). */
	.re {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		width: 100%;
		min-width: 0;
	}

	.stage {
		position: relative;
		max-width: 100%;
		line-height: 0;
		overflow: hidden;
		border-radius: var(--r-img);
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
	}
	.stage.editable {
		cursor: crosshair;
		touch-action: none;
	}

	img {
		display: block;
		max-width: 100%;
		max-height: var(--re-max-h, 70vh);
		width: auto;
		height: auto;
		pointer-events: none;
	}

	.box {
		position: absolute;
		border: 1.5px solid var(--accent);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		border-radius: 2px;
		transition:
			box-shadow 180ms cubic-bezier(0.2, 0.8, 0.2, 1),
			border-width 180ms cubic-bezier(0.2, 0.8, 0.2, 1),
			background-color 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	/* The active box keeps the image clear inside it and dims everything around it. */
	.box.on {
		z-index: 1;
		border-width: 2.5px;
		background: transparent;
		box-shadow: 0 0 0 100vmax color-mix(in srgb, var(--scrim) 80%, transparent);
	}
	.stage.drawing .box:not(.draft) {
		pointer-events: none;
	}
	.tools {
		flex-basis: 100%;
		display: flex;
		gap: 4px;
		margin-bottom: 8px;
	}
	.tools button {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 10px;
		font-size: 12.5px;
		color: var(--muted);
	}
	.tools button.on {
		color: var(--text);
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 10%, var(--surface));
	}
	.tools svg {
		width: 14px;
		height: 14px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.5;
	}
	/* A freeform region: the polygon is the outline; its box only places the number and listens to the pointer. */
	.box.shape,
	.box.shape.on {
		border-color: transparent;
		background: transparent;
		box-shadow: none;
	}
	.shapes {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
	}
	.shapes polygon {
		fill: color-mix(in srgb, var(--accent) 10%, transparent);
		stroke: var(--accent);
		stroke-width: 1.5;
		vector-effect: non-scaling-stroke;
		stroke-linejoin: round;
		transition: fill 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.shapes polygon.on {
		fill: color-mix(in srgb, var(--accent) 24%, transparent);
		stroke-width: 2.5;
	}
	.shapes polyline.draft {
		fill: none;
		stroke: var(--accent);
		stroke-width: 2;
		stroke-dasharray: 5 4;
		vector-effect: non-scaling-stroke;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.stage.drawing .box.shape {
		pointer-events: none;
	}
	.box.draft {
		z-index: 2;
		border-style: dashed;
		background: color-mix(in srgb, var(--accent) 16%, transparent);
	}
	.box.draft.tiny {
		border-color: var(--faint);
	}

	.tag {
		position: absolute;
		left: -1.5px;
		top: -1.5px;
		display: flex;
		align-items: stretch;
		max-width: max(100%, 11rem);
		font: 600 11px/1 var(--font-sans);
		color: var(--on-accent);
		pointer-events: none;
	}
	.box.on .tag {
		left: -2.5px;
		top: -2.5px;
	}
	.tag b {
		flex: none;
		background: var(--accent);
		padding: 3px 5px;
		border-radius: 2px 0 2px 0;
		font-variant-numeric: tabular-nums;
	}
	.tag .note {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 500;
		padding: 3px 6px;
		background: color-mix(in srgb, var(--text) 78%, transparent);
		color: var(--bg);
		border-radius: 0 0 2px 0;
	}

	.missing {
		display: grid;
		place-items: center;
		width: 100%;
		min-height: 180px;
		border: 1px dashed var(--line-strong);
		border-radius: var(--r-img);
		color: var(--muted);
		font-size: 12.5px;
	}

	@media (prefers-reduced-motion: reduce) {
		.box {
			transition: none;
		}
	}
</style>
