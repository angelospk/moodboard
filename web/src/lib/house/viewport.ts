// The 3D viewport of the house editor: renderer, camera, controls, and the drawing tools.
//
// Input rules (mouse, touch and pen through Pointer Events):
// - Select and paint: one finger or the left button orbits; a tap picks an element.
// - Drawing tools (wall, slab, window, door, pool, box): one pointer draws (mouse left, pen, one
//   finger); orbit with the right button, or switch to Select.
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
import {
	DEFAULTS,
	fitOpening,
	nearestOnWall,
	newElementId,
	isSimplePolygon,
	round6,
	snapAngle,
	snapPoint,
	wallCorners,
	type Element,
	type HouseModel,
	type Opening,
	type Vec2,
	type Wall
} from './model.js';

export type Tool = 'select' | 'paint' | 'wall' | 'slab' | 'window' | 'door' | 'pool' | 'box';

export const DRAW_TOOLS: Tool[] = ['wall', 'slab', 'window', 'door', 'pool', 'box'];

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
	#frame = 0;

	model: HouseModel = { schema: 'moodboard.house/v1', units: 'm', elements: [] };
	tool: Tool = 'select';
	selected: string | null = null;
	paintMaterial = 'plaster_white';
	grid = 0.25;
	/** Snap the wall direction to 15° steps (Shift flips it for one move). */
	angleSnap = false;

	// Drawing state
	#points: Vec2[] = [];
	#cursor: Vec2 | null = null;
	#rectStart: Vec2 | null = null;
	#press: { id: number; x: number; y: number; type: string; cancelled: boolean; plan: Vec2 | null } | null = null;
	#touches = new Set<number>();
	/** When the last wall/slab corner was placed: a quick second tap on it finishes the draft. */
	#placedAt = 0;
	#shift = false;

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
		this.#ro.disconnect();
		window.removeEventListener('keydown', this.#key);
		window.removeEventListener('keyup', this.#key);
		this.controls.dispose();
		this.#scene.remove(this.#house, this.#ghost, this.#helpers);
		disposeHouse(this.#house);
		this.#clearGhost();
		this.#selectBox?.dispose();
		this.#ghostMat.dispose();
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
	}

	// ------------------------------------------------------------------ Public API

	setModel(model: HouseModel) {
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
		this.cancelDraft();
		this.tool = tool;
		this.#applyControls();
		this.#emitDraft();
	}

	setSelected(id: string | null) {
		this.selected = id;
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
		const min = this.tool === 'wall' ? 2 : 3;
		this.on.draft({ tool: this.tool, points: this.#points.length, length, canFinish: this.#points.length >= min });
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
		const corners = [...wallCorners(this.model), ...this.#points];
		// While drawing, the first point closes the shape: always offer it.
		const s = snapPoint(p, this.grid, corners, 0.3);
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
		}
	};

	#cancelPointer = (e: PointerEvent) => {
		this.#touches.delete(e.pointerId);
		if (this.#press?.id === e.pointerId) this.#press = null;
		if (this.#rectStart) {
			this.#rectStart = null;
			this.#clearGhost();
			this.render();
		}
	};

	#leave = (e: PointerEvent) => {
		// A pen or mouse that hovers away hides the preview; a finger lifting fires leave too, keep it.
		if (e.pointerType === 'touch' || this.#press) return;
		if (this.tool === 'window' || this.tool === 'door') {
			this.#clearGhost();
			this.render();
		}
	};

	#key = (e: KeyboardEvent) => {
		if (e.key !== 'Shift') return;
		this.#shift = e.type === 'keydown';
	};

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
					if (o.material !== this.#ghostMat) (o.material as MeshBasicMaterial).dispose();
				}
			});
		}
	}

	#ghostOf(model: HouseModel) {
		const g = buildHouse(model);
		g.traverse((o) => {
			if (o instanceof Mesh) {
				(o.material as MeshStandardMaterial).dispose();
				o.material = this.#ghostMat;
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

	#preview(e: PointerEvent) {
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
			this.#showLength(e);
		} else if ((tool === 'pool' || tool === 'box') && c) {
			const a = this.#rectStart;
			const d = DEFAULTS[tool];
			const el = a
				? { center: [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2] as Vec2, width: Math.max(0.1, Math.abs(c[0] - a[0])), length: Math.max(0.1, Math.abs(c[1] - a[1])) }
				: { center: c, width: d.width, length: d.length };
			const common = { id: 'ghost', name: '', material: '', rotation: 0, ...el };
			this.#ghostOf({ ...this.model, elements: [tool === 'pool' ? { ...common, type: 'pool', depth: 0.3 } : { ...common, type: 'box', height: DEFAULTS.box.height, base: 0 }] });
			if (a) this.#showDims(e, el.width, el.length);
			else this.#label.hidden = true;
		} else if (tool === 'window' || tool === 'door') {
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
