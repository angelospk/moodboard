<script lang="ts">
	// Full-screen view of one image, with a crop tool. The crop is only a rectangle stored on the row
	// (fractions of the image); the file stays whole, and cards on the map show just that part.
	import type { Crop } from '#lib/types.js';
	interface Props {
		src: string | null;
		alt?: string;
		/** Page the image came from (shown as a link). */
		sourceUrl?: string | null;
		crop: Crop | null;
		/** Save a new crop (null = whole image). */
		oncrop: (crop: Crop | null) => void;
		onclose: () => void;
		/** Undefined hides the arrow. */
		onprev?: () => void;
		onnext?: () => void;
	}
	let { src, alt = '', sourceUrl = null, crop, oncrop, onclose, onprev, onnext }: Props = $props();

	const MIN = 0.02;
	type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se' | 'new';

	let editing = $state(false);
	let box = $state<Crop>({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
	let stage = $state<HTMLDivElement | null>(null);
	let closeBtn = $state<HTMLButtonElement | null>(null);
	let drag: { handle: Handle; id: number; start: { x: number; y: number }; from: Crop } | null = null;

	// A new image (←/→) leaves crop mode.
	let shown = '';
	$effect(() => {
		if (src !== shown) {
			shown = src ?? '';
			editing = false;
		}
	});

	$effect(() => {
		closeBtn?.focus();
	});

	const host = $derived.by(() => {
		try {
			return sourceUrl ? new URL(sourceUrl).hostname.replace(/^www\./, '') : '';
		} catch {
			return '';
		}
	});

	function startCrop() {
		box = crop ? { ...crop } : { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
		editing = true;
	}

	function save() {
		const full = box.x <= 0.001 && box.y <= 0.001 && box.w >= 0.998 && box.h >= 0.998;
		oncrop(full ? null : round(box));
		editing = false;
	}

	const round = (c: Crop): Crop => {
		const r = (v: number) => Math.round(v * 10000) / 10000;
		const x = r(c.x), y = r(c.y);
		return { x, y, w: Math.min(r(c.w), 1 - x), h: Math.min(r(c.h), 1 - y) };
	};

	const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

	function point(e: PointerEvent) {
		const r = stage!.getBoundingClientRect();
		return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
	}

	function down(e: PointerEvent, handle: Handle) {
		if (!editing || !stage || drag) return;
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		const p = point(e);
		drag = { handle, id: e.pointerId, start: p, from: handle === 'new' ? { ...p, w: 0, h: 0 } : { ...box } };
		if (handle === 'new') box = { ...p, w: 0, h: 0 };
		stage.setPointerCapture(e.pointerId);
	}

	function move(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.id) return;
		const p = point(e);
		const f = drag.from;
		const dx = p.x - drag.start.x;
		const dy = p.y - drag.start.y;
		if (drag.handle === 'new') {
			box = { x: Math.min(f.x, p.x), y: Math.min(f.y, p.y), w: Math.abs(p.x - f.x), h: Math.abs(p.y - f.y) };
			return;
		}
		if (drag.handle === 'move') {
			box = { ...f, x: clamp(f.x + dx, 0, 1 - f.w), y: clamp(f.y + dy, 0, 1 - f.h) };
			return;
		}
		let { x, y, w, h } = f;
		const hd = drag.handle;
		if (hd.includes('w')) {
			const nx = clamp(f.x + dx, 0, f.x + f.w - MIN);
			w = f.w + (f.x - nx);
			x = nx;
		}
		if (hd.includes('e')) w = clamp(f.w + dx, MIN, 1 - f.x);
		if (hd.includes('n')) {
			const ny = clamp(f.y + dy, 0, f.y + f.h - MIN);
			h = f.h + (f.y - ny);
			y = ny;
		}
		if (hd.includes('s')) h = clamp(f.h + dy, MIN, 1 - f.y);
		box = { x, y, w, h };
	}

	function up(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.id) return;
		if (stage?.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
		// A tap instead of a drag on empty space keeps the old frame.
		if (drag.handle === 'new' && (box.w < MIN || box.h < MIN)) box = drag.from.w ? drag.from : { ...(crop ?? { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }) };
		drag = null;
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			if (editing) editing = false;
			else onclose();
		} else if (editing && e.key === 'Enter') {
			e.preventDefault();
			save();
		} else if (!editing && e.code === 'KeyC' && !e.metaKey && !e.ctrlKey && !e.altKey) {
			// e.code, so it also works with a Greek keyboard layout.
			e.preventDefault();
			startCrop();
		} else if (!editing && e.key === 'ArrowLeft' && onprev) {
			e.preventDefault();
			onprev();
		} else if (!editing && e.key === 'ArrowRight' && onnext) {
			e.preventDefault();
			onnext();
		}
	}

	const pc = (v: number) => `${v * 100}%`;
	const rect = (c: Crop) => `left:${pc(c.x)};top:${pc(c.y)};width:${pc(c.w)};height:${pc(c.h)}`;
	const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
</script>

<svelte:window onkeydown={onKey} />

<div class="viewer" role="dialog" aria-modal="true" aria-label="Πλήρης οθόνη">
	<header>
		<div class="meta">
			{#if host}
				<a href={sourceUrl} target="_blank" rel="noopener noreferrer" title={sourceUrl}>{host}<svg class="ext" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.5h7v7M12.5 3.5l-9 9" /></svg></a>
			{/if}
		</div>
		<div class="tools">
			{#if !editing}
				<button type="button" class="tool" title="Περικοπή (C)" onclick={startCrop} disabled={!src}>
					<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5v10.5h10.5M1.5 4h10.5v10.5" /></svg>
					Περικοπή
				</button>
			{/if}
			<button type="button" class="tool icon" aria-label="Κλείσιμο" title="Κλείσιμο (Esc)" onclick={onclose} bind:this={closeBtn}>
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
			</button>
		</div>
	</header>

	<div class="frame">
		{#if onprev && !editing}
			<button type="button" class="nav prev" aria-label="Προηγούμενη" title="Προηγούμενη (←)" onclick={onprev}>
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5" /></svg>
			</button>
		{/if}

		{#if src}
			<div
				class="stage"
				class:editing
				bind:this={stage}
				onpointerdown={(e) => down(e, 'new')}
				onpointermove={move}
				onpointerup={up}
				onpointercancel={up}
				role="presentation"
			>
				<img {src} {alt} draggable="false" />
				{#if editing}
					<div class="crop" style={rect(box)} onpointerdown={(e) => down(e, 'move')} role="presentation">
						<span class="third v1"></span><span class="third v2"></span>
						<span class="third h1"></span><span class="third h2"></span>
						{#each HANDLES as h (h)}
							<span class="handle {h}" onpointerdown={(e) => down(e, h)} role="presentation"></span>
						{/each}
					</div>
				{:else if crop}
					<div class="outline" style={rect(crop)} aria-hidden="true"></div>
				{/if}
			</div>
		{:else}
			<p class="missing">Η εικόνα δεν είναι διαθέσιμη.</p>
		{/if}

		{#if onnext && !editing}
			<button type="button" class="nav next" aria-label="Επόμενη" title="Επόμενη (→)" onclick={onnext}>
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" /></svg>
			</button>
		{/if}
	</div>

	<footer>
		{#if editing}
			<p class="hint">Σύρε τις λαβές ή ζωγράφισε νέο πλαίσιο. Στον χάρτη θα φαίνεται μόνο αυτό το κομμάτι.</p>
			<div class="actions">
				<button type="button" class="tool" onclick={() => ((box = { x: 0, y: 0, w: 1, h: 1 }), save())}>Χωρίς περικοπή</button>
				<button type="button" class="tool" onclick={() => (editing = false)}>Άκυρο</button>
				<button type="button" class="tool primary" onclick={save}>Αποθήκευση <span class="kbd">↵</span></button>
			</div>
		{:else if crop}
			<p class="hint">Η διακεκομμένη γραμμή δείχνει τι φαίνεται στον χάρτη.</p>
		{/if}
	</footer>
</div>

<style>
	/* Always dark: a photo reads best on a near-black ground, whatever the app theme. */
	.viewer {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: grid;
		grid-template-rows: auto 1fr auto;
		background: rgb(12 11 10 / 0.94);
		color: rgb(236 232 224);
		color-scheme: dark;
		animation: fade 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	@keyframes fade {
		from { opacity: 0; }
	}
	header,
	footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 16px;
		min-height: 56px;
	}
	.meta a {
		color: rgb(236 232 224 / 0.75);
		font-size: 13px;
		text-decoration: none;
	}
	.meta .ext {
		width: 11px;
		height: 11px;
		margin-left: 5px;
		vertical-align: -1px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
	}
	.meta a:hover {
		color: rgb(236 232 224);
		text-decoration: underline;
	}
	.tools,
	.actions {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.tool {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 36px;
		padding: 0 14px;
		border-radius: var(--r-ctl);
		border: 1px solid rgb(255 255 255 / 0.16);
		background: rgb(255 255 255 / 0.06);
		color: inherit;
		font: inherit;
		font-size: 14px;
		cursor: pointer;
		transition: background 150ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.tool:hover:not(:disabled) {
		background: rgb(255 255 255 / 0.14);
	}
	.tool:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.tool.icon {
		width: 36px;
		padding: 0;
		justify-content: center;
	}
	.tool.primary {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
	}
	.tool.primary:hover {
		background: var(--accent);
		filter: brightness(1.08);
	}
	.tool svg,
	.nav svg {
		width: 16px;
		height: 16px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.kbd {
		font-size: 12px;
		opacity: 0.8;
	}
	.frame {
		position: relative;
		display: grid;
		place-items: center;
		min-height: 0;
		padding: 0 64px;
	}
	.stage {
		position: relative;
		line-height: 0;
		touch-action: none;
		user-select: none;
	}
	.stage img {
		display: block;
		max-width: calc(100vw - 128px);
		max-height: calc(100vh - 136px);
		object-fit: contain;
		border-radius: var(--r-img);
	}
	.stage.editing {
		cursor: crosshair;
		overflow: hidden;
	}
	.outline {
		position: absolute;
		border: 1.5px dashed rgb(255 255 255 / 0.85);
		box-shadow: 0 0 0 1px rgb(0 0 0 / 0.4);
		pointer-events: none;
	}
	.crop {
		position: absolute;
		cursor: move;
		outline: 1.5px solid #fff;
		/* Dim everything outside the frame. */
		box-shadow: 0 0 0 9999px rgb(0 0 0 / 0.58);
	}
	.third {
		position: absolute;
		background: rgb(255 255 255 / 0.35);
		pointer-events: none;
	}
	.third.v1, .third.v2 { top: 0; bottom: 0; width: 1px; }
	.third.v1 { left: 33.333%; }
	.third.v2 { left: 66.666%; }
	.third.h1, .third.h2 { left: 0; right: 0; height: 1px; }
	.third.h1 { top: 33.333%; }
	.third.h2 { top: 66.666%; }
	/* 32px hit area, 12px visible mark. */
	.handle {
		position: absolute;
		width: 32px;
		height: 32px;
		margin: -16px 0 0 -16px;
	}
	.handle::after {
		content: '';
		position: absolute;
		inset: 10px;
		background: #fff;
		border-radius: 2px;
		box-shadow: 0 0 0 1px rgb(0 0 0 / 0.35);
	}
	.handle.nw { left: 0; top: 0; cursor: nwse-resize; }
	.handle.n { left: 50%; top: 0; cursor: ns-resize; }
	.handle.ne { left: 100%; top: 0; cursor: nesw-resize; }
	.handle.e { left: 100%; top: 50%; cursor: ew-resize; }
	.handle.se { left: 100%; top: 100%; cursor: nwse-resize; }
	.handle.s { left: 50%; top: 100%; cursor: ns-resize; }
	.handle.sw { left: 0; top: 100%; cursor: nesw-resize; }
	.handle.w { left: 0; top: 50%; cursor: ew-resize; }
	.handle.n::after, .handle.s::after { inset: 13px 8px; }
	.handle.e::after, .handle.w::after { inset: 8px 13px; }
	.nav {
		position: absolute;
		top: 50%;
		transform: translateY(-50%);
		width: 44px;
		height: 44px;
		border-radius: var(--r-pill);
		border: 1px solid rgb(255 255 255 / 0.16);
		background: rgb(255 255 255 / 0.06);
		color: inherit;
		display: grid;
		place-items: center;
		cursor: pointer;
	}
	.nav:hover {
		background: rgb(255 255 255 / 0.14);
	}
	.nav.prev { left: 12px; }
	.nav.next { right: 12px; }
	.hint {
		margin: 0;
		font-size: 13px;
		color: rgb(236 232 224 / 0.7);
	}
	footer:empty {
		min-height: 0;
		padding: 0;
	}
	.missing {
		color: rgb(236 232 224 / 0.7);
	}
	@media (max-width: 640px) {
		.frame { padding: 0 8px; }
		.stage img { max-width: calc(100vw - 16px); max-height: calc(100vh - 180px); }
		.nav { display: none; }
		footer { flex-direction: column; align-items: stretch; }
		.actions { justify-content: flex-end; flex-wrap: wrap; }
	}
	@media (prefers-reduced-motion: reduce) {
		.viewer { animation: none; }
	}
</style>
