<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount, tick, untrack } from 'svelte';
	import {
		forceCenter,
		forceCollide,
		type ForceCollide,
		forceLink,
		forceManyBody,
		forceSimulation,
		type Simulation,
		type SimulationLinkDatum,
		type SimulationNodeDatum
	} from 'd3-force';
	import { LEVELS, type Level, type Inspiration } from '#lib/types.js';
	import { LEVEL_LABELS } from '#lib/tags.js';
	import { copyInspiration } from '#lib/inspirations.js';
	import QuickAdd from '#lib/components/QuickAdd.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	interface SimNode extends SimulationNodeDatum {
		id: string;
		kind: 'project' | 'tag' | 'inspiration';
		label: string;
		item?: Inspiration;
		/** Collision radius, world px. */
		r: number;
		/** Measured width / height, world px. */
		w: number;
		h: number;
		orphan?: boolean;
	}

	interface SimLink extends SimulationLinkDatum<SimNode> {
		id: string;
		fromId: string;
		toId: string;
		kind: 'project' | 'tag';
		dist: number;
	}

	const LS_KEY = 'moodboard:map';
	/** Select value for «Χωρίς project» (project ids are uuids, so this cannot clash). */
	const NO_PROJECT = '__none';
	const SIZE_MIN = 80;
	const SIZE_MAX = 360;

	const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

	// -------------------------------------------------------------- URL / filters

	// Shallow navigations update `page.shallow.url`, not `page.url` (SvelteKit 3).
	const projectParam = $derived((page.shallow?.url ?? page.url).searchParams.get('project'));

	const project = $derived.by(() => {
		const p = projectParam;
		if (!p || p === 'all') return 'all';
		if (p === 'none') return 'none';
		return data.projects.some((x) => x.id === p) ? p : 'all';
	});

	const projectName = $derived(
		project === 'all'
			? 'Όλα τα projects'
			: project === 'none'
				? 'Χωρίς project'
				: (data.projects.find((p) => p.id === project)?.name ?? 'Χάρτης')
	);

	function selectProject(id: string) {
		const url = id === 'all' ? '/map' : `/map?project=${encodeURIComponent(id)}`;
		// `reset: false` keeps focus and scroll, which is what the old keepFocus / noScroll options did.
		void goto(url, { replace: true, reset: false });
	}

	let level = $state<Level | ''>('');
	let notesOn = $state(false);
	let tagsOn = $state(true);
	let size = $state(160);
	let prefsLoaded = $state(false);

	const filtered = $derived(
		data.inspirations.filter((i) => {
			if (project === 'none' ? i.project_id !== null : project !== 'all' && i.project_id !== project) {
				return false;
			}
			if (level && i.level !== level) return false;
			return true;
		})
	);

	const hasNone = $derived(data.inspirations.some((i) => i.project_id === null));

	// ---------------------------------------------------------------- View state

	let container = $state<HTMLDivElement | null>(null);
	let view = $state({ x: 0, y: 0, k: 1 });
	let selectedId = $state<string | null>(null);
	let focusTag = $state<string | null>(null);
	let hoverTag = $state<string | null>(null);
	let toast = $state('');
	let copyTarget = $state('');

	const selected = $derived(selectedId ? (data.inspirations.find((i) => i.id === selectedId) ?? null) : null);

	// Region boxes need room to read; region notes appear when there is more.
	const cardWidth = $derived(size * view.k);
	const showBoxes = $derived(cardWidth >= 200);
	const showRegionNotes = $derived(cardWidth >= 360);

	/** Card ids of the focused tag's neighbourhood. */
	const hood = $derived.by(() => {
		if (!focusTag) return null;
		const ids = new Set<string>([`t:${focusTag}`]);
		for (const i of filtered) {
			if (!i.tags.includes(focusTag)) continue;
			ids.add(`i:${i.id}`);
			if (i.project_id) ids.add(`p:${i.project_id}`);
		}
		return ids;
	});

	// ------------------------------------------------------------ Quick add state

	let quickAdd = $state<{ open: boolean; file: File | null; tags: string[]; projectId: string | null }>({
		open: false,
		file: null,
		tags: [],
		projectId: null
	});

	/** World point where the next added image should appear (double-click / paste spot). */
	let spawnPoint: { x: number; y: number } | null = null;

	function openAdd(opts: { file?: File | null; tags?: string[]; projectId?: string | null } = {}) {
		quickAdd = {
			open: true,
			file: opts.file ?? null,
			tags: opts.tags ?? [],
			projectId:
				opts.projectId !== undefined
					? opts.projectId
					: project === 'all' || project === 'none'
						? null
						: project
		};
	}

	function closeAdd() {
		quickAdd = { open: false, file: null, tags: [], projectId: null };
	}

	// --------------------------------------------------------- Simulation / model

	/** Last known position per node id, so filters and reloads keep the layout. */
	const positions = new Map<string, { x?: number; y?: number; fx?: number | null; fy?: number | null }>();
	const nodeEls = new Map<string, HTMLElement>();
	const lineEls = new Map<string, SVGLineElement>();

	let nodes = $state.raw<SimNode[]>([]);
	let links = $state.raw<SimLink[]>([]);
	let sim: Simulation<SimNode, SimLink> | null = null;
	/** Fit to the nodes once the layout has settled, until the user moves the view. */
	let autoFit = true;
	let fitPending = true;
	let lastProject: string | null = null;

	function radiusFor(kind: SimNode['kind'], w: number, h: number) {
		// Before the image loads, assume a portrait card, so collision is not too small.
		if (kind === 'inspiration') return (h > 0 ? Math.max(w, h) : w * 1.35) / 2 + 6;
		return Math.max(h > 0 ? h / 2 : 16, w > 0 ? w / 4 : 20) + 8;
	}

	function placeNode(n: SimNode, el: HTMLElement) {
		el.style.transform = `translate(${n.x ?? 0}px, ${n.y ?? 0}px) translate(-50%, -50%)`;
	}

	function placeLine(l: SimLink, el: SVGLineElement) {
		const s = l.source as SimNode | undefined;
		const t = l.target as SimNode | undefined;
		const ax = view.x + (s?.x ?? 0) * view.k;
		const ay = view.y + (s?.y ?? 0) * view.k;
		const bx = view.x + (t?.x ?? 0) * view.k;
		const by = view.y + (t?.y ?? 0) * view.k;
		el.setAttribute('x1', String(ax));
		el.setAttribute('y1', String(ay));
		el.setAttribute('x2', String(bx));
		el.setAttribute('y2', String(by));
	}

	function syncLines() {
		for (const l of links) {
			const el = lineEls.get(l.id);
			if (el) placeLine(l, el);
		}
	}

	/** Register a node element; the simulation writes its transform directly. */
	function nodeRef(el: HTMLElement, n: SimNode) {
		nodeEls.set(n.id, el);
		placeNode(n, el);
		return {
			destroy() {
				if (nodeEls.get(n.id) === el) nodeEls.delete(n.id);
			}
		};
	}

	function lineRef(el: SVGLineElement, l: SimLink) {
		lineEls.set(l.id, el);
		placeLine(l, el);
		return {
			destroy() {
				if (lineEls.get(l.id) === el) lineEls.delete(l.id);
			}
		};
	}

	/** Read the real box of one node and grow its collision radius to match. */
	function measureOne(n: SimNode) {
		const el = nodeEls.get(n.id);
		if (!el) return false;
		const w = el.offsetWidth;
		const h = el.offsetHeight;
		if (w === n.w && h === n.h) return false;
		n.w = w;
		n.h = h;
		const r = radiusFor(n.kind, w, h);
		const grew = r > n.r + 0.5;
		if (Math.abs(r - n.r) > 0.5) n.r = r;
		return grew;
	}

	function measureAll() {
		let grew = false;
		for (const n of nodes) grew = measureOne(n) || grew;
		// A bigger box needs a real push, not a nudge.
		if (grew) reheat(0.45);
	}

	function reheat(alpha = 0.45) {
		if (!sim || nodes.length === 0) return;
		// forceCollide caches radii at initialize; re-set it so measured sizes take effect.
		(sim.force('collide') as ForceCollide<SimNode> | undefined)?.radius((n) => n.r);
		sim.alpha(Math.max(sim.alpha(), alpha)).restart();
	}

	function onTick() {
		for (const n of nodes) {
			const el = nodeEls.get(n.id);
			if (el) placeNode(n, el);
		}
		syncLines();
		if (fitPending && autoFit && sim && sim.alpha() < 0.05) {
			fitPending = false;
			fitAll();
		}
	}

	function ensureSim(nextNodes: SimNode[], nextLinks: SimLink[]) {
		if (!sim) {
			sim = forceSimulation<SimNode, SimLink>(nextNodes)
				.alphaMin(0.005)
				.alphaDecay(0.07)
				.velocityDecay(0.42)
				.on('tick', onTick);
		}
		sim.nodes(nextNodes);
		sim.force(
			'link',
			forceLink<SimNode, SimLink>(nextLinks)
				.id((d) => d.id)
				.distance((l) => l.dist)
				.strength((l) => (l.kind === 'tag' ? 0.25 : 0.6))
		);
		sim.force('charge', forceManyBody<SimNode>().strength((n) => -Math.max(250, n.r * n.r * 0.45)));
		sim.force(
			'collide',
			forceCollide<SimNode>()
				.radius((n) => n.r)
				.strength(0.85)
				.iterations(2)
		);
		sim.force('center', forceCenter<SimNode>(0, 0).strength(0.05));
		sim.alpha(0.55).restart();
	}

	function buildGraph(items: Inspiration[], withTags: boolean): boolean {
		// Snapshot positions of what is on screen, so nothing jumps on a rebuild.
		for (const n of nodes) positions.set(n.id, { x: n.x, y: n.y, fx: n.fx, fy: n.fy });

		const nextNodes: SimNode[] = [];
		const nextLinks: SimLink[] = [];
		const knownProjects = new Set(data.projects.map((p) => p.id));

		const make = (id: string, kind: SimNode['kind'], label: string, item?: Inspiration) => {
			const p = positions.get(id);
			const n: SimNode = {
				id,
				kind,
				label,
				item,
				r: kind === 'inspiration' ? size * 0.6 : 30,
				w: kind === 'inspiration' ? size : 0,
				h: 0,
				x: p?.x,
				y: p?.y,
				fx: p?.fx ?? null,
				fy: p?.fy ?? null
			};
			nextNodes.push(n);
			return n;
		};

		const usedProjects = new Set<string>();
		let orphans = false;
		for (const i of items) {
			const pid = i.project_id && knownProjects.has(i.project_id) ? i.project_id : null;
			if (pid) usedProjects.add(pid);
			else orphans = true;
			const n = make(`i:${i.id}`, 'inspiration', i.note.slice(0, 80), i);
			n.label = i.note.slice(0, 80);
		}

		// "Χωρίς project" is a pill only in the all-view.
		if (project === 'all' && orphans) {
			const n = make('p:none', 'project', 'Χωρίς project');
			n.orphan = true;
		}
		for (const p of data.projects) {
			if (!usedProjects.has(p.id)) continue;
			make(`p:${p.id}`, 'project', p.name);
		}
		if (withTags) {
			const usedTags = new Set<string>();
			for (const i of items) for (const t of i.tags) usedTags.add(t);
			for (const t of [...usedTags].sort()) make(`t:${t}`, 'tag', t);
		}

		const byId = new Map(nextNodes.map((n) => [n.id, n]));

		const addLink = (from: SimNode, to: SimNode, kind: 'project' | 'tag') => {
			const dist = kind === 'tag' ? size * 0.55 + 36 : size * 0.7 + 56;
			nextLinks.push({
				id: `e:${from.id}>${to.id}`,
				fromId: from.id,
				toId: to.id,
				kind,
				dist,
				source: from,
				target: to
			});
		};

		for (const i of items) {
			const from = byId.get(`i:${i.id}`);
			if (!from) continue;
			const pid = i.project_id && knownProjects.has(i.project_id) ? i.project_id : null;
			const to = byId.get(pid ? `p:${pid}` : 'p:none');
			if (to) addLink(from, to, 'project');
			if (!withTags) continue;
			for (const t of new Set(i.tags)) {
				const tn = byId.get(`t:${t}`);
				if (tn) addLink(from, tn, 'tag');
			}
		}

		// Place nodes that have no position yet: at the spawn point, near a neighbour, else the origin.
		const spawn = spawnPoint;
		let spawnUsed = false;
		let spawned = false;
		for (const n of nextNodes) {
			if (n.x !== undefined && n.x !== null && !Number.isNaN(n.x)) continue;
			let bx = 0;
			let by = 0;
			if (spawn && n.kind === 'inspiration' && !spawnUsed) {
				bx = spawn.x;
				by = spawn.y;
				spawnUsed = true;
			} else {
				const nb = nextLinks.find((l) => {
					const s = l.source as SimNode;
					const t = l.target as SimNode;
					return (s === n && t.x != null) || (t === n && s.x != null);
				});
				if (nb) {
					const other = (nb.source === n ? nb.target : nb.source) as SimNode;
					bx = other.x ?? 0;
					by = other.y ?? 0;
				}
			}
			// Start at a realistic link distance, so nothing is born overlapping.
			const a = Math.random() * Math.PI * 2;
			const d = (n.kind === 'inspiration' ? size * 0.75 + 70 : 130) + Math.random() * 40;
			n.x = bx + Math.cos(a) * d;
			n.y = by + Math.sin(a) * d;
			n.vx = 0;
			n.vy = 0;
			spawned = true;
		}
		if (spawn) spawnPoint = null;

		links = nextLinks;
		nodes = nextNodes;

		if (nextNodes.length === 0) {
			sim?.stop();
			return spawned;
		}
		ensureSim(nextNodes, nextLinks);
		void tick().then(() => {
			untrack(() => measureAll());
		});
		return spawned;
	}

	// Rebuild when the data or the filters change; positions live outside Svelte state.
	$effect(() => {
		const items = filtered;
		const withTags = tagsOn;
		const currentProject = project;
		untrack(() => {
			const fresh = buildGraph(items, withTags);
			if (fresh || currentProject !== lastProject) {
				lastProject = currentProject;
				fitPending = true;
			}
		});
	});

	// Card size and note visibility change the measured height; keep collision in sync.
	$effect(() => {
		size;
		notesOn;
		void tick().then(() => untrack(() => measureAll()));
	});

	// ------------------------------------------------------------- Pan and zoom

	function stageRect() {
		return container?.getBoundingClientRect() ?? new DOMRect(0, 0, 1, 1);
	}

	function fitAll() {
		// The button is an explicit choice: stop fitting on its own.
		fitPending = false;
		autoFit = false;
		const el = container;
		if (!el || nodes.length === 0) {
			view = { x: (el?.clientWidth ?? 0) / 2, y: (el?.clientHeight ?? 0) / 2, k: 1 };
			svgSync();
			return;
		}
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const n of nodes) {
			const w = (n.w || size) / 2;
			const h = (n.h || size) / 2;
			const x = n.x ?? 0;
			const y = n.y ?? 0;
			minX = Math.min(minX, x - w);
			maxX = Math.max(maxX, x + w);
			minY = Math.min(minY, y - h);
			maxY = Math.max(maxY, y + h);
		}
		if (!Number.isFinite(minX)) return;
		const W = el.clientWidth;
		const H = el.clientHeight;
		const pad = 60;
		const bw = Math.max(1, maxX - minX);
		const bh = Math.max(1, maxY - minY);
		const k = clamp(Math.min((W - pad * 2) / bw, (H - pad * 2) / bh), 0.2, 1.5);
		view = { k, x: W / 2 - ((minX + maxX) / 2) * k, y: H / 2 - ((minY + maxY) / 2) * k };
		svgSync();
	}

	function svgSync() {
		syncLines();
	}

	function zoomAt(clientX: number, clientY: number, factor: number) {
		autoFit = false;
		const rect = stageRect();
		const px = clientX - rect.left;
		const py = clientY - rect.top;
		const k = clamp(view.k * factor, 0.2, 4);
		const wx = (px - view.x) / view.k;
		const wy = (py - view.y) / view.k;
		view = { k, x: px - wx * k, y: py - wy * k };
		svgSync();
	}

	const pointers = new Map<number, { x: number; y: number }>();
	let panFrom: { x: number; y: number } | null = null;
	let panPointer: number | null = null;
	let panMoved = false;
	let pinch: { dist: number; k: number; wx: number; wy: number } | null = null;

	function onStageDown(e: PointerEvent) {
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		if ((e.target as HTMLElement).closest('.node')) return;
		autoFit = false;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.size === 1) {
			panPointer = e.pointerId;
			panFrom = { x: e.clientX, y: e.clientY };
			panMoved = false;
		} else if (pointers.size === 2) {
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
		}
	}

	function onStageMove(e: PointerEvent) {
		if (!pointers.has(e.pointerId)) return;
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.size >= 2 && pinch) {
			const [a, b] = [...pointers.values()];
			const rect = stageRect();
			const mx = (a.x + b.x) / 2 - rect.left;
			const my = (a.y + b.y) / 2 - rect.top;
			const k = clamp((pinch.k * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.dist, 0.2, 4);
			view = { k, x: mx - pinch.wx * k, y: my - pinch.wy * k };
			svgSync();
			return;
		}
		if (!panFrom) return;
		const dx = e.clientX - panFrom.x;
		const dy = e.clientY - panFrom.y;
		if (Math.abs(dx) + Math.abs(dy) >= 2) panMoved = true;
		view = { ...view, x: view.x + dx, y: view.y + dy };
		panFrom = { x: e.clientX, y: e.clientY };
		svgSync();
	}

	function onStageUp(e: PointerEvent) {
		const el = e.currentTarget as HTMLElement;
		if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
		const known = pointers.delete(e.pointerId);
		if (pointers.size < 2) pinch = null;
		panFrom = pointers.size === 1 ? { ...([...pointers.values()][0]) } : null;
		if (pointers.size === 0) {
			const clicked = known && panPointer === e.pointerId && !panMoved;
			panPointer = null;
			if (clicked) {
				focusTag = null;
				selectedId = null;
			}
		}
	}

	function onWheel(e: WheelEvent) {
		e.preventDefault();
		zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
	}

	function onDoubleClick(e: MouseEvent) {
		if ((e.target as HTMLElement).closest('.node')) return;
		const rect = stageRect();
		spawnPoint = {
			x: (e.clientX - rect.left - view.x) / view.k,
			y: (e.clientY - rect.top - view.y) / view.k
		};
		openAdd();
	}

	// -------------------------------------------------------------- Node dragging

	let drag: {
		n: SimNode;
		id: number;
		startX: number;
		startY: number;
		lastX: number;
		lastY: number;
		moved: boolean;
	} | null = null;

	function nodeDown(e: PointerEvent, n: SimNode) {
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		if ((e.target as HTMLElement).closest('.addtag')) return;
		e.stopPropagation();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		autoFit = false;
		drag = {
			n,
			id: e.pointerId,
			startX: e.clientX,
			startY: e.clientY,
			lastX: e.clientX,
			lastY: e.clientY,
			moved: false
		};
	}

	function nodeMove(e: PointerEvent) {
		const d = drag;
		if (!d || e.pointerId !== d.id) return;
		if (!d.moved) {
			if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) < 4) return;
			d.moved = true;
			reheat(0.25);
		}
		d.n.x = (d.n.x ?? 0) + (e.clientX - d.lastX) / view.k;
		d.n.y = (d.n.y ?? 0) + (e.clientY - d.lastY) / view.k;
		d.n.fx = d.n.x;
		d.n.fy = d.n.y;
		d.lastX = e.clientX;
		d.lastY = e.clientY;
		const el = nodeEls.get(d.n.id);
		if (el) placeNode(d.n, el);
		syncLines();
	}

	function nodeUp(e: PointerEvent, n: SimNode) {
		const d = drag;
		if (!d || e.pointerId !== d.id) return;
		drag = null;
		const el = e.currentTarget as HTMLElement;
		if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
		if (d.moved) {
			// Stay pinned where it was dropped.
			n.fx = n.x ?? null;
			n.fy = n.y ?? null;
			positions.set(n.id, { x: n.x, y: n.y, fx: n.fx, fy: n.fy });
		} else {
			nodeClick(n);
		}
	}

	function nodeClick(n: SimNode) {
		if (n.kind === 'inspiration') {
			selectedId = n.item?.id ?? null;
			copyTarget = '';
		} else if (n.kind === 'tag') {
			focusTag = focusTag === n.label ? null : n.label;
		} else if (n.kind === 'project' && !n.orphan) {
			selectProject(n.id.slice(2));
		}
	}

	// --------------------------------------------------------------- Copy / toast

	async function copySelected(target: string) {
		const item = selected;
		const userId = data.userId;
		if (!item || !userId || !target) return;
		copyTarget = '';
		const projectId = target === NO_PROJECT ? null : target;
		try {
			await copyInspiration(data.supabase, userId, item.id, projectId);
			const name = projectId ? data.projects.find((p) => p.id === projectId)?.name : undefined;
			showToast(name ? `Αντιγράφηκε στο ${name}` : 'Αντιγράφηκε χωρίς project');
			await invalidate('moodboard:data');
		} catch (err) {
			showToast(err instanceof Error ? err.message : 'Αποτυχία αντιγραφής');
		}
	}

	let toastTimer: ReturnType<typeof setTimeout> | undefined;

	function showToast(msg: string) {
		toast = msg;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = ''), 2600);
	}

	// ------------------------------------------------------------ Global events

	function onPaste(e: ClipboardEvent) {
		if (quickAdd.open) return;
		const editable = 'input, textarea, select, [contenteditable="true"]';
		for (const el of [e.target, document.activeElement]) {
			if (el instanceof Element && el.closest(editable)) return;
		}
		for (const item of e.clipboardData?.items ?? []) {
			if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
			const file = item.getAsFile();
			if (!file) continue;
			e.preventDefault();
			openAdd({ file });
			break;
		}
	}

	function onKeyDown(e: KeyboardEvent) {
		if (e.key !== 'Escape' || quickAdd.open) return;
		if (selectedId) selectedId = null;
		else focusTag = null;
	}

	let wheelEl: HTMLElement | null = null;
	let wheelFn: ((e: WheelEvent) => void) | null = null;

	function attachStage(el: HTMLElement | null) {
		if (wheelEl && wheelFn) wheelEl.removeEventListener('wheel', wheelFn);
		wheelEl = el;
		wheelFn = el ? onWheel : null;
		if (el && wheelFn) el.addEventListener('wheel', wheelFn, { passive: false });
	}

	$effect(() => {
		attachStage(container);
		return () => attachStage(null);
	});

	onMount(() => {
		try {
			const raw = localStorage.getItem(LS_KEY);
			if (raw) {
				const v = JSON.parse(raw) as { size?: unknown; notesOn?: unknown; tagsOn?: unknown };
				if (typeof v.size === 'number' && Number.isFinite(v.size)) size = clamp(Math.round(v.size), SIZE_MIN, SIZE_MAX);
				if (typeof v.notesOn === 'boolean') notesOn = v.notesOn;
				if (typeof v.tagsOn === 'boolean') tagsOn = v.tagsOn;
			}
		} catch {
			/* storage unavailable: keep the defaults */
		}
		prefsLoaded = true;

		window.addEventListener('paste', onPaste);
		window.addEventListener('keydown', onKeyDown);
		return () => {
			window.removeEventListener('paste', onPaste);
			window.removeEventListener('keydown', onKeyDown);
			clearTimeout(toastTimer);
			sim?.stop();
			sim = null;
		};
	});

	$effect(() => {
		if (!prefsLoaded) return;
		const prefs = { size, notesOn, tagsOn };
		untrack(() => {
			try {
				localStorage.setItem(LS_KEY, JSON.stringify(prefs));
			} catch {
				/* ignore */
			}
		});
	});

	// ------------------------------------------------------------------ Helpers

	const pct = (v: number) => `${clamp(Number.isFinite(v) ? v : 0, 0, 1) * 100}%`;

	function regionStyle(r: { x: number; y: number; w: number; h: number }) {
		return `left:${pct(r.x)};top:${pct(r.y)};width:${pct(r.w)};height:${pct(r.h)}`;
	}

	const regionsOf = (i: Inspiration) => i.regions ?? [];
	const tagsOf = (i: Inspiration) => i.tags ?? [];
	const isFaded = (id: string) => (hood ? !hood.has(id) : false);
	const lineFaded = (l: SimLink) => (hood ? !(hood.has(l.fromId) && hood.has(l.toId)) : false);
	const isHttp = (url: string | null) => !!url && /^https?:\/\//i.test(url);
</script>

<svelte:head>
	<title>{projectName} · Χάρτης · Moodboard</title>
</svelte:head>

<div class="page">
	<header class="bar">
		<a class="back" href="/">← Πίνακας</a>
		<div class="controls">
			<select aria-label="Project" value={project} onchange={(e) => selectProject(e.currentTarget.value)}>
				<option value="all">Όλα τα projects</option>
				{#each data.projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
				{#if hasNone}<option value="none">Χωρίς project</option>{/if}
			</select>
			<select bind:value={level} aria-label="Επίπεδο">
				<option value="">Όλα τα επίπεδα</option>
				{#each LEVELS as l (l)}<option value={l}>{LEVEL_LABELS[l]}</option>{/each}
			</select>
			<label class="toggle"><input type="checkbox" bind:checked={notesOn} />Σημειώσεις</label>
			<label class="toggle"><input type="checkbox" bind:checked={tagsOn} />Tags</label>
			<label class="sizer">
				Μέγεθος
				<input type="range" min={SIZE_MIN} max={SIZE_MAX} step="10" bind:value={size} aria-label="Μέγεθος εικόνας" />
				<span class="sizerVal">{size}</span>
			</label>
			<button type="button" onclick={fitAll}>Κεντράρισμα</button>
			<button type="button" class="primary" onclick={() => openAdd()}>+ Νέα</button>
		</div>
	</header>

	{#if data.error}
		<p class="msg">Σφάλμα φόρτωσης: {data.error}</p>
	{:else}
		<div
			class="stage"
			bind:this={container}
			style="--card: {size}px"
			role="application"
			aria-label="Χάρτης"
			onpointerdown={onStageDown}
			onpointermove={onStageMove}
			onpointerup={onStageUp}
			onpointercancel={onStageUp}
			ondblclick={onDoubleClick}
		>
			<svg class="edges" aria-hidden="true">
				{#each links as l (l.id)}
					<line use:lineRef={l} class:fade={lineFaded(l)} />
				{/each}
			</svg>

			<div class="world" style="transform: translate({view.x}px, {view.y}px) scale({view.k})">
				{#each nodes as n (n.id)}
					{#if n.kind === 'inspiration' && n.item}
						{@const item = n.item}
						<div
							class="node card"
							class:sel={selectedId === item.id}
							class:fade={isFaded(n.id)}
							use:nodeRef={n}
							onpointerdown={(e) => nodeDown(e, n)}
							onpointermove={nodeMove}
							onpointerup={(e) => nodeUp(e, n)}
							onpointercancel={(e) => nodeUp(e, n)}
							role="button"
							tabindex={-1}
							aria-label={item.note ? item.note.slice(0, 80) : 'Εικόνα'}
						>
							<div class="shot">
								{#if data.urls[item.image_path]}
									<img
										src={data.urls[item.image_path]}
										alt={item.note ? item.note.slice(0, 80) : ''}
										loading="lazy"
										decoding="async"
										draggable={false}
										onload={() => {
											if (measureOne(n)) reheat(0.35);
										}}
									/>
								{:else}
									<span class="missing">χωρίς εικόνα</span>
								{/if}
								{#if showBoxes}
									{#each regionsOf(item) as r, ri (ri)}
										<div class="region" style={regionStyle(r)}>
											{#if showRegionNotes && r.note}<span class="rnote">{r.note}</span>{/if}
										</div>
									{/each}
								{:else if regionsOf(item).length}
									<span class="rcount">{regionsOf(item).length}</span>
								{/if}
							</div>
							{#if notesOn && item.note}
								<p class="cardnote">{item.note}</p>
							{/if}
						</div>
					{:else if n.kind === 'tag'}
						<div
							class="node tag"
							class:fade={isFaded(n.id)}
							class:on={focusTag === n.label}
							use:nodeRef={n}
							onpointerenter={() => (hoverTag = n.label)}
							onpointerleave={() => (hoverTag = hoverTag === n.label ? null : hoverTag)}
							onpointerdown={(e) => nodeDown(e, n)}
							onpointermove={nodeMove}
							onpointerup={(e) => nodeUp(e, n)}
							onpointercancel={(e) => nodeUp(e, n)}
							role="button"
							tabindex={-1}
							aria-label={`Tag ${n.label}`}
						>
							<span>#{n.label}</span>
							<button
								type="button"
								class="addtag"
								class:show={hoverTag === n.label || focusTag === n.label}
								aria-label={`Νέα εικόνα με tag ${n.label}`}
								onpointerdown={(e) => e.stopPropagation()}
								onclick={(e) => {
									e.stopPropagation();
									openAdd({ tags: [n.label] });
								}}
							>
								+
							</button>
						</div>
					{:else}
						<div
							class="node pill"
							class:orphan={n.orphan}
							class:fade={isFaded(n.id)}
							use:nodeRef={n}
							onpointerdown={(e) => nodeDown(e, n)}
							onpointermove={nodeMove}
							onpointerup={(e) => nodeUp(e, n)}
							onpointercancel={(e) => nodeUp(e, n)}
							role="button"
							tabindex={-1}
							aria-label={n.label}
						>
							{n.label}
						</div>
					{/if}
				{/each}
			</div>

			{#if data.inspirations.length === 0}
				<p class="empty">
					Δεν υπάρχουν ακόμα εικόνες.
					<a href="/new">Πρόσθεσε την πρώτη →</a>
					<span class="sub">ή κάνε paste μια εικόνα εδώ</span>
				</p>
			{:else if filtered.length === 0}
				<p class="empty small">Καμία εικόνα με αυτά τα φίλτρα.</p>
			{/if}
		</div>
	{/if}

	{#if selected}
		{@const item = selected}
		<aside class="panel" aria-label="Λεπτομέρειες εικόνας">
			<div class="phead">
				<span class="ptitle">{item.level ? LEVEL_LABELS[item.level] : 'Εικόνα'}</span>
				<button type="button" class="close" onclick={() => (selectedId = null)} aria-label="Κλείσιμο">×</button>
			</div>

			<div class="pshot">
				{#if data.urls[item.image_path]}
					<img src={data.urls[item.image_path]} alt="" decoding="async" />
				{/if}
				{#each regionsOf(item) as r, ri (ri)}
					<div class="region" style={regionStyle(r)}>
						<span class="rnum">{ri + 1}</span>
						{#if r.note}<span class="rnote">{r.note}</span>{/if}
					</div>
				{/each}
			</div>

			{#if regionsOf(item).length}
				<ol class="rlist">
					{#each regionsOf(item) as r, ri (ri)}
						<li><span class="rnum2">{ri + 1}</span><span>{r.note || '—'}</span></li>
					{/each}
				</ol>
			{/if}

			{#if item.note}<p class="pnote">{item.note}</p>{/if}

			{#if tagsOf(item).length}
				<div class="chips">
					{#each tagsOf(item) as t (t)}
						<button type="button" class="chip" onclick={() => (focusTag = t)}>#{t}</button>
					{/each}
				</div>
			{/if}

			{#if isHttp(item.source_url)}
				<a class="plink" href={item.source_url} target="_blank" rel="noopener">
					{item.source_title || item.source_url}
				</a>
			{/if}

			<div class="pactions">
				<a class="btn primary" href={`/i/${item.id}`}>Επεξεργασία</a>
				<select bind:value={copyTarget} onchange={(e) => copySelected(e.currentTarget.value)} aria-label="Αντιγραφή σε project">
					<option value="">Αντιγραφή σε project…</option>
					<option value={NO_PROJECT}>Χωρίς project</option>
					{#each data.projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
				</select>
			</div>
		</aside>
	{/if}

	{#if toast}<p class="toast">{toast}</p>{/if}
</div>

{#if quickAdd.open && data.userId}
	<QuickAdd
		supabase={data.supabase}
		userId={data.userId}
		projects={data.projects}
		file={quickAdd.file}
		tags={quickAdd.tags}
		projectId={quickAdd.projectId}
		suggestions={data.tags}
		onclose={closeAdd}
		onsaved={(id) => {
			closeAdd();
			selectedId = id;
			void invalidate('moodboard:data');
		}}
	/>
{/if}

<style>
	.page {
		position: fixed;
		inset: 0;
		display: flex;
		flex-direction: column;
		background: var(--bg);
		overflow: hidden;
	}

	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		border-bottom: 1px solid var(--line);
		background: var(--surface);
		min-width: 0;
	}
	.back {
		display: inline-flex;
		align-items: center;
		border-radius: 8px;
		padding: 0.4rem 0.7rem;
		border: 1px solid var(--line);
		text-decoration: none;
		white-space: nowrap;
		font-size: 0.9rem;
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		min-width: 0;
		flex: 1 1 auto;
	}
	.controls select { min-width: 0; max-width: 100%; }
	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		color: var(--muted);
		font-size: 0.82rem;
		white-space: nowrap;
	}
	.toggle input { accent-color: var(--accent); margin: 0; }
	.sizer {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--muted);
		font-size: 0.82rem;
		min-width: 0;
	}
	.sizer input { width: 108px; max-width: 100%; padding: 0; accent-color: var(--accent); }
	.sizerVal { font-variant-numeric: tabular-nums; min-width: 2.6ch; }
	.controls button { padding: 0.38rem 0.7rem; font-size: 0.82rem; }
	button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }

	.stage {
		position: relative;
		flex: 1;
		min-height: 0;
		overflow: hidden;
		touch-action: none;
		cursor: grab;
		background: var(--bg);
	}
	.edges {
		position: absolute;
		left: 0;
		top: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
		overflow: visible;
	}
	.edges line {
		stroke: var(--line);
		stroke-width: 1.4;
		opacity: 0.9;
	}
	.edges line.fade { opacity: 0.15; }

	.world {
		position: absolute;
		left: 0;
		top: 0;
		width: 0;
		height: 0;
		transform-origin: 0 0;
	}

	.node {
		position: absolute;
		left: 0;
		top: 0;
		transform: translate(-50%, -50%);
		user-select: none;
		cursor: grab;
		transition: opacity 0.15s ease;
	}
	.node.fade { opacity: 0.2; }

	.card {
		width: var(--card, 160px);
		display: flex;
		flex-direction: column;
		border-radius: 12px;
		background: var(--surface);
		border: 1px solid var(--line);
		box-shadow: 0 2px 10px rgba(0, 0, 0, 0.07);
		overflow: hidden;
	}
	.card.sel { outline: 2px solid var(--accent); outline-offset: 2px; }
	.shot { position: relative; background: var(--bg); line-height: 0; min-height: 8px; }
	.shot img { display: block; width: 100%; height: auto; }
	.missing {
		display: block;
		padding: 24px 8px;
		text-align: center;
		color: var(--muted);
		font-size: 11px;
		line-height: 1.3;
	}
	.region {
		position: absolute;
		border: 2px solid var(--accent);
		border-radius: 3px;
		box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.2);
		pointer-events: none;
	}
	.rnote {
		position: absolute;
		top: 0;
		left: 0;
		max-width: 100%;
		background: rgba(0, 0, 0, 0.62);
		color: #fff;
		font-size: 10px;
		line-height: 1.25;
		padding: 2px 5px;
		border-radius: 0 0 4px 0;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		word-break: break-word;
	}
	.rnum {
		position: absolute;
		top: 0;
		left: 0;
		background: var(--accent);
		color: #fff;
		font-size: 11px;
		font-weight: 700;
		line-height: 1;
		padding: 3px 5px;
		border-radius: 0 0 4px 0;
	}
	.rcount {
		position: absolute;
		top: 6px;
		right: 6px;
		background: var(--accent);
		color: #fff;
		font-size: 11px;
		line-height: 1;
		padding: 3px 6px;
		border-radius: 999px;
	}
	.cardnote {
		margin: 0;
		padding: 6px 8px 8px;
		font-size: 12px;
		line-height: 1.35;
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.tag {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 999px;
		padding: 2px 9px;
		color: var(--muted);
		font-size: 11px;
		white-space: nowrap;
	}
	.tag.on { border-color: var(--accent); color: var(--accent); }
	.addtag {
		width: 17px;
		height: 17px;
		margin-right: -5px;
		padding: 0;
		border-radius: 999px;
		border: 1px solid var(--accent);
		background: var(--accent);
		color: #fff;
		font-size: 12px;
		line-height: 1;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.12s ease;
	}
	.addtag.show { opacity: 1; pointer-events: auto; }

	.pill {
		background: var(--accent);
		color: #fff;
		border-radius: 999px;
		padding: 6px 14px;
		font-size: 12px;
		font-weight: 600;
		white-space: nowrap;
		max-width: 220px;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.pill.orphan {
		background: var(--surface);
		color: var(--muted);
		border: 1px solid var(--line);
		font-weight: 500;
	}

	.empty {
		position: absolute;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		margin: 0;
		text-align: center;
		color: var(--muted);
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 12px;
		padding: 14px 18px;
		font-size: 0.88rem;
		line-height: 1.7;
		max-width: min(360px, 86vw);
	}
	.empty a { color: var(--accent); text-decoration: none; white-space: nowrap; }
	.empty .sub { display: block; font-size: 0.78rem; opacity: 0.8; }
	.empty.small { padding: 8px 14px; border-radius: 999px; font-size: 0.82rem; }

	.msg { color: var(--muted); padding: 32px 16px; margin: 0; }

	.panel {
		position: fixed;
		top: 0;
		right: 0;
		width: 360px;
		max-width: 100vw;
		height: 100%;
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px 14px calc(14px + env(safe-area-inset-bottom));
		background: var(--surface);
		border-left: 1px solid var(--line);
		box-shadow: -8px 0 24px rgba(0, 0, 0, 0.12);
		overflow-y: auto;
		overscroll-behavior: contain;
		z-index: 20;
	}
	.phead { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
	.ptitle { font-weight: 600; font-size: 0.92rem; }
	.close {
		border: none;
		background: none;
		font-size: 1.35rem;
		line-height: 1;
		padding: 0 4px;
		color: var(--muted);
		border-radius: 6px;
	}
	.close:hover { color: var(--text); background: var(--bg); }
	.pshot {
		position: relative;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 10px;
		overflow: hidden;
		line-height: 0;
	}
	.pshot img { display: block; width: 100%; height: auto; }
	.rlist {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 0.82rem;
	}
	.rlist li { display: flex; gap: 7px; align-items: baseline; }
	.rnum2 {
		flex: 0 0 auto;
		width: 18px;
		height: 18px;
		border-radius: 999px;
		background: var(--accent);
		color: #fff;
		font-size: 10px;
		font-weight: 700;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	.pnote {
		margin: 0;
		font-size: 0.86rem;
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.chips { display: flex; flex-wrap: wrap; gap: 5px; }
	.chip {
		border-radius: 999px;
		padding: 2px 9px;
		font-size: 0.76rem;
		background: var(--bg);
		color: var(--muted);
	}
	.chip:hover { border-color: var(--accent); color: var(--accent); }
	.plink {
		color: var(--accent);
		font-size: 0.8rem;
		text-decoration: none;
		word-break: break-all;
	}
	.plink:hover { text-decoration: underline; }
	.pactions { display: flex; flex-direction: column; gap: 8px; margin-top: auto; }
	.pactions select { width: 100%; }
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		text-decoration: none;
		border-radius: 8px;
		padding: 0.45rem 0.9rem;
		border: 1px solid var(--line);
	}
	.toast {
		position: fixed;
		left: 50%;
		bottom: 24px;
		transform: translateX(-50%);
		margin: 0;
		background: var(--text);
		color: var(--bg);
		padding: 8px 16px;
		border-radius: 999px;
		font-size: 0.82rem;
		z-index: 40;
		box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22);
	}

	@media (max-width: 560px) {
		.bar { padding: 6px 10px; gap: 6px; }
		.controls { gap: 6px; }
		.controls select { flex: 1 1 132px; }
		.panel {
			top: auto;
			left: 0;
			right: 0;
			width: auto;
			height: auto;
			max-height: 70vh;
			border-left: none;
			border-top: 1px solid var(--line);
			border-radius: 14px 14px 0 0;
			box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.18);
		}
	}
</style>
