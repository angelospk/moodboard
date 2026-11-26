// three.js view of a sketch: active plane with grid, volumes (flat shaded + edges), pen strokes,
// a live draft, selection, picking. Renders on demand. Fingers/mouse-right orbit via OrbitControls;
// the editor keeps pen and mouse-left events away from the controls.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { Element, Material, Plane } from './doc.js';
import { normal, toWorld, type Ray, type V2, type V3 } from './geom.js';
import { volumeMesh } from './mesh.js';

export interface Pick {
	id: string;
	el: Element;
}
export interface Draft {
	plane: Plane;
	pts: V2[];
	closed?: boolean;
	/** Push/pull preview: outline extruded by h. */
	h?: number;
	wall?: number | null;
	mat?: Material;
}
export interface Scene {
	els: Map<string, Element>;
	planes: Plane[];
	active: Plane;
	selected: string | null;
	/** Elements hidden while a draft stands in for them (push/pull). */
	hidden?: ReadonlySet<string>;
	draft: Draft | null;
}

const MAT_COLORS: Record<Material, string> = {
	plaster: '#f1ede4',
	concrete: '#b9b5ad',
	wood: '#c49668',
	stone: '#c7b694',
	glass: '#a8c6d1',
	marble: '#ece9e4'
};

const ctx2d = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
function cssColor(name: string, host: HTMLElement): THREE.Color {
	// light-dark() values resolve through a probe element's computed color. A 2D canvas then
	// normalises any CSS color syntax (oklch, color(), ...) to #rrggbb or rgba(), which three parses.
	const probe = document.createElement('span');
	probe.style.color = `var(${name})`;
	host.appendChild(probe);
	let c = getComputedStyle(probe).color;
	probe.remove();
	if (ctx2d) {
		ctx2d.fillStyle = '#000';
		ctx2d.fillStyle = c;
		c = ctx2d.fillStyle;
	}
	return new THREE.Color().setStyle(c, THREE.SRGBColorSpace);
}

/** Matrix from plane-local (u, v, n) to world. */
function planeMatrix(p: Plane): THREE.Matrix4 {
	const n = normal(p);
	return new THREE.Matrix4().makeBasis(new THREE.Vector3(...p.u), new THREE.Vector3(...p.v), new THREE.Vector3(...n)).setPosition(...p.o);
}

export class Viewport {
	readonly renderer: THREE.WebGLRenderer;
	readonly camera: THREE.PerspectiveCamera;
	readonly controls: OrbitControls;
	private scene = new THREE.Scene();
	private content = new THREE.Group();
	private planeGroup = new THREE.Group();
	private draftGroup = new THREE.Group();
	private lineMats: LineMaterial[] = [];
	private raf = 0;
	private model: Scene | null = null;
	private colors = { ink: new THREE.Color(), accent: new THREE.Color(), line: new THREE.Color(), bg: new THREE.Color(), faint: new THREE.Color() };
	private tween: { from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3]; t0: number } | null = null;
	private ro: ResizeObserver;

	/** Called when what is on screen moves (camera change, resize): screen anchors follow. */
	onView: () => void = () => {};

	constructor(private canvas: HTMLCanvasElement) {
		this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
		this.camera.position.set(14, 11, 16);
		this.controls = new OrbitControls(this.camera, canvas);
		this.controls.target.set(0, 1, 0);
		this.controls.enableDamping = false;
		this.controls.maxDistance = 120;
		this.controls.minDistance = 2;
		// Left button / pen are drawing tools: the editor handles them. Right drag orbits, shift+right pans.
		this.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
		this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
		this.controls.addEventListener('change', () => {
			this.dirty();
			this.onView();
		});
		this.controls.update();

		this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7f70, 1.6));
		const sun = new THREE.DirectionalLight(0xffffff, 1.6);
		sun.position.set(-8, 14, 10);
		this.scene.add(sun);
		this.scene.add(this.planeGroup, this.content, this.draftGroup);
		this.readTheme();
		this.ro = new ResizeObserver(() => this.resize());
		this.ro.observe(canvas);
		this.resize();
	}

	readTheme() {
		const host = this.canvas.parentElement ?? document.documentElement;
		this.colors = { ink: cssColor('--text', host), accent: cssColor('--accent', host), line: cssColor('--line-strong', host), bg: cssColor('--canvas', host), faint: cssColor('--faint', host) };
		this.scene.background = this.colors.bg;
		if (this.model) this.set(this.model);
	}

	private resize() {
		const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
		if (!w || !h) return;
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		for (const m of this.lineMats) m.resolution.set(w, h);
		this.dirty();
		this.onView();
	}

	dirty() {
		if (this.raf) return;
		this.raf = requestAnimationFrame(() => {
			this.raf = 0;
			this.step();
			this.renderer.render(this.scene, this.camera);
		});
	}

	private step() {
		if (!this.tween) return;
		const k = Math.min(1, (performance.now() - this.tween.t0) / 320), e = 1 - Math.pow(1 - k, 3);
		this.camera.position.lerpVectors(this.tween.from[0], this.tween.to[0], e);
		this.controls.target.lerpVectors(this.tween.from[1], this.tween.to[1], e);
		this.controls.update();
		if (k < 1) this.dirty();
		else this.tween = null;
	}

	/** Turn the camera to face a plane from a 3/4 view, keeping the distance. */
	face(p: Plane) {
		const n = new THREE.Vector3(...normal(p));
		const target = this.controls.target.clone();
		const dist = this.camera.position.distanceTo(target);
		const u = new THREE.Vector3(...p.u), v = new THREE.Vector3(...p.v);
		const dir = n.clone().multiplyScalar(0.82).add(u.multiplyScalar(0.35)).add(v.multiplyScalar(0.45)).normalize();
		if (p.id === 'ground') dir.set(0.45, 0.8, 0.55).normalize();
		const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
		const to: [THREE.Vector3, THREE.Vector3] = [target.clone().add(dir.multiplyScalar(dist)), target];
		if (reduce) {
			this.camera.position.copy(to[0]);
			this.controls.update();
			this.dirty();
			return;
		}
		this.tween = { from: [this.camera.position.clone(), target.clone()], to, t0: performance.now() };
		this.dirty();
	}

	/** World ray through a client-space point. */
	ray(clientX: number, clientY: number): Ray {
		const r = this.canvas.getBoundingClientRect();
		const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
		const rc = new THREE.Raycaster();
		rc.setFromCamera(ndc, this.camera);
		return { o: rc.ray.origin.toArray() as V3, d: rc.ray.direction.toArray() as V3 };
	}

	/** Client-space position of a world point (null behind the camera). */
	project(w: V3): { x: number; y: number } | null {
		const v = new THREE.Vector3(...w).project(this.camera);
		if (v.z > 1) return null;
		const r = this.canvas.getBoundingClientRect();
		return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
	}

	/** View centre on the ground, used to clamp drawing. */
	center(): V3 {
		return this.controls.target.toArray() as V3;
	}

	/** Element under a client point: volumes by ray, strokes within `tol` px of their line (or inside a closed one). */
	pick(clientX: number, clientY: number, tol = 14): Pick | null {
		if (!this.model) return null;
		const r = this.canvas.getBoundingClientRect();
		const rc = new THREE.Raycaster();
		rc.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.camera);
		const meshes = this.content.children.filter((o) => o.userData.kind === 'volume' && !this.model!.hidden?.has(o.userData.id));
		const hit = rc.intersectObjects(meshes, false)[0];
		let best: { id: string; d: number } | null = hit ? { id: hit.object.userData.id, d: 0 } : null;
		const planes = new Map(this.model.planes.map((p) => [p.id, p]));
		for (const [id, el] of this.model.els) {
			if (el.type !== 'stroke' || this.model.hidden?.has(id)) continue;
			const p = planes.get(el.plane);
			if (!p) continue;
			const wp = el.pts.map((q) => toWorld(p, q));
			const sp = wp.map((w) => this.project(w));
			if (sp.some((s) => !s)) continue;
			const pts = sp as { x: number; y: number }[];
			let d = Infinity, at: V3 = wp[0];
			const n = el.closed ? pts.length : pts.length - 1;
			for (let i = 0; i < n; i++) {
				const j = (i + 1) % pts.length;
				const s = segDist(clientX, clientY, pts[i], pts[j]);
				if (s.d < d) {
					d = s.d;
					at = [wp[i][0] + (wp[j][0] - wp[i][0]) * s.t, wp[i][1] + (wp[j][1] - wp[i][1]) * s.t, wp[i][2] + (wp[j][2] - wp[i][2]) * s.t];
				}
			}
			if (el.closed && inside(clientX, clientY, pts)) {
				const r = rc.ray, pl = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...normal(p)), new THREE.Vector3(...p.o));
				const x = r.intersectPlane(pl, new THREE.Vector3());
				if (x && tol * 0.9 < d) (d = tol * 0.9), (at = x.toArray() as V3);
			}
			// A stroke hidden behind a volume cannot be picked through it.
			if (hit && this.camera.position.distanceTo(new THREE.Vector3(...at)) > hit.distance + 0.05) continue;
			// A stroke on top of a volume wins only when the pen is really on its line.
			if (d < tol && (!best || d < best.d || (best.d === 0 && d < tol * 0.5))) best = { id, d };
		}
		return best ? { id: best.id, el: this.model.els.get(best.id)! } : null;
	}

	set(m: Scene) {
		this.model = m;
		clear(this.content);
		clear(this.planeGroup);
		clear(this.draftGroup);
		this.lineMats = [];
		const planes = new Map(m.planes.map((p) => [p.id, p]));
		this.drawPlane(m.active);
		for (const [id, el] of m.els) {
			if (m.hidden?.has(id)) continue;
			const p = planes.get(el.plane);
			if (!p) continue;
			const sel = id === m.selected;
			if (el.type === 'volume') this.addVolume(p, el.base, el.h, el.wall, el.mat, sel, id, this.content);
			else this.content.add(this.line(p, el.pts, el.closed, sel ? this.colors.accent : this.colors.ink, sel ? 3.5 : 2.2, { kind: 'stroke', id }));
		}
		this.drawDraft(m.draft);
	}

	/** Replace only the draft (cheap: called on every pen move). */
	setDraft(d: Draft | null) {
		if (!this.model) return;
		this.model = { ...this.model, draft: d };
		clear(this.draftGroup);
		this.lineMats = this.lineMats.filter((m) => !m.userData.draft);
		this.drawDraft(d);
	}

	private drawDraft(d: Draft | null) {
		if (d) {
			if (d.h !== undefined && Math.abs(d.h) > 1e-3) this.addVolume(d.plane, d.pts, d.h, d.wall ?? null, d.mat ?? 'plaster', true, '', this.draftGroup);
			else if (d.pts.length > 1) {
				const l = this.line(d.plane, d.pts, !!d.closed, this.colors.accent, 2.6, {});
				(l.material as LineMaterial).userData.draft = true;
				this.draftGroup.add(l);
			}
		}
		this.dirty();
	}

	private drawPlane(p: Plane) {
		const M = planeMatrix(p);
		const g = new THREE.Group();
		g.applyMatrix4(M);
		const size = 60;
		const grid = new THREE.GridHelper(size, size, this.colors.line, this.colors.line);
		grid.rotation.x = Math.PI / 2; // GridHelper lies in XZ; the plane's local XY is u, v.
		(grid.material as THREE.Material).transparent = true;
		(grid.material as THREE.Material).opacity = 0.55;
		(grid.material as THREE.Material).depthWrite = false;
		g.add(grid);
		const fill = new THREE.Mesh(
			new THREE.PlaneGeometry(size, size),
			new THREE.MeshBasicMaterial({ color: this.colors.accent, transparent: true, opacity: 0.035, side: THREE.DoubleSide, depthWrite: false })
		);
		g.add(fill);
		// Axes through the origin: u (accent), v (ink).
		const ax = (dir: [number, number], c: THREE.Color) => {
			const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-dir[0] * 30, -dir[1] * 30, 0.001), new THREE.Vector3(dir[0] * 30, dir[1] * 30, 0.001)]);
			return new THREE.Line(geo, new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.6 }));
		};
		g.add(ax([1, 0], this.colors.accent), ax([0, 1], this.colors.faint));
		this.planeGroup.add(g);
	}

	private addVolume(p: Plane, base: V2[], h: number, wall: number | null, mat: Material, sel: boolean, id: string, into: THREE.Group) {
		const m = volumeMesh(base, h, wall);
		const geo = new THREE.BufferGeometry();
		geo.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3));
		geo.setIndex(m.index);
		geo.applyMatrix4(planeMatrix(p));
		geo.computeVertexNormals();
		const color = new THREE.Color(MAT_COLORS[mat]);
		const mesh = new THREE.Mesh(
			geo,
			new THREE.MeshStandardMaterial({
				color,
				roughness: 0.92,
				metalness: 0,
				transparent: mat === 'glass',
				opacity: mat === 'glass' ? 0.55 : 1,
				polygonOffset: true,
				polygonOffsetFactor: 1,
				polygonOffsetUnits: 1,
				emissive: sel ? this.colors.accent : new THREE.Color(0),
				emissiveIntensity: sel ? 0.12 : 0
			})
		);
		mesh.userData = { kind: 'volume', id };
		into.add(mesh);
		const eg = new THREE.BufferGeometry();
		eg.setAttribute('position', new THREE.Float32BufferAttribute(m.edges, 3));
		eg.applyMatrix4(planeMatrix(p));
		into.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: sel ? this.colors.accent : this.colors.ink, transparent: true, opacity: sel ? 1 : 0.75 })));
	}

	private line(p: Plane, pts: V2[], closed: boolean, color: THREE.Color, width: number, data: Record<string, string>) {
		const w = pts.map((q) => toWorld(p, q));
		if (closed) w.push(w[0]);
		const n = normal(p);
		const lift = (q: V3) => [q[0] + n[0] * 0.004, q[1] + n[1] * 0.004, q[2] + n[2] * 0.004];
		const geo = new LineGeometry();
		geo.setPositions(w.flatMap(lift));
		const mat = new LineMaterial({ color: color.getHex(), linewidth: width, worldUnits: false });
		mat.resolution.set(this.canvas.clientWidth, this.canvas.clientHeight);
		this.lineMats.push(mat);
		const l = new Line2(geo, mat);
		l.computeLineDistances();
		l.userData = data;
		return l;
	}

	dispose() {
		cancelAnimationFrame(this.raf);
		this.ro.disconnect();
		this.controls.dispose();
		clear(this.content);
		clear(this.planeGroup);
		clear(this.draftGroup);
		this.renderer.dispose();
	}
}

function clear(g: THREE.Object3D) {
	for (const c of [...g.children]) {
		g.remove(c);
		c.traverse((o) => {
			const m = o as THREE.Mesh;
			m.geometry?.dispose();
			const mat = m.material as THREE.Material | THREE.Material[] | undefined;
			if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
			else mat?.dispose();
		});
	}
}

function segDist(x: number, y: number, a: { x: number; y: number }, b: { x: number; y: number }) {
	const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
	const t = l2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
	return { d: Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t)), t };
}

function inside(x: number, y: number, P: { x: number; y: number }[]) {
	let c = false;
	for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
		const a = P[i], b = P[j];
		if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
	}
	return c;
}
