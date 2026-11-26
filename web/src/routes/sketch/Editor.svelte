<script lang="ts">
	import { getLocale, LOCALE_TAGS, t } from '#lib/i18n.js';
	import { LIMIT, MATERIALS, newDoc, parseSketch, type Element, type Material, type Plane, type SketchDoc, type VolumeEl } from '#lib/sketch3d/doc.js';
	import { commit, current, redo as redoOp, undo as undoOp } from '#lib/sketch3d/edit.js';
	import { heightAlong, isSimple, normal, offsetPolygon, planeHit, rdp, toWorld, type V2, type V3 } from '#lib/sketch3d/geom.js';
	import { PenGate } from '#lib/sketch3d/input.js';
	import { replay, type Change, type Op } from '#lib/sketch3d/ops.js';
	import { recognize } from '#lib/sketch3d/recognize.js';
	import { loadDoc, saveDoc, UnreadableDoc } from '#lib/sketch3d/storage.js';
	import { Viewport, type Draft } from '#lib/sketch3d/viewport.js';
	import { onMount } from 'svelte';

	type Tool = 'pen' | 'push' | 'select' | 'erase';
	const DOC_ID = 'default';
	const WALL = 0.25;
	/** Pen samples kept per stroke; the rest of a very long stroke is dropped. */
	const MAX_SAMPLES = 2000;
	/** Points a volume base may have (doc.ts limit). */
	const MAX_BASE = 1000;
	const MAT_SWATCH: Record<Material, string> = { plaster: '#f1ede4', concrete: '#b9b5ad', wood: '#c49668', stone: '#c7b694', glass: '#a8c6d1', marble: '#ece9e4' };

	let doc = $state.raw<SketchDoc>(newDoc(DOC_ID, t('sketch.title')));
	let loaded = $state(false);
	let redoStack = $state.raw<Op<Element>[]>([]);
	let tool = $state<Tool>('pen');
	let planeId = $state('ground');
	let selected = $state<string | null>(null);
	/** A shape the pen just closed: offer to make it a volume. */
	let suggest = $state<string | null>(null);
	let save = $state<'idle' | 'saving' | 'saved' | 'error'>('idle');
	let toast = $state<{ text: string; undo?: boolean } | null>(null);
	/** Live readout near the pen while pulling. */
	let readout = $state<{ x: number; y: number; text: string } | null>(null);
	/** Bumps when the camera moves, so screen-anchored chips follow. */
	let camTick = $state(0);
	let finePointer = $state(false);
	let heightText = $state('');

	let vp = $state.raw<Viewport | null>(null);
	const gate = new PenGate();

	let els = $derived(replay(current(doc).ops));
	let active = $derived(doc.planes.find((p) => p.id === planeId) ?? doc.planes[0]);
	let planes = $derived(new Map(doc.planes.map((p) => [p.id, p])));
	let sel = $derived(selected ? (els.get(selected) ?? null) : null);
	let canUndo = $derived(current(doc).ops.length > 0);

	const nf = $derived(new Intl.NumberFormat(LOCALE_TAGS[getLocale()], { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
	const m = (v: number) => nf.format(v);
	const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

	// ---- document edits ----
	/** Set by the first edit: only an edited document is written back (a failed load must not
	 * overwrite what is stored). */
	let edited = false;
	function setDoc(d: SketchDoc) {
		edited = true;
		doc = d;
	}
	/** False when the edit was not kept. */
	function apply(label: string, ch: Change<Element>[]): boolean {
		if (!ch.length || !loaded) return false;
		const next = commit(doc, label, ch, uid(), Date.now());
		// Never keep an edit the next load would reject (document budget, outline rules).
		try {
			parseSketch(next);
		} catch {
			showToast(t('sketch.tooLarge'));
			return false;
		}
		setDoc(next);
		redoStack = [];
		return true;
	}
	function undo() {
		if (!loaded) return;
		const u = undoOp(doc);
		if (!u) return showToast(t('sketch.nothingToUndo'));
		setDoc(u.doc);
		redoStack = [...redoStack, u.op];
		if (selected && !replay(current(doc).ops).has(selected)) selected = null;
		suggest = null;
		showToast(t('sketch.undone', { label: u.op.label }));
	}
	function redo() {
		const op = redoStack.at(-1);
		if (!op || !loaded) return;
		setDoc(redoOp(doc, op));
		redoStack = redoStack.slice(0, -1);
	}

	let toastTimer: ReturnType<typeof setTimeout> | undefined;
	function showToast(text: string, withUndo = false) {
		toast = { text, undo: withUndo };
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = null), withUndo ? 5000 : 2600);
	}

	// ---- persistence ----
	/** False when the store could not be read: then nothing is written, so it cannot be overwritten. */
	let canStore = true;
	onMount(() => {
		finePointer = matchMedia('(pointer: fine)').matches;
		loadDoc(DOC_ID)
			.then((d) => {
				if (d) doc = d;
			})
			.catch((e) => {
				// An unreadable document was copied aside first; any other error means the store
				// itself failed.
				if (!(e instanceof UnreadableDoc)) (canStore = false), (save = 'error');
				showToast(t(e instanceof UnreadableDoc ? 'sketch.loadFailed' : 'sketch.storageFailed'));
			})
			.finally(() => (loaded = true));
	});
	// Every edit is written at once (edits are discrete ops, not pen samples), so a reload or a
	// closed tab right after an edit keeps it. Writes run in order; the last one wins.
	let writing = 0;
	$effect(() => {
		const d = doc;
		if (!loaded || !edited || !canStore) return;
		writing++;
		save = 'saving';
		saveDoc(d).then(
			() => --writing || (save = 'saved'),
			() => (writing--, (save = 'error'))
		);
	});

	// ---- viewport ----
	function mountViewport(canvas: HTMLCanvasElement) {
		const v = new Viewport(canvas);
		v.onView = () => camTick++;
		vp = v;
		const mq = matchMedia('(prefers-color-scheme: dark)');
		const onTheme = () => v.readTheme();
		mq.addEventListener('change', onTheme);
		// Browser tests only (dev server): read positions and state without touching the UI.
		if (import.meta.env.DEV)
			Object.assign(window, {
				__sketch: {
					project: (w: V3) => v.project(w),
					els: () => [...els.entries()],
					cam: () => v.camera.position.toArray(),
					toWorld: (pid: string, q: V2) => toWorld(planes.get(pid)!, q)
				}
			});
		return () => {
			mq.removeEventListener('change', onTheme);
			if (import.meta.env.DEV) delete (window as { __sketch?: unknown }).__sketch;
			v.dispose();
			vp = null;
		};
	}
	/** Elements a live draft stands in for (pull preview, erased this stroke). */
	let hidden = $state.raw<ReadonlySet<string>>(new Set());
	/** The live draft; plain (not reactive): the viewport redraws it directly on every move. */
	let draft: Draft | null = null;
	const showDraft = (d: Draft | null) => {
		draft = d;
		vp?.setDraft(d);
	};
	$effect(() => {
		vp?.set({ els, planes: doc.planes, active, selected, hidden, draft });
	});

	function setPlane(id: string) {
		planeId = id;
		const p = doc.planes.find((q) => q.id === id);
		if (p) vp?.face(p);
	}

	// ---- pointer sessions ----
	type Session =
		| { kind: 'draw'; plane: Plane; pts: V2[]; clamped: boolean; pid: number }
		| { kind: 'pull'; id: string; el: Element; plane: Plane; c: V3; n: V3; s0: number; h0: number; h: number; pid: number }
		| { kind: 'erase'; ids: Set<string>; pid: number };
	let session: Session | null = null;
	/** True while the pen pulls a height: the context bar steps aside. */
	let pulling = $state(false);

	const isUi = (e: PointerEvent) => (e.target as HTMLElement).closest('[data-ui]') !== null;
	/** The S Pen side button or an eraser end turns the pen into the eraser for that stroke. */
	const penErases = (e: PointerEvent) => e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0 || (e.buttons & 2) !== 0);
	const hitLocal = (e: PointerEvent, p: Plane) => planeHit(vp!.ray(e.clientX, e.clientY), p, vp!.center(), LIMIT);

	// Palm rejection: a finger that touches while the pen is near is a palm, and so is a finger
	// already down when the pen comes near. A palm's moves never reach the camera or the UI until
	// it lifts; its lift goes through, so the camera controls forget it.
	const fingers = new Set<number>();
	const palms = new Set<number>();
	function penEvent(e: PointerEvent, down: boolean) {
		if (e.pointerType !== 'pen') return;
		if (down) gate.pen(performance.now(), true);
		else if (e.buttons === 0 && e.type === 'pointermove') gate.hover(performance.now(), true);
		else gate.pen(performance.now(), false);
		if (!gate.allowTouch(performance.now())) for (const id of fingers) palms.add(id);
	}
	function onLeave(e: PointerEvent) {
		if (e.pointerType === 'pen') gate.hover(performance.now(), false);
	}
	function fingerUp(e: PointerEvent) {
		if (e.pointerType !== 'touch') return;
		fingers.delete(e.pointerId);
		palms.delete(e.pointerId);
	}
	function stopPalm(e: Event) {
		e.stopPropagation();
		e.preventDefault();
	}
	/** A tap from a resting palm must not press a button. */
	function onClickCapture(e: MouseEvent) {
		if ((e as PointerEvent).pointerType === 'touch' && !gate.allowTouch(performance.now())) stopPalm(e);
	}

	function onDown(e: PointerEvent) {
		if (e.pointerType === 'touch') {
			fingers.add(e.pointerId);
			if (!gate.allowTouch(performance.now())) {
				palms.add(e.pointerId);
				stopPalm(e);
			}
			return; // fingers: OrbitControls and the UI
		}
		if (!vp || isUi(e)) return;
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		penEvent(e, true);
		e.stopPropagation();
		e.preventDefault();
		// One drawing pointer at a time; nothing is edited before the stored sketch is read.
		if (session || !loaded) return;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		suggest = null;
		const mode: Tool = penErases(e) ? 'erase' : tool;
		if (mode === 'pen') {
			const h = hitLocal(e, active);
			session = { kind: 'draw', plane: active, pts: [h.p], clamped: h.clamped, pid: e.pointerId };
			selected = null;
		} else if (mode === 'erase') {
			session = { kind: 'erase', ids: new Set(), pid: e.pointerId };
			eraseAt(e);
		} else {
			const hit = vp.pick(e.clientX, e.clientY);
			if (mode === 'select') {
				selected = hit?.id ?? null;
				heightText = '';
				return;
			}
			if (!hit || (hit.el.type === 'stroke' && !hit.el.closed)) return showToast(t('sketch.hint.push'));
			startPull(hit.id, e);
		}
	}

	function startPull(id: string, e: PointerEvent) {
		const el = els.get(id);
		if (!el || !vp) return;
		const plane = planes.get(el.plane)!;
		const base = el.type === 'volume' ? el.base : el.pts;
		const cx = base.reduce((s, p) => s + p[0], 0) / base.length, cy = base.reduce((s, p) => s + p[1], 0) / base.length;
		const c = toWorld(plane, [cx, cy]), n = normal(plane);
		const h0 = el.type === 'volume' ? el.h : 0;
		session = { kind: 'pull', id, el, plane, c, n, s0: heightAlong(vp.ray(e.clientX, e.clientY), c, n), h0, h: h0, pid: e.pointerId };
		selected = id;
		hidden = new Set([id]);
		pulling = true;
		pullPreview(session, e);
	}

	function pullPreview(s: Extract<Session, { kind: 'pull' }>, e: PointerEvent) {
		const base = s.el.type === 'volume' ? s.el.base : s.el.pts;
		const d: Draft = { plane: s.plane, pts: base, h: s.h, wall: s.el.type === 'volume' ? s.el.wall : null, mat: s.el.type === 'volume' ? s.el.mat : 'plaster', closed: true };
		showDraft(d);
		readout = { x: e.clientX, y: e.clientY, text: `${m(s.h)} ${t('sketch.unit')}` };
	}

	/** Feed one pointer position into the session (move, and the final position on lift). */
	function track(s: Session, e: PointerEvent) {
		if (!vp) return;
		if (s.kind === 'draw') {
			const move = e.type === 'pointermove';
			const evs = move && typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
			for (const ev of evs.length ? evs : [e]) {
				// The last slot is kept for the lift, so a long stroke still ends where the pen lifted.
				if (s.pts.length >= (move ? MAX_SAMPLES - 1 : MAX_SAMPLES)) break;
				const h = hitLocal(ev, s.plane);
				const last = s.pts[s.pts.length - 1];
				if (Math.hypot(h.p[0] - last[0], h.p[1] - last[1]) < 0.01) continue;
				s.pts.push(h.p);
				if (h.clamped) s.clamped = true;
			}
			showDraft({ plane: s.plane, pts: s.pts });
		} else if (s.kind === 'pull') {
			const raw = s.h0 + heightAlong(vp.ray(e.clientX, e.clientY), s.c, s.n) - s.s0;
			s.h = Math.round(raw * 20) / 20;
			pullPreview(s, e);
		} else eraseAt(e);
	}

	function onMove(e: PointerEvent) {
		if (palms.has(e.pointerId)) return stopPalm(e);
		// Contact = tip (1) or eraser end (32). The side button alone (2) while hovering is a hover.
		penEvent(e, (e.buttons & 33) !== 0);
		const s = session;
		if (!s || e.pointerId !== s.pid) return;
		e.stopPropagation();
		track(s, e);
	}

	function onUp(e: PointerEvent) {
		fingerUp(e);
		penEvent(e, false);
		const s = session;
		if (!s || e.pointerId !== s.pid) return;
		e.stopPropagation();
		// The eraser acts on moves only: on lift, the element under a still pen is the one behind
		// what it just erased.
		if (s.kind !== 'erase') track(s, e);
		session = null;
		readout = null;
		pulling = false;
		showDraft(null);
		hidden = new Set();
		if (s.kind === 'draw') finishDraw(s);
		else if (s.kind === 'pull') finishPull(s);
		else if (s.ids.size) {
			apply(t('sketch.op.erase'), [...s.ids].map((id) => ({ id, el: null })));
			if (selected && s.ids.has(selected)) selected = null;
		}
	}

	function onCancel(e: PointerEvent) {
		fingerUp(e);
		penEvent(e, false);
		if (!session || e.pointerId !== session.pid) return;
		session = null;
		readout = null;
		pulling = false;
		hidden = new Set();
		showDraft(null);
	}

	function eraseAt(e: PointerEvent) {
		const s = session;
		if (!s || s.kind !== 'erase' || !vp) return;
		const hit = vp.pick(e.clientX, e.clientY, 10);
		if (hit && !s.ids.has(hit.id)) {
			s.ids.add(hit.id);
			hidden = new Set(s.ids); // instant feedback; one op removes them all on lift
		}
	}

	function finishDraw(s: Extract<Session, { kind: 'draw' }>) {
		const r = recognize(s.pts);
		if (!r) return;
		// A snapped line end or a fitted circle can reach past the document bound.
		let clamped = s.clamped;
		const pts = r.pts.map(([u, v]): V2 => {
			const q: V2 = [Math.max(-LIMIT, Math.min(LIMIT, u)), Math.max(-LIMIT, Math.min(LIMIT, v))];
			if (q[0] !== u || q[1] !== v) clamped = true;
			return q;
		});
		r.pts = pts;
		const id = uid();
		const el: Element = { type: 'stroke', plane: s.plane.id, pts, closed: r.closed, shape: r.shape };
		const xs = r.pts.map((p) => p[0]), ys = r.pts.map((p) => p[1]);
		const label =
			r.shape === 'line'
				? t('sketch.shape.line', { len: m(Math.hypot(r.pts[1][0] - r.pts[0][0], r.pts[1][1] - r.pts[0][1])) })
				: r.shape === 'rect'
					? t('sketch.shape.rect', { w: m(Math.max(...xs) - Math.min(...xs)), h: m(Math.max(...ys) - Math.min(...ys)) })
					: r.shape === 'circle'
						? t('sketch.shape.circle', { r: m((Math.max(...xs) - Math.min(...xs)) / 2) })
						: r.shape === 'ellipse'
							? t('sketch.shape.ellipse')
							: r.closed
								? t('sketch.shape.closed')
								: t('sketch.shape.free');
		if (!apply(label, [{ id, el }])) return;
		if (r.closed) suggest = id;
		showToast(clamped ? t('sketch.clamped') : label);
	}

	function finishPull(s: Extract<Session, { kind: 'pull' }>) {
		if (Math.abs(s.h - s.h0) < 1e-6 || Math.abs(s.h) < 0.05) return;
		setHeight(s.id, s.h);
	}

	function volumeCount() {
		let n = 0;
		for (const e of els.values()) if (e.type === 'volume') n++;
		return n;
	}

	/** A closed stroke as a volume base: at most MAX_BASE points, and it may not cross itself. */
	function baseOf(pts: V2[]): V2[] | null {
		let base = pts;
		for (let eps = 0.002; base.length > MAX_BASE; eps *= 2) base = rdp([...pts, pts[0]], eps).slice(0, -1);
		return base.length >= 3 && isSimple(base) ? base : null;
	}

	function setHeight(id: string, h: number) {
		const el = els.get(id);
		if (!el || Math.abs(h) < 0.05 || Math.abs(h) > 2 * LIMIT) return;
		let next: VolumeEl;
		if (el.type === 'volume') next = { ...el, h };
		else {
			const base = el.closed ? baseOf(el.pts) : null;
			if (!base) return showToast(t('sketch.selfCrossing'));
			next = { type: 'volume', plane: el.plane, base, h, wall: null, mat: 'plaster', name: t('sketch.volumeName', { n: volumeCount() + 1 }) };
		}
		if (!apply(el.type === 'volume' ? t('sketch.op.height', { h: m(h) }) : t('sketch.op.extrude', { h: m(h) }), [{ id, el: next }])) return;
		selected = id;
		suggest = null;
	}

	function update(id: string, patch: Partial<VolumeEl>, label: string) {
		const el = els.get(id);
		if (el?.type !== 'volume') return;
		apply(label, [{ id, el: { ...el, ...patch } }]);
	}

	function toggleWall() {
		if (!selected || sel?.type !== 'volume') return;
		const on = sel.wall === null;
		if (on && !offsetPolygon(sel.base, WALL)) return showToast(t('sketch.wallNoFit', { t: m(WALL) }));
		update(selected, { wall: on ? WALL : null }, on ? t('sketch.op.wallOn', { t: m(WALL) }) : t('sketch.op.wallOff'));
	}

	function setMat(k: Material) {
		if (!selected || sel?.type !== 'volume' || sel.mat === k) return;
		update(selected, { mat: k }, t('sketch.op.material', { m: t(`sketch.mat.${k}`) }));
	}

	function remove(id: string) {
		apply(t('sketch.op.delete'), [{ id, el: null }]);
		selected = null;
	}

	function commitHeightText() {
		const v = Number(heightText.replace(',', '.'));
		if (selected && Number.isFinite(v) && v !== 0) setHeight(selected, v);
		heightText = '';
	}

	// ---- screen anchors ----
	function anchor(id: string | null): { x: number; y: number } | null {
		void camTick;
		if (!id || !vp) return null;
		const el = els.get(id);
		if (!el) return null;
		const p = planes.get(el.plane)!;
		const base = el.type === 'volume' ? el.base : el.pts;
		const c: V2 = [base.reduce((s, q) => s + q[0], 0) / base.length, base.reduce((s, q) => s + q[1], 0) / base.length];
		return vp.project(toWorld(p, c));
	}
	let suggestAt = $derived(anchor(suggest));

	function onKey(e: KeyboardEvent) {
		const tgt = e.target as HTMLElement;
		if (tgt.closest('input, textarea, [contenteditable]')) return;
		// The Latin letter on the key; with a non-Latin layout (Greek) the physical key's letter.
		const k = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key;
		const mod = e.metaKey || e.ctrlKey;
		if (mod && k === 'z') {
			e.preventDefault();
			if (e.shiftKey) redo();
			else undo();
		} else if (mod && k === 'y') {
			e.preventDefault();
			redo();
		} else if (mod || e.altKey) return;
		else if (k === 'p') tool = 'pen';
		else if (k === 'u') tool = 'push';
		else if (k === 'v') tool = 'select';
		else if (k === 'e') tool = 'erase';
		else if (k === '1') setPlane('ground');
		else if (k === '2') setPlane('front');
		else if (k === '3') setPlane('side');
		else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) remove(selected);
		else if (e.key === 'Escape') (selected = null), (suggest = null);
	}

	function exportJson() {
		const blob = new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `sketch-${new Date().toISOString().slice(0, 10)}.json`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 1000);
	}

	const TOOLS: { id: Tool; key: string }[] = [
		{ id: 'pen', key: 'P' },
		{ id: 'push', key: 'U' },
		{ id: 'select', key: 'V' },
		{ id: 'erase', key: 'E' }
	];
</script>

<svelte:window onkeydown={onKey} />

<div
	class="sketch"
	role="application"
	aria-label={t('sketch.title')}
	onpointerdowncapture={onDown}
	onpointermovecapture={onMove}
	onpointerupcapture={onUp}
	onpointercancelcapture={onCancel}
	onlostpointercapture={onCancel}
	onpointerleave={onLeave}
	onclickcapture={onClickCapture}
	oncontextmenu={(e) => e.preventDefault()}
>
	<canvas {@attach mountViewport} data-tool={tool}></canvas>

	<header class="top" data-ui>
		<a class="back" href="/">{t('sketch.back')}</a>
		<span class="sep">›</span>
		<span class="title">{t('sketch.title')}</span>
		<span class="save" data-state={save} title={save === 'error' ? t('sketch.saveFailed') : save === 'saved' ? t('sketch.saved') : t('sketch.saving')}></span>
		<button class="btn ghost icon" onclick={exportJson} title={t('sketch.export')} aria-label={t('sketch.export')}>
			<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v9m0 0-3.5-3.5M10 12l3.5-3.5M4 14v2.5h12V14" /></svg>
		</button>
	</header>

	<div class="seg planes" role="radiogroup" aria-label={t('sketch.planes')} data-ui>
		{#each doc.planes as p (p.id)}
			<button role="radio" aria-checked={p.id === planeId} class={{ on: p.id === planeId }} onclick={() => setPlane(p.id)}>
				{t(`sketch.plane.${p.id as 'ground' | 'front' | 'side'}`)}
			</button>
		{/each}
	</div>

	{#if loaded && els.size === 0}
		<p class="hint">{finePointer ? t('sketch.hint.mouse') : t('sketch.hint.empty')}</p>
	{/if}

	{#if suggest && suggestAt}
		<div class="suggest" style:left="{suggestAt.x}px" style:top="{suggestAt.y}px" data-ui>
			<button
				class="pull"
				title={t('sketch.hint.pull')}
				onpointerdown={(e) => {
					e.stopPropagation();
					e.preventDefault();
					penEvent(e, true);
					if (session) return;
					(e.currentTarget.closest('.sketch') as HTMLElement).setPointerCapture(e.pointerId);
					startPull(suggest!, e);
					suggest = null;
				}}
			>
				<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16V4m0 0-4 4m4-4 4 4" /></svg>
				{t('sketch.suggest.extrude')}
			</button>
			<button class="quick" onclick={() => suggest && setHeight(suggest, 3)}>{t('sketch.suggest.h3')}</button>
		</div>
	{/if}

	{#if readout}
		<div class="readout" style:left="{readout.x}px" style:top="{readout.y}px">{readout.text}</div>
	{/if}

	<div class="dock" data-ui>
		{#if sel && selected && !pulling}
			<div class="context">
				{#if sel.type === 'volume'}
					<label class="height">
						<span class="sr">{t('sketch.ctx.height')}</span>
						<input
							inputmode="decimal"
							placeholder={m(sel.h)}
							bind:value={heightText}
							onkeydown={(e) => e.key === 'Enter' && commitHeightText()}
							onblur={commitHeightText}
						/>
						<span class="unit">{t('sketch.unit')}</span>
					</label>
					<button
						class={['chip', { on: sel.wall !== null }]}
						aria-pressed={sel.wall !== null}
						onclick={toggleWall}
					>
						{t('sketch.ctx.wall', { t: m(WALL) })}
					</button>
					<div class="mats" role="radiogroup" aria-label={t('sketch.ctx.material')}>
						{#each MATERIALS as k (k)}
							<button
								role="radio"
								aria-checked={sel.mat === k}
								class={{ on: sel.mat === k }}
								style:--sw={MAT_SWATCH[k]}
								title={t(`sketch.mat.${k}`)}
								aria-label={t(`sketch.mat.${k}`)}
								onclick={() => setMat(k)}
							></button>
						{/each}
					</div>
				{:else if sel.closed}
					<button class="chip" onclick={() => selected && setHeight(selected, 3)}>{t('sketch.ctx.makeVolume')}</button>
				{/if}
				<button class="btn ghost danger" onclick={() => selected && remove(selected)}>{t('common.delete')}</button>
			</div>
		{/if}
		{#if toast}
			<div class="toast" role="status">
				{toast.text}
			</div>
		{/if}
		<div class="tools" role="toolbar" aria-label={t('sketch.tools')}>
			<button class="icon" onclick={undo} disabled={!canUndo} title="{t('sketch.undo')} (⌘Z)" aria-label={t('sketch.undo')}>
				<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5 3.5 8.5 7 12M4 8.5h8a4 4 0 0 1 0 8H9" /></svg>
			</button>
			<button class="icon" onclick={redo} disabled={!redoStack.length} title="{t('sketch.redo')} (⇧⌘Z)" aria-label={t('sketch.redo')}>
				<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M13 5l3.5 3.5L13 12m3-3.5H8a4 4 0 0 0 0 8h3" /></svg>
			</button>
			<span class="div"></span>
			{#each TOOLS as tl (tl.id)}
				<button class={['tool', { on: tool === tl.id }]} aria-pressed={tool === tl.id} onclick={() => (tool = tl.id)} title="{t(`sketch.tool.${tl.id}`)} ({tl.key})">
					<svg viewBox="0 0 20 20" aria-hidden="true">
						{#if tl.id === 'pen'}<path d="M4 16l1-4 8-8 3 3-8 8-4 1zM11.5 5.5l3 3" />
						{:else if tl.id === 'push'}<path d="M4 13l6 3 6-3M4 13l6-3 6 3M10 10V3m0 0L7.5 5.5M10 3l2.5 2.5" />
						{:else if tl.id === 'select'}<path d="M5 3l10 6-4.5 1.2L8.5 15z" />
						{:else}<path d="M8 16h8M4.5 12.5l6-6 4 4-4.5 4.5H7z" />{/if}
					</svg>
					<span>{t(`sketch.tool.${tl.id}`)}</span>
				</button>
			{/each}
		</div>
	</div>
</div>

<style>
	.sketch {
		position: fixed;
		inset: 0;
		overflow: hidden;
		background: var(--canvas);
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
	}
	canvas {
		display: block;
		width: 100%;
		height: 100%;
		touch-action: none;
	}
	canvas[data-tool='pen'] { cursor: crosshair; }
	canvas[data-tool='push'] { cursor: ns-resize; }
	canvas[data-tool='erase'] { cursor: cell; }

	.top {
		position: absolute;
		top: 12px;
		left: 12px;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 6px 4px 14px;
		background: var(--raised);
		border-radius: var(--r-pill);
		box-shadow: 0 12px 32px -12px rgb(0 0 0 / 0.3), 0 0 0 1px var(--line);
		font-size: 14px;
	}
	.back { color: var(--muted); text-decoration: none; }
	.back:hover { color: var(--text); }
	.sep { color: var(--faint); }
	.title { font-family: var(--font-serif); font-size: 16px; }
	.save { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); }
	.save[data-state='saved'] { background: var(--ok); }
	.save[data-state='error'] { background: var(--accent); }
	.icon svg, .tool svg, .pull svg {
		width: 20px;
		height: 20px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.btn.icon { width: 36px; height: 36px; padding: 0; display: grid; place-items: center; border-radius: 50%; }

	.planes {
		position: absolute;
		top: 12px;
		left: 50%;
		transform: translateX(-50%);
		box-shadow: 0 12px 32px -12px rgb(0 0 0 / 0.3), 0 0 0 1px var(--line);
	}
	.planes button { min-height: 36px; padding-inline: 14px; }

	.hint {
		position: absolute;
		top: 72px;
		left: 50%;
		transform: translateX(-50%);
		max-width: min(520px, calc(100% - 32px));
		margin: 0;
		color: var(--muted);
		font-size: 14px;
		text-align: center;
		pointer-events: none;
	}

	.suggest {
		position: absolute;
		transform: translate(-50%, -50%);
		display: flex;
		gap: 6px;
		animation: pop 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.suggest button {
		display: flex;
		align-items: center;
		gap: 6px;
		min-height: 40px;
		padding: 0 14px;
		border: 0;
		border-radius: var(--r-pill);
		font: inherit;
		font-size: 14px;
		font-weight: 600;
		box-shadow: 0 12px 32px -12px rgb(0 0 0 / 0.3), 0 0 0 1px var(--line);
		cursor: pointer;
		touch-action: none;
		white-space: nowrap;
	}
	.pull { background: var(--accent); color: var(--on-accent); cursor: ns-resize; }
	.quick { background: var(--raised); color: var(--text); }
	@keyframes pop {
		from { opacity: 0; transform: translate(-50%, -40%); }
	}

	.readout {
		position: absolute;
		transform: translate(18px, -130%);
		padding: 3px 8px;
		border-radius: var(--r-ctl);
		background: var(--text);
		color: var(--bg);
		font-size: 13px;
		font-variant-numeric: tabular-nums;
		pointer-events: none;
	}

	.dock {
		position: absolute;
		left: 50%;
		bottom: max(16px, env(safe-area-inset-bottom));
		transform: translateX(-50%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		max-width: calc(100% - 32px);
	}
	.tools, .context, .toast {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 6px;
		background: var(--raised);
		border-radius: var(--r-pill);
		box-shadow: 0 12px 32px -12px rgb(0 0 0 / 0.3), 0 0 0 1px var(--line);
	}
	.toast { padding: 8px 16px; font-size: 13.5px; color: var(--muted); }
	.tools button {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 44px;
		height: 44px;
		padding: 0 12px;
		border: 0;
		border-radius: var(--r-pill);
		background: none;
		color: var(--text);
		font: inherit;
		font-size: 14px;
		cursor: pointer;
		justify-content: center;
	}
	.tools button:hover:not(:disabled) { background: var(--sunk); }
	.tools button:disabled { color: var(--faint); cursor: default; }
	.tools .tool.on { background: var(--text); color: var(--bg); }
	.tools .div { width: 1px; height: 24px; background: var(--line); margin: 0 4px; }
	@media (max-width: 640px) {
		.tools .tool span { display: none; }
	}

	.context { padding: 6px 8px; gap: 8px; }
	.context .chip { min-height: 36px; }
	.height {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 0 10px;
		height: 36px;
		border-radius: var(--r-pill);
		background: var(--sunk);
	}
	.height input {
		width: 4.5em;
		border: 0;
		background: none;
		font: inherit;
		font-size: 14px;
		font-variant-numeric: tabular-nums;
		color: var(--text);
		outline: none;
		text-align: right;
	}
	.height input::placeholder { color: var(--text); }
	.unit { color: var(--muted); font-size: 13px; }
	.mats { display: flex; gap: 4px; }
	.mats button {
		width: 36px;
		height: 36px;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: none;
		cursor: pointer;
		display: grid;
		place-items: center;
	}
	.mats button::before {
		content: '';
		width: 22px;
		height: 22px;
		border-radius: 50%;
		background: var(--sw);
		box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.15);
	}
	.mats button.on::before { box-shadow: 0 0 0 2px var(--raised), 0 0 0 4px var(--accent); }
	.danger { color: var(--accent); }
	.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

	@media (prefers-reduced-motion: reduce) {
		.suggest { animation: none; }
	}
</style>
