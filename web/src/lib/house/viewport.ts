// The 3D viewport of the house editor: renderer, camera, controls, and the drawing tools.
//
// Input rules (mouse, touch and pen through Pointer Events):
// - Select and paint: one finger or the left button orbits; a tap picks an element.
// - Drawing tools (wall, slab, window, door, pool, box, item): one pointer draws (mouse left, pen,
//   one finger); orbit with the right button, or switch to Select.
// - Select with an element selected: a press on one of its handles drags it instead of orbiting.
//   The drag previews in the ghost layer and commits once on release; Escape, undo or a second
//   finger cancels it. Alt (held) turns snapping off.
// - Always: two fingers pan and pinch-zoom, the wheel zooms, the middle button dollies.
// A tap is a press and release that moved less than a few pixels with no second finger in between.
//
// The page owns the model. The viewport shows a copy (setModel) and reports every finished edit with
// onCommit(nextModel); it never changes the model itself.
import {
	Box3,
	BoxHelper,
	BufferGeometry,
	Color,
	DirectionalLight,
	Float32BufferAttribute,
	GridHelper,
	Group,
	HemisphereLight,
	LineBasicMaterial,
	MOUSE,
	Mesh,
	MeshBasicMaterial,
	MeshStandardMaterial,
	Object3D,
	PerspectiveCamera,
	Plane,
	PlaneGeometry,
	Points,
	PointsMaterial,
	Raycaster,
	Scene,
	ShadowMaterial,
	TOUCH,
	Vector2,
	Vector3,
	WebGLRenderer
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildHouse, disposeHouse, toPlan } from './scene.js';
import { newItem } from './catalog.js';
import { DragSession } from './gesture.js';
import { handleAt, handlesFor, type Handle } from './handles.js';
import { dragSnapper, dragStart, drawSnap, handleElevation, previewScope } from './interaction.js';
import { pointAtLength } from './snap.js';
import {
	DEFAULTS,
	fitOpening,
	nearestOnWall,
	newElementId,
	isSimplePolygon,
	round6,
	snapAngle,
	wallCorners,
	type Element,
	type HouseModel,
	type ItemKind,
	type Opening,
	type Vec2,
	type Wall
} from './model.js';

export type Tool = 'select' | 'paint' | 'wall' | 'slab' | 'window' | 'door' | 'pool' | 'box' | 'item';

export const DRAW_TOOLS: Tool[] = ['wall', 'slab', 'window', 'door', 'pool', 'box', 'item'];

export interface DraftInfo {
	tool: Tool;
	/** Points placed so far (wall, slab). */
	points: number;
	/** Length of the segment under the cursor, metres. */
	length: number | null;
	/** The draft can be finished now (wall ≥ 2 points, slab ≥ 3). */
	canFinish: boolean;
}

export interface ViewportEvents {
	commit: (next: HouseModel) => void;
	select: (id: string | null) => void;
	draft: (info: DraftInfo | null) => void;
	/** A drag ended on a position the model refuses (an opening loses its hole, a slab crosses itself). */
	refused: () => void;
}

/** One handle drag in progress. */
interface Drag {
	session: DragSession;
	pointerId: number;
	pointerType: string;
	handle: Handle;
	/** The committed model when the drag started. */
	original: HouseModel;
	/** Elevation of the drag plane (the handle's height). */
	z: number;
	/** Screen point of the press; the drag starts once the pointer leaves the tap radius. */
	x: number;
	y: number;
	far: boolean;
	/** Latest plan point not yet previewed (one preview per animation frame). */
	pending: Vec2 | null;
	frame: number;
	preview: HouseModel | null;
	invalid: boolean;
}

const TAP_PX = { mouse: 5, pen: 6, touch: 12 } as Record<string, number>;
const DOUBLE_TAP_MS = 350;
/** Taps closer than this to a wall (metres) place a window or door on it. */
const WALL_REACH = 0.8;

/** Resolve a CSS colour (also var() and light-dark()) to a three.js Color through a hidden probe. */
function cssColor(host: HTMLElement, value: string, fallback: string): Color {
	const probe = document.createElement('span');
	probe.style.cssText = `position:absolute;visibility:hidden;color:${value}`;
	host.append(probe);
	const c = getComputedStyle(probe).color;
	probe.remove();
	const m = c.match(/\d+(\.\d+)?/g);
	if (!m || m.length < 3) return new Color(fallback);
	return new Color().setRGB(+m[0] / 255, +m[1] / 255, +m[2] / 255, 'srgb');
}

function elementOf(o: Object3D | null): Object3D | null {
	for (let p = o; p; p = p.parent) if (p.userData?.id) return p;
	return null;
}

export class HouseViewport {
	readonly renderer: WebGLRenderer;
	readonly camera = new PerspectiveCamera(45, 1, 0.1, 2000);
	readonly controls: OrbitControls;
	#scene = new Scene();
	#house: Group = new Group();
	#ghost = new Group();
	#helpers = new Group();
	#grid: GridHelper;
	#selectBox: BoxHelper | null = null;
	#label: HTMLDivElement;
	#ro: ResizeObserver;
	#ray = new Raycaster();
	#ground = new Plane(new Vector3(0, 1, 0), 0);
	#accent: Color;
	#ghostMat: MeshStandardMaterial;
	#badMat: MeshStandardMaterial;
	#overlay: SVGSVGElement;
	#frame = 0;

	model: HouseModel = { schema: 'moodboard.house/v1', units: 'm', elements: [] };
	tool: Tool = 'select';
	selected: string | null = null;
	paintMaterial = 'plaster_white';
	grid = 0.25;
	/** Snap the wall direction to 15° steps (Shift flips it for one move). */
	angleSnap = false;
	/** Catalog kind the item tool places. */
	itemKind: ItemKind = 'sofa';
	/** Counters for browser checks: full scene builds, and ms of drag preview work per frame. */
	readonly stats = { builds: 0, previewMs: [] as number[] };

	// Drawing state
	#points: Vec2[] = [];
	#cursor: Vec2 | null = null;
	#rectStart: Vec2 | null = null;
	#press: { id: number; x: number; y: number; type: string; cancelled: boolean; plan: Vec2 | null } | null = null;
	#touches = new Set<number>();
	/** When the last wall/slab corner was placed: a quick second tap on it finishes the draft. */
	#placedAt = 0;
	#shift = false;
	#alt = false;
	/** Direction of the last typed-length segment: the next typed length goes on straight when the cursor gives none. */
	#lastDir: Vec2 = [1, 0];
	#drag: Drag | null = null;
	/** Pointers of a gesture that cancelled a drag: ignored (no orbit, no tap) until they lift. */
	#swallow = new Set<number>();
	#hover: Handle | null = null;

	constructor(
		private host: HTMLElement,
		private on: ViewportEvents
	) {
		this.renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
		this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
		this.renderer.shadowMap.enabled = true;
		this.renderer.setClearColor(0x000000, 0);
		const canvas = this.renderer.domElement;
		canvas.style.cssText = 'display:block;width:100%;height:100%;outline:none';
		canvas.setAttribute('aria-label', 'house-3d-canvas');
		host.append(canvas);

		this.#label = document.createElement('div');
		this.#label.className = 'vp-label';
		this.#label.hidden = true;
		host.append(this.#label);

		this.#accent = cssColor(host, 'var(--accent)', '#b4532a');
		const lineColor = cssColor(host, 'var(--line-strong)', '#c9c1b2');
		const faint = cssColor(host, 'var(--line)', '#e0dacf');
		this.#ghostMat = new MeshStandardMaterial({ color: this.#accent, transparent: true, opacity: 0.45, depthWrite: false });
		this.#badMat = new MeshStandardMaterial({ color: 0xd2382c, transparent: true, opacity: 0.5, depthWrite: false });

		// Handles of the selected element: an SVG layer over the canvas, redrawn with every frame.
		this.#overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		this.#overlay.classList.add('vp-handles');
		this.#overlay.setAttribute('aria-hidden', 'true');
		host.append(this.#overlay);

		// Light: soft sky plus one sun that casts shadows onto a ground that shows only shadows,
		// so the CSS canvas colour of the page stays the background.
		this.#scene.add(new HemisphereLight(0xffffff, 0x8d8a84, 1.8));
		const sun = new DirectionalLight(0xffffff, 2.2);
		sun.position.set(18, 30, 12);
		sun.castShadow = true;
		sun.shadow.mapSize.set(2048, 2048);
		Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 120 });
		sun.shadow.bias = -0.0005;
		this.#scene.add(sun);
		const ground = new Mesh(new PlaneGeometry(400, 400), new ShadowMaterial({ opacity: 0.12 }));
		ground.rotation.x = -Math.PI / 2;
		ground.receiveShadow = true;
		ground.raycast = () => {};
		this.#scene.add(ground);

		this.#grid = new GridHelper(100, 100, lineColor, faint);
		this.#grid.position.y = 0.001;
		this.#grid.raycast = () => {};
		this.#scene.add(this.#grid);
		const major = new GridHelper(100, 20, lineColor, lineColor);
		major.position.y = 0.002;
		major.raycast = () => {};
		this.#scene.add(major);

		this.#scene.add(this.#house, this.#ghost, this.#helpers);

		this.camera.position.set(14, 12, 14);
		this.controls = new OrbitControls(this.camera, canvas);
		this.controls.maxPolarAngle = Math.PI / 2 - 0.02; // never below the ground
		this.controls.minDistance = 1;
		this.controls.maxDistance = 400;
		this.controls.zoomToCursor = true;
		this.controls.addEventListener('change', () => this.render());
		this.#applyControls();

		// Capture phase on the host: a press on a handle is taken before OrbitControls sees it.
		host.addEventListener('pointerdown', this.#downCapture, { capture: true });
		canvas.addEventListener('pointerdown', this.#down);
		canvas.addEventListener('pointermove', this.#move);
		canvas.addEventListener('pointerup', this.#up);
		canvas.addEventListener('pointercancel', this.#cancelPointer);
		canvas.addEventListener('pointerleave', this.#leave);
		canvas.addEventListener('contextmenu', (e) => e.preventDefault());
		window.addEventListener('keydown', this.#key);
		window.addEventListener('keyup', this.#key);

		this.#ro = new ResizeObserver(() => this.#resize());
		this.#ro.observe(host);
		this.#resize();
	}

	dispose() {
		cancelAnimationFrame(this.#frame);
		if (this.#drag) cancelAnimationFrame(this.#drag.frame);
		this.#ro.disconnect();
		this.host.removeEventListener('pointerdown', this.#downCapture, { capture: true });
		window.removeEventListener('keydown', this.#key);
		window.removeEventListener('keyup', this.#key);
		this.controls.dispose();
		this.#scene.remove(this.#house, this.#ghost, this.#helpers);
		disposeHouse(this.#house);
		this.#clearGhost();
		this.#selectBox?.dispose();
		this.#ghostMat.dispose();
		this.#badMat.dispose();
		// Grid, ground and lights: everything else the scene owns.
		this.#scene.traverse((o) => {
			const m = o as Partial<Mesh>;
			m.geometry?.dispose();
			const mat = m.material as { dispose?: () => void } | { dispose?: () => void }[] | undefined;
			for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) x.dispose?.();
			(o as { shadow?: { dispose?: () => void } }).shadow?.dispose?.();
		});
		this.renderer.dispose();
		this.renderer.forceContextLoss();
		this.renderer.domElement.remove();
		this.#label.remove();
		this.#overlay.remove();
	}

	// ------------------------------------------------------------------ Public API

	setModel(model: HouseModel) {
		this.cancelDrag();
		this.stats.builds++;
		this.model = model;
		this.#scene.remove(this.#house);
		disposeHouse(this.#house);
		this.#house = buildHouse(model, { edges: true });
		this.#scene.add(this.#house);
		this.#updateSelection();
		this.render();
	}

	setTool(tool: Tool) {
		if (tool === this.tool) return;
		this.cancelDrag();
		this.cancelDraft();
		this.tool = tool;
		this.#applyControls();
		this.#emitDraft();
	}

	setSelected(id: string | null) {
		if (id !== this.selected) this.cancelDrag();
		this.selected = id;
		this.#hover = null;
		this.#updateSelection();
		this.render();
	}

	/** Finish the wall or slab being drawn (the «Τέλος» button, Enter, double tap). Too few corners: keep drawing. */
	finishDraft() {
		const ok = this.tool === 'wall' ? this.#points.length >= 2 : this.tool === 'slab' ? isSimplePolygon(this.#points) : false;
		if (!ok) return;
		if (this.tool === 'wall') {
			const d = DEFAULTS.wall;
			const w: Wall = { id: newElementId(), type: 'wall', name: '', material: d.material, points: this.#points, height: d.height, thickness: d.thickness, base: d.base };
			this.#commitAdd(w);
		} else {
			const d = DEFAULTS.slab;
			this.#commitAdd({ id: newElementId(), type: 'slab', name: '', material: d.material, outline: this.#points, elevation: d.elevation, thickness: d.thickness });
		}
		this.cancelDraft();
	}

	cancelDraft() {
		this.#points = [];
		this.#rectStart = null;
		this.#cursor = null;
		this.#clearGhost();
		this.#label.hidden = true;
		this.#emitDraft();
		this.render();
	}

	get drafting(): boolean {
		return this.#points.length > 0 || this.#rectStart !== null;
	}

	/** Place the next wall corner `metres` from the last one, toward the cursor (typed length). */
	placeByLength(metres: number): boolean {
		if (this.tool !== 'wall' || !this.#points.length || !(metres > 0)) return false;
		const last = this.#points[this.#points.length - 1];
		const c = this.#cursor;
		const toward: Vec2 = c && Math.hypot(c[0] - last[0], c[1] - last[1]) > 1e-6 ? c : [last[0] + this.#lastDir[0], last[1] + this.#lastDir[1]];
		const p = pointAtLength(last, toward, metres);
		const len = Math.hypot(p[0] - last[0], p[1] - last[1]);
		this.#lastDir = [(p[0] - last[0]) / len, (p[1] - last[1]) / len];
		this.#points.push(p);
		this.#placedAt = 0;
		this.#cursor = p;
		this.#preview(null);
		return true;
	}

	get dragging(): boolean {
		return this.#drag !== null;
	}

	/** Stop a handle drag without a commit; the element shows as committed. False when none ran. */
	cancelDrag(): boolean {
		const d = this.#drag;
		if (!d) return false;
		d.session.cancel();
		this.#endDrag();
		return true;
	}

	/** Look straight down (plan) or from the corner (3D); both frame the model. */
	view(kind: 'top' | 'perspective') {
		const box = new Box3().setFromObject(this.#house);
		const center = box.isEmpty() ? new Vector3() : box.getCenter(new Vector3());
		const size = box.isEmpty() ? 12 : Math.max(8, box.getSize(new Vector3()).length());
		const dist = size * 1.2;
		this.controls.target.copy(center).setY(0);
		if (kind === 'top') this.camera.position.set(center.x, dist * 1.3, center.z + 0.001);
		else this.camera.position.set(center.x + dist * 0.75, dist * 0.6, center.z + dist * 0.75);
		this.camera.lookAt(this.controls.target);
		this.controls.update();
		this.render();
	}

	/** A PNG of the current view (for the screenshot / preview flows). */
	snapshot(): string {
		this.#draw();
		return this.renderer.domElement.toDataURL('image/png');
	}

	render() {
		if (this.#frame) return;
		this.#frame = requestAnimationFrame(() => {
			this.#frame = 0;
			this.#draw();
		});
	}

	// ------------------------------------------------------------------ Internals

	#draw() {
		this.#selectBox?.update();
		this.renderer.render(this.#scene, this.camera);
		this.#drawHandles();
	}

	#resize() {
		const w = this.host.clientWidth || 1;
		const h = this.host.clientHeight || 1;
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		this.#draw();
	}

	#applyControls() {
		const draw = DRAW_TOOLS.includes(this.tool);
		// -1 = no action for that button or finger count (OrbitControls falls back to its NONE state).
		this.controls.mouseButtons = draw
			? { LEFT: -1 as MOUSE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE }
			: { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
		this.controls.touches = { ONE: draw ? (-1 as TOUCH) : TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN };
		this.renderer.domElement.style.cursor = draw ? 'crosshair' : 'grab';
	}

	#emitDraft() {
		if (!DRAW_TOOLS.includes(this.tool) || (!this.drafting && !this.#cursor)) {
			this.on.draft(DRAW_TOOLS.includes(this.tool) ? { tool: this.tool, points: 0, length: null, canFinish: false } : null);
			return;
		}
		const last = this.#points[this.#points.length - 1];
		const length = last && this.#cursor ? round6(Math.hypot(this.#cursor[0] - last[0], this.#cursor[1] - last[1])) : null;
		const canFinish = this.tool === 'wall' ? this.#points.length >= 2 : this.tool === 'slab' && isSimplePolygon(this.#points);
		this.on.draft({ tool: this.tool, points: this.#points.length, length, canFinish });
	}

	#ndc(e: PointerEvent): Vector2 {
		const r = this.renderer.domElement.getBoundingClientRect();
		return new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
	}

	/** Point on the ground under the pointer, unsnapped. */
	#groundAt(e: PointerEvent): Vec2 | null {
		this.#ray.setFromCamera(this.#ndc(e), this.camera);
		const hit = this.#ray.ray.intersectPlane(this.#ground, new Vector3());
		return hit ? toPlan(hit) : null;
	}

	#snapped(p: Vec2): Vec2 {
		if (this.#alt) return [round6(p[0]), round6(p[1])];
		const corners = [...wallCorners(this.model), ...this.#points];
		// While drawing, the first point closes the shape: always offer it.
		const s = drawSnap(p, this.model, this.#points, this.grid);
		const last = this.#points[this.#points.length - 1];
		const useAngle = this.angleSnap !== this.#shift;
		if (last && useAngle && !corners.some((c) => c[0] === s[0] && c[1] === s[1])) return snapAngle(last, s, 15);
		return s;
	}

	#pickElement(e: PointerEvent): Object3D | null {
		this.#ray.setFromCamera(this.#ndc(e), this.camera);
		const hits = this.#ray.intersectObjects(this.#house.children, true);
		return hits.length ? elementOf(hits[0].object) : null;
	}

	#down = (e: PointerEvent) => {
		if (e.pointerType === 'touch') this.#touches.add(e.pointerId);
		if (this.#press && this.#press.id !== e.pointerId) {
			// A second finger: this is a pan/zoom gesture, not a tap or a stroke.
			this.#press.cancelled = true;
			if (this.#rectStart) {
				this.#rectStart = null;
				this.#clearGhost();
				this.render();
			}
			return;
		}
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		const plan = this.#groundAt(e);
		this.#press = { id: e.pointerId, x: e.clientX, y: e.clientY, type: e.pointerType, cancelled: this.#touches.size > 1, plan };
		if ((this.tool === 'pool' || this.tool === 'box') && plan && !this.#press.cancelled) this.#rectStart = this.#snapped(plan);
	};

	#move = (e: PointerEvent) => {
		this.#alt = e.altKey;
		const d = this.#drag;
		if (d) {
			if (e.pointerId !== d.pointerId) return;
			if (!d.far) d.far = Math.hypot(e.clientX - d.x, e.clientY - d.y) > (TAP_PX[d.pointerType] ?? 6);
			if (!d.far) return;
			d.pending = this.#planAt(e, d.z);
			if (d.pending && !d.frame) d.frame = requestAnimationFrame(this.#dragFrame);
			return;
		}
		if (this.#swallow.size) return;
		if (!this.#press && e.pointerType !== 'touch' && this.tool === 'select' && this.selected) this.#hoverAt(e);
		if (this.#press && this.#press.id === e.pointerId && !this.#press.cancelled) {
			const far = Math.hypot(e.clientX - this.#press.x, e.clientY - this.#press.y) > (TAP_PX[this.#press.type] ?? 6);
			// Select/paint: a drag is an orbit, not a tap.
			if (far && !DRAW_TOOLS.includes(this.tool)) this.#press.cancelled = true;
		}
		if (this.#touches.size > 1) return;
		if (!DRAW_TOOLS.includes(this.tool)) return;
		const p = this.#groundAt(e);
		if (!p) return;
		this.#cursor = this.#snapped(p);
		this.#preview(e);
	};

	#up = (e: PointerEvent) => {
		this.#touches.delete(e.pointerId);
		if (this.#swallow.delete(e.pointerId)) return;
		const d = this.#drag;
		if (d && d.pointerId === e.pointerId) {
			this.#finishDrag(d, e);
			return;
		}
		const press = this.#press;
		if (!press || press.id !== e.pointerId) return;
		this.#press = null;
		if (press.cancelled) return;
		const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y);
		const tap = moved <= (TAP_PX[press.type] ?? 6);

		if (this.tool === 'pool' || this.tool === 'box') {
			const start = this.#rectStart;
			this.#rectStart = null;
			const end = this.#groundAt(e);
			if (start && end) this.#placeRect(start, tap ? null : this.#snapped(end));
			this.#clearGhost();
			this.render();
			return;
		}
		if (!tap) return;

		const now = performance.now();

		if (this.tool === 'select') {
			const hit = this.#pickElement(e);
			this.on.select((hit?.userData.id as string) ?? null);
		} else if (this.tool === 'paint') {
			const hit = this.#pickElement(e);
			if (hit) this.#paint(hit.userData.id as string);
		} else if (this.tool === 'wall' || this.tool === 'slab') {
			const raw = this.#groundAt(e);
			if (!raw) return;
			const p = this.#snapped(raw);
			const first = this.#points[0];
			const last = this.#points[this.#points.length - 1];
			const same = (q: Vec2 | undefined) => !!q && Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.05;
			// A double tap is a second quick tap on the corner just placed: finish there.
			if (same(last) && now - this.#placedAt < DOUBLE_TAP_MS) return this.finishDraft();
			if (same(first) && this.#points.length >= 3) {
				// Back at the start: close the shape. A wall repeats its first point (a closed loop).
				if (this.tool === 'wall') this.#points.push([first[0], first[1]]);
				return this.finishDraft();
			}
			if (same(last) || same(first)) return; // same point twice, or back at the start too early
			this.#points.push(p);
			this.#placedAt = now;
			this.#cursor = p;
			this.#preview(e);
		} else if (this.tool === 'window' || this.tool === 'door') {
			const o = this.#openingAt(e);
			if (o) this.#commitAdd(o);
		} else if (this.tool === 'item') {
			const raw = this.#groundAt(e);
			if (raw) this.#commitAdd(newItem(this.itemKind, this.#snapped(raw)));
		}
	};

	#cancelPointer = (e: PointerEvent) => {
		this.#touches.delete(e.pointerId);
		this.#swallow.delete(e.pointerId);
		if (this.#drag?.pointerId === e.pointerId) this.cancelDrag();
		if (this.#press?.id === e.pointerId) this.#press = null;
		if (this.#rectStart) {
			this.#rectStart = null;
			this.#clearGhost();
			this.render();
		}
	};

	#leave = (e: PointerEvent) => {
		// A pen or mouse that hovers away hides the preview; a finger lifting fires leave too, keep it.
		if (e.pointerType === 'touch' || this.#press || this.#drag) return;
		if (this.#hover) {
			this.#hover = null;
			this.render();
		}
		if (this.tool === 'window' || this.tool === 'door' || this.tool === 'item') {
			this.#clearGhost();
			this.render();
		}
	};

	#key = (e: KeyboardEvent) => {
		if (e.key === 'Alt') this.#alt = e.type === 'keydown';
		if (e.key !== 'Shift') return;
		this.#shift = e.type === 'keydown';
	};

	// ------------------------------------------------------------------ Handles and drags

	/** Point on the horizontal plane at elevation `z` under the pointer. */
	#planAt(e: { clientX: number; clientY: number }, z: number): Vec2 | null {
		const r = this.renderer.domElement.getBoundingClientRect();
		const ndc = new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
		this.#ray.setFromCamera(ndc, this.camera);
		const hit = this.#ray.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), -z), new Vector3());
		return hit ? toPlan(hit) : null;
	}

	/** Canvas pixel of a plan point at elevation z (null when behind the camera). */
	#project(p: Vec2, z: number): Vec2 | null {
		const v = new Vector3(p[0], z, -p[1]).project(this.camera);
		if (v.z > 1) return null;
		const c = this.renderer.domElement;
		return [((v.x + 1) / 2) * c.clientWidth, ((1 - v.y) / 2) * c.clientHeight];
	}

	/** The selected element (in the drag preview while dragging), its handles and their height. */
	#handleSet(): { el: Element; model: HouseModel; handles: Handle[]; z: number } | null {
		if (this.tool !== 'select' || !this.selected) return null;
		const model = this.#drag?.preview ?? this.model;
		const el = model.elements.find((e) => e.id === this.selected);
		if (!el) return null;
		const host = el.type === 'window' || el.type === 'door' ? model.elements.find((w) => w.id === el.host) : undefined;
		return { el, model, handles: handlesFor(el, host), z: handleElevation(el, model) };
	}

	#handleAt(e: PointerEvent): Handle | null {
		const set = this.#handleSet();
		if (!set) return null;
		const r = this.renderer.domElement.getBoundingClientRect();
		const far: Vec2 = [-1e9, -1e9];
		return handleAt(set.handles, [e.clientX - r.left, e.clientY - r.top], (p) => this.#project(p, set.z) ?? far, e.pointerType);
	}

	#hoverAt(e: PointerEvent) {
		const h = this.#handleAt(e);
		const same = h && this.#hover && h.kind === this.#hover.kind && h.index === this.#hover.index;
		if (same || (!h && !this.#hover)) return;
		this.#hover = h;
		this.renderer.domElement.style.cursor = h ? (h.kind === 'rotate' ? 'alias' : 'move') : 'grab';
		this.render();
	}

	#downCapture = (e: PointerEvent) => {
		if (e.target !== this.renderer.domElement) return;
		const swallow = () => {
			e.stopPropagation();
			e.preventDefault();
			this.#swallow.add(e.pointerId);
		};
		const d = this.#drag;
		if (d) {
			// A second finger (or any other pointer): stop the drag; this gesture does nothing else.
			if (e.pointerId !== d.pointerId) {
				this.#swallow.add(d.pointerId);
				this.cancelDrag();
				swallow();
			}
			return;
		}
		if (this.#swallow.size) return swallow();
		if (this.tool !== 'select' || !this.selected || this.#press || this.#touches.size) return;
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		const handle = this.#handleAt(e);
		const set = handle && this.#handleSet();
		if (!handle || !set) return;
		const press = this.#planAt(e, set.z);
		if (!press) return;
		e.stopPropagation();
		e.preventDefault();
		const original = this.model;
		const snapper = dragSnapper(original, handle, this.grid);
		const session = new DragSession({
			model: original,
			handle,
			pointerId: e.pointerId,
			start: dragStart(handle, press, this.grid),
			// A drag that ends where it started changes nothing: no undo entry, no save.
			commit: (next) => JSON.stringify(next) !== JSON.stringify(original) && this.on.commit(next),
			snap: snapper ? (p) => (this.#alt ? [round6(p[0]), round6(p[1])] : snapper(p)) : undefined
		});
		this.#drag = { session, pointerId: e.pointerId, pointerType: e.pointerType, handle, original, z: set.z, x: e.clientX, y: e.clientY, far: false, pending: null, frame: 0, preview: null, invalid: false };
		this.#alt = e.altKey;
		this.#hover = handle;
		this.controls.enabled = false;
		try {
			this.renderer.domElement.setPointerCapture(e.pointerId);
		} catch {
			/* synthetic pointers may not be capturable */
		}
		this.render();
	};

	#dragFrame = () => {
		const d = this.#drag;
		if (!d) return;
		d.frame = 0;
		if (!d.pending) return;
		const t0 = performance.now();
		const p = d.session.move(d.pointerId, d.pending);
		d.pending = null;
		if (!p) return;
		d.preview = p.model;
		d.invalid = p.invalid;
		const scope = previewScope(d.original, p.model, p.affected);
		this.#clearGhost();
		for (const c of this.#house.children) c.visible = !scope.hide.has(c.userData.id as string);
		if (this.#selectBox) this.#selectBox.visible = false;
		if (scope.model.elements.length) this.#ghostOf(scope.model, p.invalid ? this.#badMat : this.#ghostMat);
		this.stats.previewMs.push(performance.now() - t0);
		if (this.stats.previewMs.length > 500) this.stats.previewMs.shift();
		this.#draw();
	};

	#finishDrag(d: Drag, e: PointerEvent) {
		if (!d.far) {
			// A press on a handle that never moved: nothing to commit.
			this.cancelDrag();
			return;
		}
		// The last pointer position counts even when its frame has not run yet.
		const last = this.#planAt(e, d.z);
		if (last) d.pending = last;
		if (d.frame) cancelAnimationFrame(d.frame);
		this.#dragFrame();
		const refused = d.invalid;
		this.#endDrag();
		const out = d.session.end(d.pointerId);
		if (!out && refused) this.on.refused();
	}

	/** Back to the committed look: no ghost, every element visible, orbit on. */
	#endDrag() {
		const d = this.#drag;
		if (!d) return;
		if (d.frame) cancelAnimationFrame(d.frame);
		this.#drag = null;
		try {
			if (this.renderer.domElement.hasPointerCapture(d.pointerId)) this.renderer.domElement.releasePointerCapture(d.pointerId);
		} catch {
			/* already released */
		}
		this.#clearGhost();
		for (const c of this.#house.children) c.visible = true;
		if (this.#selectBox) this.#selectBox.visible = true;
		this.controls.enabled = true;
		this.#hover = null;
		this.#applyControls();
		this.render();
	}

	/** Draw the handles of the selected element as SVG over the canvas (screen-size marks). */
	#drawHandles() {
		const set = this.#handleSet();
		const svg = this.#overlay;
		if (!set) {
			if (svg.childElementCount) svg.replaceChildren();
			return;
		}
		const active = this.#drag?.handle ?? this.#hover;
		const isActive = (h: Handle) => !!active && active.kind === h.kind && active.index === h.index;
		const bad = this.#drag?.invalid ? ' bad' : '';
		const parts: string[] = [];
		const center = set.handles.find((h) => h.kind === 'center');
		for (const h of set.handles) {
			if (h.kind === 'body') continue;
			const s = this.#project(h.at, set.z);
			if (!s) continue;
			const [x, y] = s.map((v) => Math.round(v * 10) / 10);
			const cls = `h ${h.kind}${isActive(h) ? ' on' : ''}${bad}`;
			if (h.kind === 'mid') {
				parts.push(`<g class="${cls}" transform="translate(${x} ${y})"><rect x="-6" y="-6" width="12" height="12" rx="2"/><path d="M-3.5 0h7M0 -3.5v7"/></g>`);
			} else if (h.kind === 'rotate') {
				// Short stem from the element's far edge to the knob.
				const el = set.el as { length: number };
				const c = center ? this.#project(center.at, set.z) : null;
				if (c && center) {
					const k = el.length / 2 / (el.length / 2 + 0.5);
					const edge = this.#project([center.at[0] + (h.at[0] - center.at[0]) * k, center.at[1] + (h.at[1] - center.at[1]) * k], set.z);
					if (edge) parts.push(`<line class="stem${bad}" x1="${edge[0]}" y1="${edge[1]}" x2="${x}" y2="${y}"/>`);
				}
				parts.push(`<g class="${cls}" transform="translate(${x} ${y})"><circle r="7"/><path d="M-3 1.5a3.2 3.2 0 1 0 1-4.2M-2.4 -4.4l.4 1.9-1.9.3"/></g>`);
			} else if (h.kind === 'center') {
				parts.push(`<g class="${cls}" transform="translate(${x} ${y})"><circle r="7"/><path d="M-3 0h6M0 -3v6"/></g>`);
			} else {
				parts.push(`<g class="${cls}" transform="translate(${x} ${y})"><circle r="6"/></g>`);
			}
		}
		svg.innerHTML = parts.join('');
	}

	// ------------------------------------------------------------------ Tools

	#openingAt(e: PointerEvent): Opening | null {
		const kind = this.tool as 'window' | 'door';
		let wall: Wall | undefined;
		let p: Vec2 | null = null;
		this.#ray.setFromCamera(this.#ndc(e), this.camera);
		const hit = this.#ray.intersectObjects(this.#house.children, true).find((h) => elementOf(h.object)?.userData.type === 'wall');
		if (hit) {
			const id = elementOf(hit.object)!.userData.id as string;
			wall = this.model.elements.find((x): x is Wall => x.id === id && x.type === 'wall');
			p = toPlan(hit.point);
		} else {
			p = this.#groundAt(e);
			if (p) {
				let best = WALL_REACH;
				for (const w of this.model.elements) {
					if (w.type !== 'wall') continue;
					const n = nearestOnWall(w, p);
					if (n && n.distance < best) {
						best = n.distance;
						wall = w;
					}
				}
			}
		}
		if (!wall || !p) return null;
		const n = nearestOnWall(wall, p);
		if (!n) return null;
		const d = DEFAULTS[kind];
		// Openings sit on whole decimetres along the wall, so they line up.
		const offset = Math.round(n.offset * 10) / 10;
		return fitOpening({ id: newElementId(), type: kind, name: '', material: d.material, host: wall.id, segment: n.segment, offset, width: d.width, height: d.height, sill: d.sill }, wall);
	}

	#placeRect(a: Vec2, b: Vec2 | null) {
		const kind = this.tool as 'pool' | 'box';
		const d = DEFAULTS[kind];
		let center: Vec2 = a;
		let width: number = d.width;
		let length: number = d.length;
		if (b && Math.abs(b[0] - a[0]) >= 0.25 && Math.abs(b[1] - a[1]) >= 0.25) {
			center = [round6((a[0] + b[0]) / 2), round6((a[1] + b[1]) / 2)];
			width = round6(Math.abs(b[0] - a[0]));
			length = round6(Math.abs(b[1] - a[1]));
		}
		const base = { id: newElementId(), name: '', material: d.material, center, width, length, rotation: 0 };
		this.#commitAdd(kind === 'pool' ? { ...base, type: 'pool', depth: DEFAULTS.pool.depth } : { ...base, type: 'box', height: DEFAULTS.box.height, base: DEFAULTS.box.base });
	}

	#paint(id: string) {
		const el = this.model.elements.find((x) => x.id === id);
		if (!el || el.material === this.paintMaterial) return;
		this.on.commit({ ...this.model, elements: this.model.elements.map((x) => (x.id === id ? { ...x, material: this.paintMaterial } : x)) });
	}

	/** Add an element. It is not selected: the inspector would cover the canvas while drawing goes on. */
	#commitAdd(el: Element) {
		this.on.commit({ ...this.model, elements: [...this.model.elements, el] });
	}

	// ------------------------------------------------------------------ Preview

	#clearGhost() {
		for (const c of [...this.#ghost.children]) {
			this.#ghost.remove(c);
			c.traverse((o) => {
				if (o instanceof Mesh || o instanceof Points) {
					o.geometry.dispose();
					if (o.material !== this.#ghostMat && o.material !== this.#badMat) (o.material as MeshBasicMaterial).dispose();
				}
			});
		}
	}

	#ghostOf(model: HouseModel, mat = this.#ghostMat) {
		const g = buildHouse(model);
		g.traverse((o) => {
			if (o instanceof Mesh) {
				(o.material as MeshStandardMaterial).dispose();
				o.material = mat;
				o.castShadow = false;
			}
		});
		g.traverse((o) => (o.raycast = () => {}));
		this.#ghost.add(g);
	}

	#dots(points: Vec2[]) {
		const geo = new BufferGeometry();
		geo.setAttribute('position', new Float32BufferAttribute(points.flatMap(([x, y]) => [x, 0.02, -y]), 3));
		const dots = new Points(geo, new PointsMaterial({ color: this.#accent, size: 10, sizeAttenuation: false, depthTest: false }));
		dots.renderOrder = 10;
		dots.raycast = () => {};
		this.#ghost.add(dots);
	}

	/** Redraw the draft ghost; `e` places the length label (null after a typed length: no label). */
	#preview(e: PointerEvent | null) {
		this.#clearGhost();
		const tool = this.tool;
		const c = this.#cursor;
		if ((tool === 'wall' || tool === 'slab') && c) {
			const pts = [...this.#points, c];
			const d = DEFAULTS.wall;
			if (pts.length >= 2) {
				if (tool === 'wall') this.#ghostOf({ ...this.model, elements: [{ id: 'ghost', type: 'wall', name: '', material: '', points: pts, height: d.height, thickness: d.thickness, base: 0 }] });
				else if (pts.length >= 3) this.#ghostOf({ ...this.model, elements: [{ id: 'ghost', type: 'slab', name: '', material: '', outline: pts, elevation: 0.02, thickness: 0.02 }] });
			}
			this.#dots(pts);
			if (e) this.#showLength(e);
			else this.#label.hidden = true;
		} else if ((tool === 'pool' || tool === 'box') && c) {
			const a = this.#rectStart;
			const d = DEFAULTS[tool];
			const el = a
				? { center: [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2] as Vec2, width: Math.max(0.1, Math.abs(c[0] - a[0])), length: Math.max(0.1, Math.abs(c[1] - a[1])) }
				: { center: c, width: d.width, length: d.length };
			const common = { id: 'ghost', name: '', material: '', rotation: 0, ...el };
			this.#ghostOf({ ...this.model, elements: [tool === 'pool' ? { ...common, type: 'pool', depth: 0.3 } : { ...common, type: 'box', height: DEFAULTS.box.height, base: 0 }] });
			if (a && e) this.#showDims(e, el.width, el.length);
			else this.#label.hidden = true;
		} else if (tool === 'item' && c) {
			this.#ghostOf({ ...this.model, elements: [{ ...newItem(this.itemKind, c), id: 'ghost' }] });
		} else if ((tool === 'window' || tool === 'door') && e) {
			const o = this.#openingAt(e);
			if (o) {
				const host = this.model.elements.find((x) => x.id === o.host)!;
				this.#ghostOf({ ...this.model, elements: [host, o] });
				// Only the opening, not its host wall copy.
				const g = this.#ghost.children[this.#ghost.children.length - 1];
				for (const ch of [...g.children]) if (ch.userData.type === 'wall') g.remove(ch);
			}
		}
		this.#emitDraft();
		this.render();
	}

	#showLength(e: PointerEvent) {
		const last = this.#points[this.#points.length - 1];
		const c = this.#cursor;
		if (!last || !c) {
			this.#label.hidden = true;
			return;
		}
		this.#placeLabel(e, `${Math.hypot(c[0] - last[0], c[1] - last[1]).toFixed(2)} m`);
	}

	#showDims(e: PointerEvent, w: number, l: number) {
		this.#placeLabel(e, `${w.toFixed(2)} × ${l.toFixed(2)} m`);
	}

	#placeLabel(e: PointerEvent, text: string) {
		const r = this.host.getBoundingClientRect();
		this.#label.textContent = text;
		this.#label.hidden = false;
		// Above-right of the pointer; a finger would cover a label placed under it.
		this.#label.style.transform = `translate(${e.clientX - r.left + 14}px, ${e.clientY - r.top - 40}px)`;
	}

	#updateSelection() {
		if (this.#selectBox) {
			this.#helpers.remove(this.#selectBox);
			this.#selectBox.dispose();
			this.#selectBox = null;
		}
		if (!this.selected) return;
		const obj = this.#house.children.find((c) => c.userData.id === this.selected);
		if (!obj) return;
		this.#selectBox = new BoxHelper(obj, this.#accent);
		(this.#selectBox.material as LineBasicMaterial).depthTest = false;
		this.#selectBox.renderOrder = 20;
		this.#helpers.add(this.#selectBox);
	}
}
