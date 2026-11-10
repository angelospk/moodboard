<script lang="ts" module>
	export interface Spot {
		/** World coordinates. */
		x: number;
		y: number;
		/** Tag of the zone under the spot, null outside zones. */
		zone: string | null;
	}

	export type Placement = { x?: number; y?: number; fx?: number | null; fy?: number | null };

	export type BoardContext =
		| { kind: 'card'; id: string; clientX: number; clientY: number }
		| { kind: 'canvas'; clientX: number; clientY: number; spot: Spot };
</script>

<script lang="ts">
	// The canvas: cards placed by d3-force around zone anchors, zone rects drawn around their cards,
	// pan / zoom / pinch, card drag (into another zone re-tags it), file drop and saved positions.
	// The simulation writes positions straight to the DOM on each tick; Svelte only renders the lists.
	import { onMount, tick, untrack } from 'svelte';
	import { forceSimulation, type Simulation } from 'd3-force';
	import type { SupabaseClient } from '@supabase/supabase-js';
	import type { Inspiration } from '#lib/types.js';
	import { savePositions } from '#lib/inspirations.js';
	import {
		anchorForce,
		CARD_GAP,
		groupKey,
		layoutTargets,
		rectCollide,
		ZONE_PAD,
		zoneBox,
		type CardNode,
		type Group,
		type ZoneColor
	} from './board.js';

	interface Props {
		supabase: SupabaseClient;
		/** The cards in view (already filtered by project and level). */
		items: Inspiration[];
		urlOf: (i: Inspiration) => string | null;
		colors: Map<string, ZoneColor>;
		size: number;
		notesOn: boolean;
		selectedId: string | null;
		/** Tag whose cards stay bright; the rest fade. */
		highlight: string | null;
		/** Ids that match the search; null = no search. */
		matches: Set<string> | null;
		/** Map scope of the loaded data ('all', 'none' or a project id) and its saved positions. */
		scope: string;
		seed: Record<string, { x: number; y: number }>;
		canSave: boolean;
		/** Screen px on the right covered by the panel (fit and centre avoid it). */
		rightInset: number;
		onselect: (id: string) => void;
		onbackground: () => void;
		oncontext: (c: BoardContext) => void;
		onfiles: (files: File[], spot: Spot) => void;
		/** Double-click on empty canvas: add an image there. */
		onpick: (spot: Spot) => void;
		/** A card was dropped inside another zone; `from` is where it was before the drag. */
		onrezone: (item: Inspiration, tag: string, from: Placement) => void;
		onzoneadd: (tag: string, spot: Spot) => void;
		ontoast: (msg: string) => void;
	}

	let {
		supabase,
		items,
		urlOf,
		colors,
		size,
		notesOn,
		selectedId,
		highlight,
		matches,
		scope,
		seed,
		canSave,
		rightInset,
		onselect,
		onbackground,
		oncontext,
		onfiles,
		onpick,
		onrezone,
		onzoneadd,
		ontoast
	}: Props = $props();

	const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
	const K_MIN = 0.15;
	const K_MAX = 4;
	/** Room the dock takes at the bottom of the canvas, screen px. */
	const DOCK_SPACE = 80;

	let stage = $state<HTMLDivElement | null>(null);
	let view = $state({ x: 0, y: 0, k: 1 });
	let nodes = $state.raw<CardNode[]>([]);
	let dropZone = $state<string | null>(null);
	let fileOver = $state(false);
	let panning = $state(false);

	let byId = new Map<string, CardNode>();
	let members = new Map<string, CardNode[]>();
	/** Target point per card id. */
	let anchors = new Map<string, { x: number; y: number }>();
	const zoneBoxes = new Map<string, { x: number; y: number; w: number; h: number }>();
	const nodeEls = new Map<string, HTMLElement>();
	const zoneEls = new Map<string, HTMLElement>();
	/** Last known position per node key; survives filter changes and reloads of the same map. */
	const mem = new Map<string, { x?: number; y?: number; fx?: number | null; fy?: number | null }>();
	let seededScope: string | null = null;
	let sim: Simulation<CardNode, undefined> | null = null;
	let ro: ResizeObserver | null = null;
	/** Fit to the cards once the layout settles, until the user moves the view. */
	let autoFit = true;
	let fitPending = true;
	let dragId: string | null = null;
	let reduced = false;

	const zones = $derived.by(() => {
		const count = new Map<string, number>();
		for (const n of nodes) if (n.zone !== null) count.set(n.zone, (count.get(n.zone) ?? 0) + 1);
		return [...count].map(([tag, n]) => ({ tag, count: n }));
	});

	// Region boxes need room to read; region notes appear when there is more.
	const cardWidth = $derived(size * view.k);
	const showBoxes = $derived(cardWidth >= 200);
	const showRegionNotes = $derived(cardWidth >= 360);

	/** Dot grid spacing on screen: 24px × zoom, doubled while it is too dense to read. */
	const grid = $derived.by(() => {
		let s = 24 * view.k;
		while (s < 12) s *= 2;
		return s;
	});

	// ------------------------------------------------------------------ Model

	function estimateH() {
		return Math.round(size * 0.78) + 12;
	}

	function groupsOf(list: CardNode[]): Group[] {
		const map = new Map<string, CardNode[]>();
		for (const n of list) {
			const k = groupKey(n.zone);
			const arr = map.get(k);
			if (arr) arr.push(n);
			else map.set(k, [n]);
		}
		const none = groupKey(null);
		return [...map]
			.map(([key, ns]) => ({ key, nodes: ns }))
			.sort((a, b) =>
				a.key === none ? 1 : b.key === none ? -1 : b.nodes.length - a.nodes.length || a.key.localeCompare(b.key)
			);
	}

	/** Shape of the visible canvas; zones are laid out in rows that match it. */
	function aspect() {
		const el = stage;
		if (!el || !el.clientHeight) return 1.6;
		return Math.max(200, el.clientWidth - rightInset) / Math.max(200, el.clientHeight - DOCK_SPACE);
	}
	let lastAspect = 1.6;

	function refreshAnchors() {
		lastAspect = aspect();
		anchors = layoutTargets(groupsOf(nodes), lastAspect);
	}

	/** The canvas changed shape a lot (rotation, window resize): lay the zones out for it. */
	function watchStage(el: HTMLElement) {
		const obs = new ResizeObserver(() => {
			const a = aspect();
			if (!nodes.length || Math.abs(Math.log(a / lastAspect)) < 0.25) return;
			refreshAnchors();
			// The layout changed under the view: fit to it again.
			autoFit = true;
			fitPending = true;
			reheat(0.5);
		});
		obs.observe(el);
		return () => obs.disconnect();
	}

	function rebuild(list: Inspiration[], loadedScope: string) {
		let fresh = false;
		if (seededScope !== loadedScope) {
			// Rows still waiting for the debounce belong to the map we are leaving.
			void flushSaves();
			fresh = true;
			seededScope = loadedScope;
			mem.clear();
			for (const [key, p] of Object.entries(seed ?? {})) {
				if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) mem.set(key, { x: p.x, y: p.y, fx: p.x, fy: p.y });
			}
		} else {
			for (const n of nodes) mem.set(n.id, { x: n.x, y: n.y, fx: n.fx, fy: n.fy });
		}

		const old = byId;
		const next: CardNode[] = list.map((item) => {
			const id = `i:${item.id}`;
			const prev = old.get(id);
			const m = mem.get(id);
			return {
				id,
				item,
				zone: item.tags?.[0] ?? null,
				w: prev?.w ?? size,
				h: prev?.h ?? estimateH(),
				x: m?.x,
				y: m?.y,
				vx: prev?.vx ?? 0,
				vy: prev?.vy ?? 0,
				fx: m?.fx ?? null,
				fy: m?.fy ?? null
			};
		});
		const added = next.some((n) => !old.has(n.id)) || next.length !== old.size;

		byId = new Map(next.map((n) => [n.id, n]));
		members = new Map();
		zoneBoxes.clear();
		for (const n of next) {
			if (n.zone === null) continue;
			const arr = members.get(n.zone);
			if (arr) arr.push(n);
			else members.set(n.zone, [n]);
		}
		lastAspect = aspect();
		anchors = layoutTargets(groupsOf(next), lastAspect);

		// New cards start on a small spiral around their anchor, so nothing is born far away.
		let k = 0;
		for (const n of next) {
			if (n.x != null && Number.isFinite(n.x) && n.y != null && Number.isFinite(n.y)) continue;
			const a = anchors.get(n.id) ?? { x: 0, y: 0 };
			const ang = k * 2.4;
			n.x = a.x + Math.cos(ang) * 6;
			n.y = a.y + Math.sin(ang) * 6;
			k++;
		}

		nodes = next;
		if (!next.length) {
			sim?.stop();
			return;
		}
		ensureSim(next);
		if (fresh) {
			autoFit = true;
			// Settle most of the layout before the first paint, then fit to it.
			sim!.stop();
			sim!.alpha(1);
			sim!.tick(next.length > 600 ? 60 : 160);
			void tick().then(() => {
				onTick();
				fit(false);
				fitPending = true;
				reheat(0.3);
			});
		} else {
			if (added) fitPending = true;
			reheat(0.5);
		}
	}

	function ensureSim(list: CardNode[]) {
		if (!sim) {
			sim = forceSimulation<CardNode>([])
				.alphaMin(0.004)
				.alphaDecay(0.045)
				.velocityDecay(0.45)
				.force(
					'anchor',
					anchorForce((n) => anchors.get(n.id))
				)
				.force(
					'collide',
					rectCollide(() => dragId)
				)
				.on('tick', onTick);
			sim.stop();
		}
		sim.nodes(list);
	}

	function reheat(alpha: number) {
		if (!sim || !nodes.length) return;
		if (reduced) {
			// No motion: jump straight to the settled layout.
			sim.stop();
			sim.alpha(Math.max(sim.alpha(), alpha));
			sim.tick(140);
			sim.alpha(0);
			onTick();
			if (fitPending && autoFit) {
				fitPending = false;
				fit(false);
			}
			return;
		}
		sim.alpha(Math.max(sim.alpha(), alpha)).restart();
	}

	function placeNode(n: CardNode, el: HTMLElement) {
		el.style.transform = `translate(${n.x ?? 0}px, ${n.y ?? 0}px) translate(-50%, -50%)`;
	}

	function drawZones() {
		for (const [tag, ms] of members) {
			const el = zoneEls.get(tag);
			const box = zoneBox(ms, dragId);
			if (box) zoneBoxes.set(tag, box);
			else zoneBoxes.delete(tag);
			if (!el) continue;
			if (!box) {
				el.style.display = 'none';
				continue;
			}
			el.style.display = '';
			el.style.transform = `translate(${box.x}px, ${box.y}px)`;
			el.style.width = `${box.w}px`;
			el.style.height = `${box.h}px`;
		}
	}

	function onTick() {
		for (const n of nodes) {
			const el = nodeEls.get(n.id);
			if (el) placeNode(n, el);
		}
		drawZones();
		if (fitPending && autoFit && sim && sim.alpha() < 0.06) {
			fitPending = false;
			fit(false);
		}
	}

	// ------------------------------------------------------- Element registry

	function onResize(entries: ResizeObserverEntry[]) {
		let changed = false;
		for (const e of entries) {
			const el = e.target as HTMLElement;
			const n = byId.get(el.dataset.id ?? '');
			if (!n) continue;
			const w = el.offsetWidth;
			const h = el.offsetHeight;
			if (!w || !h) continue;
			if (Math.abs(w - n.w) > 0.5 || Math.abs(h - n.h) > 0.5) {
				n.w = w;
				n.h = h;
				changed = true;
			}
		}
		if (changed) {
			refreshAnchors();
			drawZones();
			reheat(0.3);
		}
	}

	function registerCard(id: string) {
		return (el: HTMLElement) => {
			nodeEls.set(id, el);
			const n = byId.get(id);
			if (n) placeNode(n, el);
			ro ??= new ResizeObserver(onResize);
			ro.observe(el);
			return () => {
				ro?.unobserve(el);
				if (nodeEls.get(id) === el) nodeEls.delete(id);
			};
		};
	}

	function registerZone(tag: string) {
		return (el: HTMLElement) => {
			zoneEls.set(tag, el);
			drawZones();
			return () => {
				if (zoneEls.get(tag) === el) zoneEls.delete(tag);
			};
		};
	}

	/** Mark an image as loaded, so its placeholder shape goes away. */
	function imgReady(el: HTMLImageElement) {
		const done = () => (el.dataset.loaded = '1');
		if (el.complete && el.naturalWidth) done();
		el.addEventListener('load', done);
		return () => el.removeEventListener('load', done);
	}

	// Data or filters changed: rebuild the node list; positions live outside Svelte state.
	$effect(() => {
		const list = items;
		const sc = scope;
		untrack(() => rebuild(list, sc));
	});

	// A new card size changes every box before the observer reports it; nudge the layout.
	$effect(() => {
		const s = size;
		untrack(() => {
			for (const n of nodes) {
				const ratio = n.w ? n.h / n.w : 1;
				n.w = s;
				n.h = Math.round(s * ratio);
			}
			refreshAnchors();
			reheat(0.35);
		});
	});

	$effect(() => {
		notesOn;
		untrack(() => reheat(0.25));
	});

	// ---------------------------------------------------------- Pan and zoom

	function stageRect() {
		return stage?.getBoundingClientRect() ?? new DOMRect(0, 0, 1, 1);
	}

	/** Fit every card into the visible part of the canvas. `explicit` stops later automatic fits. */
	export function fit(explicit = true) {
		if (explicit) {
			autoFit = false;
			fitPending = false;
		}
		const el = stage;
		if (!el) return;
		const W = Math.max(200, el.clientWidth - rightInset);
		const H = Math.max(200, el.clientHeight - DOCK_SPACE);
		if (!nodes.length) {
			view = { x: W / 2, y: H / 2, k: 1 };
			return;
		}
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const n of nodes) {
			const pad = n.zone === null ? 0 : ZONE_PAD;
			const top = n.zone === null ? 0 : 44;
			minX = Math.min(minX, (n.x ?? 0) - n.w / 2 - pad);
			maxX = Math.max(maxX, (n.x ?? 0) + n.w / 2 + pad);
			minY = Math.min(minY, (n.y ?? 0) - n.h / 2 - top);
			maxY = Math.max(maxY, (n.y ?? 0) + n.h / 2 + pad);
		}
		if (!Number.isFinite(minX)) return;
		const margin = W < 500 ? 16 : 48;
		const k = clamp(
			Math.min((W - margin * 2) / Math.max(1, maxX - minX), (H - margin * 2) / Math.max(1, maxY - minY)),
			K_MIN,
			1.25
		);
		view = { k, x: W / 2 - ((minX + maxX) / 2) * k, y: H / 2 + 8 - ((minY + maxY) / 2) * k };
	}

	function zoomAt(clientX: number, clientY: number, factor: number) {
		autoFit = false;
		const rect = stageRect();
		const px = clientX - rect.left;
		const py = clientY - rect.top;
		const k = clamp(view.k * factor, K_MIN, K_MAX);
		const wx = (px - view.x) / view.k;
		const wy = (py - view.y) / view.k;
		view = { k, x: px - wx * k, y: py - wy * k };
	}

	/** Pan so the card is visible, when it is not. */
	export function reveal(itemId: string) {
		const n = byId.get(`i:${itemId}`);
		const el = stage;
		if (!n || !el) return;
		const W = el.clientWidth - rightInset;
		const H = el.clientHeight - DOCK_SPACE;
		const sx = view.x + (n.x ?? 0) * view.k;
		const sy = view.y + (n.y ?? 0) * view.k;
		const hw = (n.w * view.k) / 2;
		const hh = (n.h * view.k) / 2;
		if (sx - hw >= 0 && sx + hw <= W && sy - hh >= 0 && sy + hh <= H) return;
		autoFit = false;
		view = { ...view, x: W / 2 - (n.x ?? 0) * view.k, y: H / 2 - (n.y ?? 0) * view.k };
	}

	const pointers = new Map<number, { x: number; y: number }>();
	let panFrom: { x: number; y: number } | null = null;
	let panPointer: number | null = null;
	let panMoved = false;
	let pinch: { dist: number; k: number; wx: number; wy: number } | null = null;
	/** Last pointer position over the canvas (client px), for paste. */
	let lastClient: { x: number; y: number } | null = null;

	function startPinch() {
		const [a, b] = [...pointers.values()];
		const rect = stageRect();
		const mx = (a.x + b.x) / 2 - rect.left;
		const my = (a.y + b.y) / 2 - rect.top;
		pinch = {
			dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
			k: view.k,
			wx: (mx - view.x) / view.k,
			wy: (my - view.y) / view.k
		};
		panPointer = null;
		panFrom = null;
		autoFit = false;
		cancelDrag();
	}

	function onStageDown(e: PointerEvent) {
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		if ((e.target as HTMLElement).closest('.node, .zhead')) return;
		autoFit = false;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.size === 1) {
			panPointer = e.pointerId;
			panFrom = { x: e.clientX, y: e.clientY };
			panMoved = false;
		} else if (pointers.size === 2) {
			startPinch();
		}
	}

	function onStageMove(e: PointerEvent) {
		lastClient = { x: e.clientX, y: e.clientY };
		if (!pointers.has(e.pointerId)) return;
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.size >= 2 && pinch) {
			const [a, b] = [...pointers.values()];
			const rect = stageRect();
			const mx = (a.x + b.x) / 2 - rect.left;
			const my = (a.y + b.y) / 2 - rect.top;
			const k = clamp((pinch.k * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.dist, K_MIN, K_MAX);
			view = { k, x: mx - pinch.wx * k, y: my - pinch.wy * k };
			return;
		}
		if (!panFrom) return;
		const dx = e.clientX - panFrom.x;
		const dy = e.clientY - panFrom.y;
		if (!panMoved && Math.abs(dx) + Math.abs(dy) < 3) return;
		panMoved = true;
		panning = true;
		view = { ...view, x: view.x + dx, y: view.y + dy };
		panFrom = { x: e.clientX, y: e.clientY };
	}

	function onStageUp(e: PointerEvent) {
		const el = e.currentTarget as HTMLElement;
		if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
		const known = pointers.delete(e.pointerId);
		if (pointers.size < 2) pinch = null;
		panFrom = pointers.size === 1 ? { ...[...pointers.values()][0] } : null;
		if (pointers.size === 0) {
			const clicked = known && panPointer === e.pointerId && !panMoved && e.type === 'pointerup';
			panPointer = null;
			panning = false;
			if (clicked) onbackground();
		}
	}

	function onWheel(e: WheelEvent) {
		e.preventDefault();
		// Trackpad pinch arrives as ctrl+wheel with small deltas; scale those up.
		const d = e.ctrlKey ? e.deltaY * 6 : e.deltaY;
		zoomAt(e.clientX, e.clientY, Math.exp(-d * 0.0015));
	}

	function attachWheel(el: HTMLElement) {
		el.addEventListener('wheel', onWheel, { passive: false });
		return () => el.removeEventListener('wheel', onWheel);
	}

	// ----------------------------------------------------------------- Spots

	export function zoneAt(x: number, y: number): string | null {
		let best: string | null = null;
		let area = Infinity;
		for (const [tag, b] of zoneBoxes) {
			if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) continue;
			if (b.w * b.h < area) {
				area = b.w * b.h;
				best = tag;
			}
		}
		return best;
	}

	export function spotAtClient(clientX: number, clientY: number): Spot {
		const r = stageRect();
		const x = (clientX - r.left - view.x) / view.k;
		const y = (clientY - r.top - view.y) / view.k;
		return { x, y, zone: zoneAt(x, y) };
	}

	/** Centre of the visible canvas (left of the panel, above the dock). */
	export function centreSpot(): Spot {
		const r = stageRect();
		return spotAtClient(r.left + (r.width - rightInset) / 2, r.top + (r.height - DOCK_SPACE) / 2);
	}

	/** Where the pointer last was over the canvas, else the centre. */
	export function pointerSpot(): Spot {
		const r = stageRect();
		const p = lastClient;
		if (p && p.x >= r.left && p.x <= r.right - rightInset && p.y >= r.top && p.y <= r.bottom) {
			return spotAtClient(p.x, p.y);
		}
		return centreSpot();
	}

	/** A free spot just below a zone's cards. */
	export function zoneSpot(tag: string): Spot {
		const b = zoneBoxes.get(tag);
		if (!b) return { ...centreSpot(), zone: tag };
		return { x: b.x + ZONE_PAD + size / 2, y: b.y + b.h + CARD_GAP + estimateH() / 2 - ZONE_PAD, zone: tag };
	}

	// ------------------------------------------------------------- Dragging

	let drag: {
		n: CardNode;
		id: number;
		startX: number;
		startY: number;
		lastX: number;
		lastY: number;
		moved: boolean;
		from: Placement;
	} | null = null;

	function cardDown(e: PointerEvent, n: CardNode) {
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		e.stopPropagation();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		if (e.pointerType === 'touch') {
			// A second finger turns any drag into a pinch, wherever the fingers land.
			pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (pointers.size >= 2) {
				startPinch();
				return;
			}
		}
		drag = { n, id: e.pointerId, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false, from: { x: n.x, y: n.y, fx: n.fx, fy: n.fy } };
	}

	/** End a drag without a drop target: a moved card stays pinned where it is. */
	function cancelDrag() {
		const d = drag;
		if (!d) return;
		drag = null;
		dragId = null;
		dropZone = null;
		nodeEls.get(d.n.id)?.classList.remove('dragging');
		if (d.moved) pin(d.n);
	}

	function pin(n: CardNode) {
		const x = Math.round(n.x ?? 0);
		const y = Math.round(n.y ?? 0);
		n.x = n.fx = x;
		n.y = n.fy = y;
		mem.set(n.id, { x, y, fx: x, fy: y });
		queueSave(n.id, x, y);
	}

	function cardMove(e: PointerEvent) {
		lastClient = { x: e.clientX, y: e.clientY };
		if (pinch && pointers.has(e.pointerId)) {
			onStageMove(e);
			return;
		}
		const d = drag;
		if (!d || e.pointerId !== d.id) return;
		if (!d.moved) {
			if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) < 5) return;
			d.moved = true;
			autoFit = false;
			dragId = d.n.id;
			nodeEls.get(d.n.id)?.classList.add('dragging');
		}
		d.n.x = (d.n.x ?? 0) + (e.clientX - d.lastX) / view.k;
		d.n.y = (d.n.y ?? 0) + (e.clientY - d.lastY) / view.k;
		d.n.fx = d.n.x;
		d.n.fy = d.n.y;
		d.lastX = e.clientX;
		d.lastY = e.clientY;
		const el = nodeEls.get(d.n.id);
		if (el) placeNode(d.n, el);
		drawZones();
		const spot = spotAtClient(e.clientX, e.clientY);
		const target = spot.zone !== null && spot.zone !== d.n.zone ? spot.zone : null;
		if (target !== dropZone) dropZone = target;
	}

	function cardUp(e: PointerEvent, n: CardNode) {
		const el = e.currentTarget as HTMLElement;
		if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
		if (pointers.delete(e.pointerId)) {
			if (pointers.size < 2) pinch = null;
			panFrom = null;
			panPointer = null;
		}
		const d = drag;
		if (!d || e.pointerId !== d.id) return;
		drag = null;
		el.classList.remove('dragging');
		if (!d.moved) {
			if (e.type === 'pointerup') onselect(n.item.id);
			return;
		}
		dragId = null;
		pin(n);
		const target = dropZone;
		dropZone = null;
		if (target) onrezone(n.item, target, d.from);
		refreshAnchors();
		drawZones();
		reheat(0.25);
	}

	function cardKey(e: KeyboardEvent, n: CardNode) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onselect(n.item.id);
		}
	}

	// ------------------------------------------------- Menus, drop, dblclick

	function onContext(e: MouseEvent) {
		e.preventDefault();
		const card = (e.target as HTMLElement).closest<HTMLElement>('.node');
		if (card?.dataset.item) {
			oncontext({ kind: 'card', id: card.dataset.item, clientX: e.clientX, clientY: e.clientY });
		} else {
			oncontext({ kind: 'canvas', clientX: e.clientX, clientY: e.clientY, spot: spotAtClient(e.clientX, e.clientY) });
		}
	}

	function onDblClick(e: MouseEvent) {
		if ((e.target as HTMLElement).closest('.node, .zhead')) return;
		onpick(spotAtClient(e.clientX, e.clientY));
	}

	const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');

	function onDragOver(e: DragEvent) {
		if (!hasFiles(e)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
		fileOver = true;
		lastClient = { x: e.clientX, y: e.clientY };
		const z = spotAtClient(e.clientX, e.clientY).zone;
		if (z !== dropZone) dropZone = z;
	}

	function onDragLeave(e: DragEvent) {
		const to = e.relatedTarget as Node | null;
		if (to && stage?.contains(to)) return;
		fileOver = false;
		dropZone = null;
	}

	function onDrop(e: DragEvent) {
		if (!hasFiles(e)) return;
		e.preventDefault();
		fileOver = false;
		dropZone = null;
		const files = [...(e.dataTransfer?.files ?? [])];
		const images = files.filter((f) => f.type.startsWith('image/'));
		if (!images.length) {
			ontoast('Μόνο εικόνες μπορούν να προστεθούν');
			return;
		}
		onfiles(images, spotAtClient(e.clientX, e.clientY));
	}

	// ------------------------------------------------------- Saved positions

	/** Pending positions per map scope: '<scope>|<node key>'. */
	const pendingSaves = new Map<string, { scope: string; key: string; x: number; y: number }>();
	let saveTimer: ReturnType<typeof setTimeout> | undefined;

	function queueSave(key: string, x: number, y: number) {
		if (!canSave || !seededScope) return;
		pendingSaves.set(`${seededScope}|${key}`, { scope: seededScope, key, x, y });
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => void flushSaves(), 600);
	}

	/** All position writes (upserts and deletes) run one after another, so a delete can never be
	 *  overtaken by an older upsert that brings the pin back. */
	let writes: Promise<void> = Promise.resolve();
	function serial(job: () => PromiseLike<unknown>, failText: string): Promise<void> {
		writes = writes.then(job).then(
			() => {},
			() => ontoast(failText)
		);
		return writes;
	}

	/** Write the pending positions now, one call per map scope. Errors show a toast, never throw. */
	function flushSaves(): Promise<void> {
		clearTimeout(saveTimer);
		saveTimer = undefined;
		if (pendingSaves.size === 0) return writes;
		const rows = [...pendingSaves.values()];
		pendingSaves.clear();
		const byScope = new Map<string, { key: string; x: number; y: number }[]>();
		for (const r of rows) {
			const list = byScope.get(r.scope) ?? [];
			list.push({ key: r.key, x: r.x, y: r.y });
			byScope.set(r.scope, list);
		}
		return serial(
			async () => {
				// Wait for every scope before the chain moves on, so a later delete never races a write.
				const res = await Promise.allSettled([...byScope].map(([sc, list]) => savePositions(supabase, sc, list)));
				const bad = res.find((r) => r.status === 'rejected');
				if (bad) throw bad.reason;
			},
			'Οι θέσεις δεν αποθηκεύτηκαν'
		);
	}

	/** Pin a new card where it was added and remember that spot for this map. */
	export function place(itemId: string, x: number, y: number) {
		const key = `i:${itemId}`;
		const rx = Math.round(x);
		const ry = Math.round(y);
		mem.set(key, { x: rx, y: ry, fx: rx, fy: ry });
		queueSave(key, rx, ry);
	}

	/** Put a card back where it was (undo of a zone change). A free card is released again. */
	export function restore(itemId: string, from: Placement) {
		const key = `i:${itemId}`;
		const n = byId.get(key);
		const pinned = from.fx != null && from.fy != null;
		const p = { x: from.x, y: from.y, fx: pinned ? from.fx : null, fy: pinned ? from.fy : null };
		mem.set(key, p);
		if (n) Object.assign(n, p);
		if (pinned) queueSave(key, from.fx as number, from.fy as number);
		else if (canSave && seededScope) {
			pendingSaves.delete(`${seededScope}|${key}`);
			const sc = seededScope;
			void serial(async () => {
				const { error } = await supabase.from('map_positions').delete().eq('scope', sc).eq('node_key', key);
				if (error) throw error;
			}, 'Η θέση δεν αποθηκεύτηκε');
		}
		reheat(0.3);
	}

	/** Drop what is known about a deleted card. */
	export function forget(itemId: string) {
		const key = `i:${itemId}`;
		mem.delete(key);
		for (const k of pendingSaves.keys()) if (k.endsWith(`|${key}`)) pendingSaves.delete(k);
		if (canSave) void serial(() => supabase.from('map_positions').delete().eq('node_key', key), 'Η θέση δεν σβήστηκε');
	}

	/** Unpin every card in view, forget their saved spots and lay the board out again. */
	export async function autoLayout() {
		const keys = nodes.map((n) => n.id);
		for (const n of nodes) {
			n.fx = null;
			n.fy = null;
			mem.set(n.id, { x: n.x, y: n.y, fx: null, fy: null });
		}
		for (const k of pendingSaves.keys()) if (keys.some((key) => k.endsWith(`|${key}`))) pendingSaves.delete(k);
		refreshAnchors();
		autoFit = true;
		fitPending = true;
		reheat(0.9);
		if (!canSave || !seededScope) return;
		const sc = seededScope;
		await serial(async () => {
			for (let i = 0; i < keys.length; i += 200) {
				const { error } = await supabase
					.from('map_positions')
					.delete()
					.eq('scope', sc)
					.in('node_key', keys.slice(i, i + 200));
				if (error) throw error;
			}
		}, 'Η νέα διάταξη δεν αποθηκεύτηκε');
	}

	// ------------------------------------------------------------- Lifecycle

	onMount(() => {
		const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
		reduced = mq.matches;
		const onMq = () => (reduced = mq.matches);
		mq.addEventListener('change', onMq);
		const onHide = () => void flushSaves();
		window.addEventListener('pagehide', onHide);
		return () => {
			mq.removeEventListener('change', onMq);
			window.removeEventListener('pagehide', onHide);
			void flushSaves();
			ro?.disconnect();
			sim?.stop();
			sim = null;
		};
	});

	// ---------------------------------------------------------------- Helpers

	const pct = (v: number) => `${clamp(Number.isFinite(v) ? v : 0, 0, 1) * 100}%`;
	const regionStyle = (r: { x: number; y: number; w: number; h: number }) =>
		`left:${pct(r.x)};top:${pct(r.y)};width:${pct(r.w)};height:${pct(r.h)}`;
	const faded = (i: Inspiration) =>
		(matches !== null && !matches.has(i.id)) || (highlight !== null && !(i.tags ?? []).includes(highlight));
	const alt = (i: Inspiration) => (i.note ? i.note.slice(0, 80) : 'Εικόνα χωρίς σημείωση');
</script>

<div
	class="stage"
	class:panning
	bind:this={stage}
	style:--card="{size}px"
	style:background-size="{grid}px {grid}px"
	style:background-position="{view.x}px {view.y}px"
	role="application"
	aria-label="Πίνακας εικόνων"
	{@attach attachWheel}
	{@attach watchStage}
	onpointerdown={onStageDown}
	onpointermove={onStageMove}
	onpointerup={onStageUp}
	onpointercancel={onStageUp}
	onpointerleave={(e) => {
		if (!pointers.has(e.pointerId)) lastClient = null;
	}}
	oncontextmenu={onContext}
	ondblclick={onDblClick}
	ondragover={onDragOver}
	ondragleave={onDragLeave}
	ondrop={onDrop}
>
	<div class="world" style:transform="translate({view.x}px, {view.y}px) scale({view.k})" style:--k={view.k}>
		{#each zones as z (z.tag)}
			{@const c = colors.get(z.tag)}
			<div
				class="zone"
				class:dim={highlight !== null && highlight !== z.tag}
				class:hl={highlight === z.tag}
				class:target={dropZone === z.tag}
				style:--zl={c?.light}
				style:--zd={c?.dark}
				data-zone={z.tag}
				{@attach registerZone(z.tag)}
			>
				<div class="zhead">
					<span class="zlabel">{z.tag}<span class="zcount">&nbsp;·&nbsp;{z.count}</span></span>
					<button
						type="button"
						class="zadd"
						aria-label={`Νέα εικόνα στο #${z.tag}`}
						title={`Νέα εικόνα στο #${z.tag}`}
						onclick={() => onzoneadd(z.tag, zoneSpot(z.tag))}
					>
						<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>
					</button>
				</div>
			</div>
		{/each}

		{#each nodes as n (n.id)}
			{@const item = n.item}
			{@const url = urlOf(item)}
			{@const regions = item.regions ?? []}
			<div
				class="node"
				class:sel={selectedId === item.id}
				class:fade={faded(item)}
				data-id={n.id}
				data-item={item.id}
				{@attach registerCard(n.id)}
				onpointerdown={(e) => cardDown(e, n)}
				onpointermove={cardMove}
				onpointerup={(e) => cardUp(e, n)}
				onpointercancel={(e) => cardUp(e, n)}
				onkeydown={(e) => cardKey(e, n)}
				role="button"
				tabindex="0"
				aria-label={alt(item)}
				aria-pressed={selectedId === item.id}
			>
				<div class="card">
					<div class="shot">
						{#if url}
							<img src={url} alt="" loading="lazy" decoding="async" draggable="false" {@attach imgReady} />
						{:else}
							<span class="missing">χωρίς εικόνα</span>
						{/if}
						{#if showBoxes}
							{#each regions as r, ri (ri)}
								<div class="region" style={regionStyle(r)}>
									<span class="rtag">
										<span class="rnum">{ri + 1}</span>
										{#if showRegionNotes && r.note}<span class="rnote">{r.note}</span>{/if}
									</span>
								</div>
							{/each}
						{:else if regions.length}
							<span class="rcount" title={`${regions.length} περιοχές`}>{regions.length}</span>
						{/if}
					</div>
					{#if notesOn && item.note}
						<p class="cardnote">{item.note}</p>
					{/if}
				</div>
			</div>
		{/each}
	</div>

	{#if fileOver}
		<div class="dropveil" aria-hidden="true">
			<p>
				Άφησε για να προστεθούν{#if dropZone}<span> στο <b>#{dropZone}</b></span>{/if}
			</p>
		</div>
	{/if}
</div>

<style>
	.stage {
		position: absolute;
		inset: 0;
		overflow: hidden;
		touch-action: none;
		cursor: grab;
		background-color: var(--bg);
		background-image: radial-gradient(circle at 1px 1px, var(--line-strong) 1px, transparent 1.2px);
		user-select: none;
		-webkit-user-select: none;
	}
	.stage.panning {
		cursor: grabbing;
	}

	.world {
		position: absolute;
		left: 0;
		top: 0;
		width: 0;
		height: 0;
		transform-origin: 0 0;
	}

	/* ------------------------------------------------------------ zones */
	.zone {
		--z: var(--zl, #7d7a72);
		position: absolute;
		left: 0;
		top: 0;
		border-radius: 20px;
		background: color-mix(in srgb, var(--z) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--z) 40%, transparent);
		pointer-events: none;
		transition:
			opacity 0.18s cubic-bezier(0.2, 0.8, 0.2, 1),
			background-color 0.18s cubic-bezier(0.2, 0.8, 0.2, 1),
			border-color 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	@media (prefers-color-scheme: dark) {
		.zone {
			--z: var(--zd, #9a978f);
		}
	}
	.zone.dim {
		opacity: 0.3;
	}
	.zone.hl {
		background: color-mix(in srgb, var(--z) 16%, transparent);
		border-color: color-mix(in srgb, var(--z) 55%, transparent);
	}
	.zone.target {
		background: color-mix(in srgb, var(--z) 14%, transparent);
		border: 1.5px dashed color-mix(in srgb, var(--z) 75%, transparent);
	}
	.zhead {
		position: absolute;
		left: 0;
		top: 0;
		display: flex;
		align-items: center;
		gap: 0.3em;
		/* Labels stay about 12px on screen, up to the room the zone's top padding leaves. */
		font-size: min(24px, calc(12px / var(--k, 1)));
		padding: 0.95em 0 0 1.2em;
		pointer-events: auto;
		cursor: default;
	}
	.zlabel {
		font-weight: 600;
		letter-spacing: 0.01em;
		white-space: nowrap;
		color: color-mix(in srgb, var(--z) 82%, var(--text));
		line-height: 1.2;
	}
	.zcount {
		font-weight: 500;
		font-variant-numeric: tabular-nums;
		opacity: 0.75;
	}
	.zadd {
		display: inline-grid;
		place-items: center;
		width: 1.8em;
		height: 1.8em;
		margin: -0.4em 0;
		padding: 0;
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: color-mix(in srgb, var(--z) 72%, var(--text));
		opacity: 0;
		transition:
			opacity 0.15s cubic-bezier(0.2, 0.8, 0.2, 1),
			background-color 0.15s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.zadd svg {
		width: 1.1em;
		height: 1.1em;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
	}
	.zhead:hover .zadd,
	.zadd:focus-visible {
		opacity: 1;
	}
	.zadd:hover {
		background: color-mix(in srgb, var(--z) 16%, transparent);
	}
	@media (hover: none) {
		.zadd {
			opacity: 0.8;
		}
	}

	/* ------------------------------------------------------------ cards */
	.node {
		position: absolute;
		left: 0;
		top: 0;
		width: var(--card, 160px);
		cursor: grab;
		transition: opacity 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
		outline: none;
	}
	.node.fade {
		opacity: 0.15;
	}
	.node:global(.dragging) {
		z-index: 5;
		cursor: grabbing;
	}
	.node.sel {
		z-index: 3;
	}
	.card {
		background: var(--raised);
		padding: 6px;
		border-radius: 6px;
		box-shadow:
			0 1px 2px rgb(0 0 0 / 0.06),
			0 8px 24px -12px rgb(0 0 0 / 0.25);
		transition:
			transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1),
			box-shadow 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	@media (hover: hover) {
		.node:hover .card {
			transform: translateY(-2px);
			box-shadow:
				0 2px 4px rgb(0 0 0 / 0.07),
				0 14px 30px -14px rgb(0 0 0 / 0.32);
		}
	}
	.node:global(.dragging) .card {
		transform: translateY(-3px) rotate(-0.6deg);
		box-shadow:
			0 2px 4px rgb(0 0 0 / 0.08),
			0 22px 40px -16px rgb(0 0 0 / 0.4);
	}
	.node.sel .card {
		box-shadow:
			0 0 0 2px var(--accent),
			0 8px 24px -12px rgb(0 0 0 / 0.3);
	}
	.node:focus-visible .card {
		box-shadow:
			0 0 0 2px var(--bg),
			0 0 0 4px var(--accent);
	}
	.shot {
		position: relative;
		line-height: 0;
		border-radius: var(--r-img);
		overflow: hidden;
		background: var(--sunk);
	}
	.shot img {
		display: block;
		width: 100%;
		height: auto;
		pointer-events: none;
	}
	.shot img:not([data-loaded]) {
		aspect-ratio: 4 / 3;
	}
	.missing {
		display: block;
		padding: 28px 8px;
		text-align: center;
		color: var(--muted);
		font-size: 11px;
		line-height: 1.3;
	}
	/* Region marks stay the same size on screen at any zoom (--k is the zoom). */
	.region {
		position: absolute;
		border: calc(1.5px / var(--k, 1)) solid var(--accent);
		border-radius: calc(3px / var(--k, 1));
		box-shadow: 0 0 0 calc(1px / var(--k, 1)) rgb(255 255 255 / 0.35);
		pointer-events: none;
	}
	.rtag {
		position: absolute;
		top: 0;
		left: 0;
		display: flex;
		align-items: flex-start;
		max-width: 100%;
		font-size: calc(10.5px / var(--k, 1));
		line-height: 1.25;
	}
	.rnum {
		flex: none;
		background: var(--accent);
		color: var(--on-accent);
		font-weight: 700;
		line-height: 1;
		padding: 0.3em 0.5em;
		border-radius: 0 0 0.35em 0;
	}
	.rnote {
		min-width: 0;
		max-width: 22em;
		background: rgb(20 18 16 / 0.78);
		color: #fff;
		padding: 0.25em 0.55em;
		border-radius: 0 0 0.35em 0;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		overflow-wrap: anywhere;
	}
	.rcount {
		position: absolute;
		top: 6px;
		right: 6px;
		min-width: 18px;
		height: 18px;
		display: grid;
		place-items: center;
		background: var(--accent);
		color: var(--on-accent);
		font-size: 10.5px;
		font-weight: 700;
		line-height: 1;
		padding: 0 5px;
		border-radius: 999px;
		box-shadow: 0 0 0 2px var(--raised);
	}
	.cardnote {
		margin: 7px 2px 1px;
		font-size: 12.5px;
		line-height: 1.4;
		color: var(--text);
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
		overflow-wrap: anywhere;
	}

	/* ------------------------------------------------------------ drop veil */
	.dropveil {
		position: absolute;
		inset: 10px;
		border: 2px dashed color-mix(in srgb, var(--accent) 60%, transparent);
		border-radius: var(--r-panel);
		background: color-mix(in srgb, var(--accent) 5%, transparent);
		display: grid;
		place-items: center;
		pointer-events: none;
	}
	.dropveil p {
		margin: 0;
		padding: 10px 18px;
		border-radius: var(--r-pill);
		background: var(--raised);
		box-shadow:
			0 12px 32px -12px rgb(0 0 0 / 0.3),
			0 0 0 1px var(--line);
		font-size: 14px;
		color: var(--text);
	}

	@media (prefers-reduced-motion: reduce) {
		.zone,
		.node,
		.card,
		.zadd {
			transition: none;
		}
		.node:hover .card,
		.node:global(.dragging) .card {
			transform: none;
		}
	}
</style>
