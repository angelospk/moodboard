<script lang="ts">
	// 3D house editor of one project: tool rail, viewport, inspector, versions, export.
	// The model is plain data ($state.raw, always replaced, never mutated). Every change goes through
	// commit(): it records undo history, redraws the viewport and schedules the draft autosave.
	import { untrack } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import { getLocale, t } from '#lib/i18n.js';
	import { HouseViewport, DRAW_TOOLS, type DraftInfo, type Tool } from '#lib/house/viewport.js';
	import { MATERIALS, material as findMaterial } from '#lib/house/materials.js';
	import {
		cutIds,
		parseModel,
		removeElement,
		segments,
		type Element,
		type HouseModel,
		type Opening,
		type Vec2,
		type Wall
	} from '#lib/house/model.js';
	import { listVersions, loadVersion, saveDraft, saveVersion, trackDraftSave, type VersionInfo } from '#lib/house/store.js';
	import { download, fileBase, toGlb } from '#lib/house/export.js';
	import { toSemantic } from '#lib/house/semantic.js';
	import type { Key } from '#lib/i18n.js';
	import HouseIcon, { type HouseIconName } from './HouseIcon.svelte';
	import type { PageData } from './$types';

	// One editor per project: +page.svelte keys it by project id, so a query-only navigation to
	// another project starts fresh and a queued save still goes to the project it was made in.
	let { data }: { data: PageData } = $props();
	const projectId = untrack(() => data.project.id);

	const lang = getLocale();
	const AUTOSAVE_MS = 800;
	const HISTORY = 100;

	// ------------------------------------------------------------------ Model + history

	const RECOVERY = untrack(() => `moodboard:house:${data.userId}:${projectId}`);

	/** The server's draft, or this browser's recovery copy when it is newer (edits that never reached the server). */
	function startModel(): { model: HouseModel; recovered: boolean } {
		// The copy is removed when the server acknowledged the last edit, so one that is still here holds
		// edits this browser never got confirmed. It records `base`, the server time of the last draft this
		// browser knew. If the server draft is still that one, the copy is newer: use it. If the server has a
		// later draft (another device saved since), the server wins and the copy is dropped.
		try {
			const r = JSON.parse(localStorage.getItem(RECOVERY) ?? 'null') as { model?: unknown; base?: string | null } | null;
			if (r) {
				const m = parseModel(r.model);
				if ((r.base ?? null) === (data.draftAt ?? null) && JSON.stringify(m) !== JSON.stringify(data.model)) return { model: m, recovered: true };
				localStorage.removeItem(RECOVERY);
			}
		} catch {
			/* no storage: start from the server */
		}
		return { model: data.model, recovered: false };
	}
	const start = untrack(startModel);
	let model: HouseModel = $state.raw(start.model);
	let selected: string | null = $state(null);
	let undoStack: HouseModel[] = $state.raw([]);
	let redoStack: HouseModel[] = $state.raw([]);
	let vp: HouseViewport | null = null;

	/** A change may not take the hole away from a window or door that had one, nor add one without. */
	function hidesOpening(prev: HouseModel, next: HouseModel): boolean {
		const before = cutIds(prev);
		const after = cutIds(next);
		const existed = new Set(prev.elements.map((e) => e.id));
		return next.elements.some((e) => (e.type === 'window' || e.type === 'door') && !after.has(e.id) && (before.has(e.id) || !existed.has(e.id)));
	}

	/**
	 * The one gate for every change (tools, inspector, versions): parseModel applies the load rules
	 * (bounds, simple outlines, openings fitted to their wall), and a change that leaves another
	 * window or door without its hole (an overlap) is refused. `force` (opening a version) skips that check.
	 */
	function commit(raw: HouseModel, select?: string | null, force = false): boolean {
		const next = parseModel(raw);
		if (!force && hidesOpening(model, next)) {
			say(t('house.noRoom'));
			return false;
		}
		undoStack = [...undoStack.slice(-HISTORY + 1), model];
		redoStack = [];
		apply(next);
		if (select !== undefined) selected = select;
		if (selected && !next.elements.some((e) => e.id === selected)) selected = null;
		vp?.setSelected(selected);
		return true;
	}

	function apply(next: HouseModel) {
		model = next;
		vp?.setModel(next);
		scheduleSave();
	}

	function undo() {
		const prev = undoStack.at(-1);
		if (!prev) return;
		undoStack = undoStack.slice(0, -1);
		redoStack = [...redoStack, model];
		apply(prev);
		if (selected && !prev.elements.some((e) => e.id === selected)) select(null);
	}

	function redo() {
		const next = redoStack.at(-1);
		if (!next) return;
		redoStack = redoStack.slice(0, -1);
		undoStack = [...undoStack, model];
		apply(next);
		if (selected && !next.elements.some((e) => e.id === selected)) select(null);
	}

	function select(id: string | null) {
		selected = id;
		vp?.setSelected(id);
	}

	// ------------------------------------------------------------------ Draft autosave

	type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';
	let saveState: SaveState = $state(untrack(() => (data.hasDraft ? 'saved' : 'idle')));
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let saving: Promise<void> = Promise.resolve();
	/** Edit counter: `rev` counts edits, `sentRev` the last one handed to a save, `savedRev` the last
	 *  one the server acknowledged. The status says «saved» only when savedRev catches up with rev. */
	let rev = 0;
	let sentRev = 0;
	let savedRev = 0;
	/** The draft row, once known: later saves skip the lookup (one request, which a closing tab can still send). */
	let draftId: string | null = untrack(() => data.draftId);
	/** Server time of the last draft this editor knows is stored (loaded or acknowledged). */
	let draftAt: string | null = untrack(() => data.draftAt);

	// Recovery copy in this browser until the server acknowledges the edit: a tab closed or reloaded
	// before the save lands still has it next time (used when newer than the server's draft).
	function keepRecovery(m: HouseModel | null) {
		try {
			if (m) localStorage.setItem(RECOVERY, JSON.stringify({ base: draftAt, model: m }));
			else localStorage.removeItem(RECOVERY);
		} catch {
			/* private mode or full storage: the server save still runs */
		}
	}

	function scheduleSave() {
		rev++;
		keepRecovery(model);
		saveState = 'pending';
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => void flush(), AUTOSAVE_MS);
	}

	/** Send the current model now. Saves run one after another, so the last one wins. */
	function flush(): Promise<void> {
		clearTimeout(saveTimer);
		if (sentRev === rev) return saving;
		const snapshot = model;
		const at = (sentRev = rev);
		saving = saving.then(async () => {
			saveState = 'saving';
			try {
				const row = await saveDraft(data.pb, data.userId, projectId, snapshot, draftId);
				draftId = row.id;
				draftAt = row.updated_at;
				savedRev = at;
				if (savedRev === rev) {
					saveState = 'saved';
					keepRecovery(null);
				} else {
					keepRecovery(model); // newer edits wait: move their copy onto the new server base
					saveState = sentRev === rev ? 'saving' : 'pending';
				}
			} catch {
				// Send it again on retry or the next edit.
				if (sentRev === at) sentRev = savedRev;
				saveState = 'error';
			}
		});
		trackDraftSave(projectId, saving);
		return saving;
	}

	// Leaving the editor inside the app (breadcrumb) sends the last edit at once.
	beforeNavigate(() => void flush());

	/** Closing or reloading the tab with edits the server has not acknowledged: send them and ask first. */
	function onbeforeunload(e: BeforeUnloadEvent) {
		if (savedRev === rev) return;
		void flush();
		e.preventDefault();
	}

	// ------------------------------------------------------------------ Tools

	let tool: Tool = $state(untrack(() => (data.model.elements.length ? 'select' : 'wall')));
	let draft: DraftInfo | null = $state(null);
	let paintMaterial = $state('plaster_white');

	const TOOLS: { id: Tool; icon: HouseIconName; label: Key; key: string }[] = [
		{ id: 'select', icon: 'select', label: 'house.tool.select', key: '1' },
		{ id: 'paint', icon: 'paint', label: 'house.tool.paint', key: '2' },
		{ id: 'wall', icon: 'wall', label: 'house.tool.wall', key: '3' },
		{ id: 'window', icon: 'window', label: 'house.tool.window', key: '4' },
		{ id: 'door', icon: 'door', label: 'house.tool.door', key: '5' },
		{ id: 'slab', icon: 'slab', label: 'house.tool.slab', key: '6' },
		{ id: 'pool', icon: 'pool', label: 'house.tool.pool', key: '7' },
		{ id: 'box', icon: 'box', label: 'house.tool.box', key: '8' }
	];

	const HINTS: Record<Tool, Key> = {
		select: 'house.hint.select',
		paint: 'house.hint.paint',
		wall: 'house.hint.wall',
		slab: 'house.hint.slab',
		window: 'house.hint.opening',
		door: 'house.hint.opening',
		pool: 'house.hint.rect',
		box: 'house.hint.rect'
	};

	function setTool(next: Tool) {
		tool = next;
		vp?.setTool(next);
		if (next === 'paint' && selected) {
			const el = model.elements.find((e) => e.id === selected);
			if (el) setPaint(el.material);
		}
	}

	function setPaint(id: string) {
		paintMaterial = id;
		if (vp) vp.paintMaterial = id;
	}

	let view: 'top' | 'perspective' = $state('perspective');
	function setView(v: 'top' | 'perspective') {
		view = v;
		vp?.view(v);
	}

	/** The viewport lives as long as its host element. */
	function viewport(host: HTMLElement) {
		// Untracked: the attachment must not re-run (and rebuild the renderer) when the model or tool changes.
		return untrack(() => mountViewport(host));
	}

	function mountViewport(host: HTMLElement) {
		const v = new HouseViewport(host, {
			commit: (next) => commit(next),
			select: (id) => select(id),
			draft: (info) => (draft = info)
		});
		vp = v;
		v.paintMaterial = paintMaterial;
		v.setModel(model);
		v.setTool(tool);
		v.view('perspective');
		if (start.recovered) {
			scheduleSave();
			say(t('house.recovered'));
		}
		// Dev-only hook for browser checks (web/scripts/house-e2e.mjs).
		const w = window as unknown as { __house?: unknown };
		if (import.meta.env.DEV) w.__house = { vp: v, model: () => model };
		return () => {
			v.dispose();
			if (vp === v) vp = null;
			delete w.__house;
		};
	}

	/** A floor under the walls: their combined bounding rectangle. */
	function slabUnderWalls() {
		const pts = model.elements.flatMap((e) => (e.type === 'wall' ? e.points : []));
		if (pts.length < 2) return;
		const xs = pts.map((p) => p[0]);
		const ys = pts.map((p) => p[1]);
		const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
		if (x1 - x0 < 0.1 || y1 - y0 < 0.1) return;
		const outline: Vec2[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
		const id = Math.random().toString(36).slice(2, 10);
		commit({ ...model, elements: [{ id, type: 'slab', name: '', material: 'concrete', outline, elevation: 0, thickness: 0.2 }, ...model.elements] }, id);
		setTool('select');
	}

	// ------------------------------------------------------------------ Inspector

	let sel = $derived(model.elements.find((e) => e.id === selected) ?? null);

	function update(patch: Partial<Element>) {
		if (!sel) return;
		const id = sel.id;
		// commit() clamps the numbers and fits openings to their (changed) wall.
		commit({ ...model, elements: model.elements.map((e) => (e.id === id ? ({ ...e, ...patch } as Element) : e)) });
	}

	function numField(key: string, value: number, min: number, max: number) {
		return { key, value, min, max };
	}

	let fields = $derived.by(() => {
		if (!sel) return [];
		switch (sel.type) {
			case 'wall':
				return [numField('height', sel.height, 0.1, 100), numField('thickness', sel.thickness, 0.02, 5), numField('base', sel.base, -100, 1000)];
			case 'window':
				return [numField('width', sel.width, 0.1, 50), numField('height', sel.height, 0.1, 50), numField('sill', sel.sill, 0, 50), numField('offset', sel.offset, 0, 10000)];
			case 'door':
				return [numField('width', sel.width, 0.1, 50), numField('height', sel.height, 0.1, 50), numField('offset', sel.offset, 0, 10000)];
			case 'slab':
				return [numField('elevation', sel.elevation, -100, 1000), numField('thickness', sel.thickness, 0.02, 5)];
			case 'pool':
				return [numField('width', sel.width, 0.25, 100), numField('length', sel.length, 0.25, 100), numField('depth', sel.depth, 0.1, 10), numField('rotation', sel.rotation, -360, 360)];
			case 'box':
				return [numField('width', sel.width, 0.05, 200), numField('length', sel.length, 0.05, 200), numField('height', sel.height, 0.05, 200), numField('base', sel.base, -100, 1000), numField('rotation', sel.rotation, -360, 360)];
		}
	});

	let wallLength = $derived(sel?.type === 'wall' ? segments(sel).reduce((s, x) => s + x.length, 0) : 0);

	function onNumber(key: string, e: Event & { currentTarget: HTMLInputElement }) {
		const v = e.currentTarget.valueAsNumber;
		if (!Number.isFinite(v)) return;
		update({ [key]: v } as Partial<Element>);
	}

	function remove() {
		if (!sel) return;
		commit(removeElement(model, sel.id), null);
	}

	// ------------------------------------------------------------------ Versions

	let versions: VersionInfo[] = $state.raw(untrack(() => data.versions));
	let versionsOpen = $state(false);
	let versionName = $state('');
	let versionBusy = $state(false);
	let confirmOpen: string | null = $state(null);
	let toast: string | null = $state(null);
	let toastTimer: ReturnType<typeof setTimeout> | undefined;

	function say(text: string) {
		toast = text;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = null), 3500);
	}

	async function keepVersion() {
		versionBusy = true;
		try {
			const v = await saveVersion(data.pb, data.userId, projectId, versionName, model);
			versionName = '';
			versions = [v, ...versions];
			say(t('house.versionSaved', { name: v.name }));
		} catch {
			say(t('house.versionFailed'));
		} finally {
			versionBusy = false;
		}
	}

	async function openVersion(v: VersionInfo) {
		confirmOpen = null;
		versionBusy = true;
		try {
			const m = await loadVersion(data.pb, v.id);
			commit(m, null, true);
			versionsOpen = false;
			say(t('house.versionOpened', { name: v.name }));
			setTimeout(() => vp?.view(view), 0);
		} catch {
			say(t('house.versionFailed'));
		} finally {
			versionBusy = false;
		}
	}

	async function refreshVersions() {
		const fetched = await listVersions(data.pb, projectId).catch(() => null);
		if (!fetched) return;
		// Keep a version saved while this request ran (it may be missing from the answer).
		const ids = new Set(fetched.map((v) => v.id));
		versions = [...versions.filter((v) => !ids.has(v.id)), ...fetched].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
	}

	const dateFmt = new Intl.DateTimeFormat(lang === 'el' ? 'el-GR' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
	const fmtDate = (s: string) => dateFmt.format(new Date(s.replace(' ', 'T')));

	// ------------------------------------------------------------------ Export

	let exportOpen = $state(false);

	async function exportGlb() {
		exportOpen = false;
		download(await toGlb(model), `${fileBase(data.project.name)}.glb`, 'model/gltf-binary');
	}

	function exportJson() {
		exportOpen = false;
		const doc = toSemantic(model, { name: data.project.name });
		download(JSON.stringify(doc, null, 2), `${fileBase(data.project.name)}.house.json`, 'application/json');
	}

	// ------------------------------------------------------------------ Keys

	const typing = (e: KeyboardEvent) => {
		const el = e.target as HTMLElement | null;
		return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
	};

	function onkeydown(e: KeyboardEvent) {
		if (typing(e)) return;
		const mod = e.metaKey || e.ctrlKey;
		if (mod && e.key.toLowerCase() === 'z') {
			e.preventDefault();
			if (e.shiftKey) redo();
			else undo();
			return;
		}
		if (mod) return;
		if (e.key === 'Escape') {
			if (vp?.drafting) vp.cancelDraft();
			else if (versionsOpen || exportOpen) versionsOpen = exportOpen = false;
			else select(null);
		} else if (e.key === 'Enter') vp?.finishDraft();
		else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) remove();
		else {
			const t = TOOLS.find((x) => x.key === e.key);
			if (t) setTool(t.id);
		}
	}

	const saveLabel: Record<SaveState, Key> = {
		idle: 'house.save.idle',
		pending: 'house.save.pending',
		saving: 'house.save.saving',
		saved: 'house.save.saved',
		error: 'house.save.error'
	};

	const TYPE_LABEL: Record<Element['type'], Key> = {
		wall: 'house.tool.wall',
		window: 'house.tool.window',
		door: 'house.tool.door',
		slab: 'house.tool.slab',
		pool: 'house.tool.pool',
		box: 'house.tool.box'
	};

	const FIELD_LABEL: Record<string, Key> = {
		height: 'house.field.height',
		thickness: 'house.field.thickness',
		base: 'house.field.base',
		width: 'house.field.width',
		length: 'house.field.length',
		sill: 'house.field.sill',
		offset: 'house.field.offset',
		elevation: 'house.field.elevation',
		depth: 'house.field.depth',
		rotation: 'house.field.rotation'
	};
</script>

<svelte:window {onkeydown} {onbeforeunload} />
<svelte:document onvisibilitychange={() => document.visibilityState === 'hidden' && void flush()} />

{#snippet swatches(current: string, pick: (id: string) => void)}
	<div class="swatches" role="group" aria-label={t('house.material')}>
		{#each MATERIALS as m (m.id)}
			<button
				type="button"
				aria-pressed={current === m.id}
				class={['sw', current === m.id && 'on']}
				title={m.name[lang]}
				onclick={() => pick(m.id)}
			>
				<span class="dot" style:background={m.color} style:opacity={Math.max(0.55, m.opacity)}></span>
				<span class="nm">{m.name[lang]}</span>
			</button>
		{/each}
	</div>
{/snippet}

<div class="house">
	<header class="bar">
		<nav class="crumb" aria-label={t('common.breadcrumb')}>
			<a class="home" href="/">Moodboard</a>
			<span class="sep" aria-hidden="true"><HouseIcon name="chevronRight" size={14} /></span>
			<a class="pname" href={`/map?project=${data.project.id}`}>{data.project.name}</a>
			<span class="sep" aria-hidden="true"><HouseIcon name="chevronRight" size={14} /></span>
			<span class="here">{t('house.title')}</span>
		</nav>
		<div class="right">
			<span class={['status', saveState]} aria-live="polite">
				{t(saveLabel[saveState])}
				{#if saveState === 'error'}<button type="button" class="btn ghost retry" onclick={() => void flush()}>{t('house.retry')}</button>{/if}
			</span>
			<div class="grp">
				<button type="button" class="ic" onclick={undo} disabled={!undoStack.length} title={t('house.undo')} aria-label={t('house.undo')}><HouseIcon name="undo" /></button>
				<button type="button" class="ic" onclick={redo} disabled={!redoStack.length} title={t('house.redo')} aria-label={t('house.redo')}><HouseIcon name="redo" /></button>
			</div>
			<div class="menu">
				<button type="button" class="btn" aria-label={t('house.versions')} aria-expanded={versionsOpen} onclick={() => { versionsOpen = !versionsOpen; exportOpen = false; if (versionsOpen) void refreshVersions(); }}>
					<HouseIcon name="history" size={16} /><span class="lbl">{t('house.versions')}</span>
				</button>
				{#if versionsOpen}
					<div class="scrim" role="presentation" onpointerdown={() => (versionsOpen = false)}></div>
					<div class="pop versions" role="dialog" aria-label={t('house.versions')}>
						<form class="keep" onsubmit={(e) => { e.preventDefault(); void keepVersion(); }}>
							<input type="text" maxlength="120" placeholder={t('house.versionName')} bind:value={versionName} aria-label={t('house.versionName')} />
							<button type="submit" class="btn primary" disabled={versionBusy}>{t('house.saveVersion')}</button>
						</form>
						<p class="note">{t('house.versionHint')}</p>
						{#if versions.length}
							<ul class="vlist">
								{#each versions as v (v.id)}
									<li>
										<span class="vmeta"><b>{v.name}</b><small>{fmtDate(v.created_at)}</small></span>
										{#if confirmOpen === v.id}
											<button type="button" class="btn primary" disabled={versionBusy} onclick={() => void openVersion(v)}>{t('house.openConfirm')}</button>
										{:else}
											<button type="button" class="btn" onclick={() => (confirmOpen = v.id)}>{t('house.open')}</button>
										{/if}
									</li>
								{/each}
							</ul>
						{:else}
							<p class="note">{t('house.noVersions')}</p>
						{/if}
					</div>
				{/if}
			</div>
			<div class="menu">
				<button type="button" class="btn" aria-label={t('house.export')} aria-expanded={exportOpen} onclick={() => { exportOpen = !exportOpen; versionsOpen = false; }}>
					<HouseIcon name="download" size={16} /><span class="lbl">{t('house.export')}</span>
				</button>
				{#if exportOpen}
					<div class="scrim" role="presentation" onpointerdown={() => (exportOpen = false)}></div>
					<div class="pop export" role="menu">
						<button type="button" role="menuitem" class="item" onclick={() => void exportGlb()} disabled={!model.elements.length}>
							<b>{t('house.exportGlb')}</b><small>{t('house.exportGlbHint')}</small>
						</button>
						<button type="button" role="menuitem" class="item" onclick={exportJson} disabled={!model.elements.length}>
							<b>{t('house.exportJson')}</b><small>{t('house.exportJsonHint')}</small>
						</button>
					</div>
				{/if}
			</div>
		</div>
	</header>

	{#if data.error}
		<p class="error" role="alert">{data.error}</p>
	{:else}
		<div class={['stage', sel && 'withpanel']}>
			<div class="vp" {@attach viewport}></div>

			<nav class="rail" aria-label={t('house.tools')}>
				{#each TOOLS as x (x.id)}
					<button
						type="button"
						class={['tool', tool === x.id && 'on']}
						aria-pressed={tool === x.id}
						title={`${t(x.label)} (${x.key})`}
						onclick={() => setTool(x.id)}
					>
						<HouseIcon name={x.icon} size={20} />
						<span>{t(x.label)}</span>
					</button>
				{/each}
			</nav>

			<div class="viewctl">
				<div class="seg" role="group" aria-label={t('house.view')}>
					<button type="button" class={[view === 'perspective' && 'on']} aria-pressed={view === 'perspective'} onclick={() => setView('perspective')}>3D</button>
					<button type="button" class={[view === 'top' && 'on']} aria-pressed={view === 'top'} onclick={() => setView('top')}>{t('house.viewTop')}</button>
				</div>
				<button type="button" class="ic raised" onclick={() => vp?.view(view)} title={t('house.fit')} aria-label={t('house.fit')}><HouseIcon name="fit" /></button>
			</div>

			<div class="dock">
				{#if tool === 'paint'}
					<div class="palette">{@render swatches(paintMaterial, setPaint)}</div>
				{/if}
				<div class="hintbar">
					<span class="hint">{t(HINTS[tool])}</span>
					{#if draft && draft.points > 0}
						{#if draft.canFinish}
							<button type="button" class="btn primary" onclick={() => vp?.finishDraft()}><HouseIcon name="check" size={16} />{t('house.finish')}</button>
						{/if}
						<button type="button" class="btn" onclick={() => vp?.cancelDraft()}><HouseIcon name="x" size={16} />{t('house.cancel')}</button>
					{:else if tool === 'slab' && model.elements.some((e) => e.type === 'wall')}
						<button type="button" class="btn" onclick={slabUnderWalls}>{t('house.slabUnderWalls')}</button>
					{/if}
				</div>
			</div>

			{#if !model.elements.length && !draft?.points}
				<div class="empty" aria-hidden={tool === 'wall'}>
					<b class="serif">{t('house.emptyTitle')}</b>
					<span>{t('house.emptyText')}</span>
				</div>
			{/if}

			{#if sel}
				<aside class="inspector" aria-label={t('house.inspector')}>
					<header>
						<span class="kind">{t(TYPE_LABEL[sel.type])}</span>
						<span class="ifc">{sel.type === 'pool' || sel.type === 'box' ? 'IfcBuildingElementProxy' : `Ifc${sel.type[0].toUpperCase()}${sel.type.slice(1)}`}</span>
						<button type="button" class="ic" onclick={() => select(null)} aria-label={t('house.close')}><HouseIcon name="x" size={16} /></button>
					</header>
					<label class="field wide">
						<span>{t('house.field.name')}</span>
						<input type="text" maxlength="120" value={sel.name} placeholder={t(TYPE_LABEL[sel.type])} onchange={(e) => update({ name: e.currentTarget.value.trim() })} />
					</label>
					<div class="grid">
						{#each fields as f (`${sel.id}:${f.key}`)}
							<label class="field">
								<span>{t(FIELD_LABEL[f.key])}</span>
								<span class="num">
									<input type="number" inputmode="decimal" step={f.key === 'rotation' ? 15 : 0.05} min={f.min} max={f.max} value={f.value} onchange={(e) => onNumber(f.key, e)} />
									<em>{f.key === 'rotation' ? '°' : 'm'}</em>
								</span>
							</label>
						{/each}
					</div>
					{#if sel.type === 'wall'}
						<p class="note">{t('house.wallLength', { m: wallLength.toFixed(2) })}</p>
					{/if}
					<div class="matlabel">
						<span>{t('house.material')}</span>
						<b>{findMaterial(sel.material).name[lang]}</b>
					</div>
					{@render swatches(sel.material, (id) => update({ material: id }))}
					<button type="button" class="btn danger del" onclick={remove}><HouseIcon name="trash" size={16} />{t('house.delete')}</button>
				</aside>
			{/if}

			{#if toast}<div class="toast" role="status">{toast}</div>{/if}
		</div>
	{/if}
</div>

<style>
	.house {
		position: fixed;
		inset: 0;
		display: flex;
		flex-direction: column;
		background: var(--canvas);
	}

	/* ---------- header ---------- */
	.bar {
		height: 56px;
		flex: none;
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 0 12px 0 16px;
		background: var(--surface);
		border-bottom: 1px solid var(--line);
		position: relative;
		z-index: 20;
	}
	.crumb {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		flex: 1;
	}
	.crumb a {
		text-decoration: none;
	}
	.home {
		font-weight: 600;
		font-size: 14px;
	}
	.sep {
		color: var(--faint);
	}
	.pname,
	.here {
		font-family: var(--font-serif);
		font-size: 18px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.pname {
		color: var(--muted);
		min-width: 0;
	}
	.pname:hover {
		color: var(--text);
	}
	.right {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.status {
		font-size: 12.5px;
		color: var(--muted);
		white-space: nowrap;
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.status.saved {
		color: var(--ok);
	}
	.status.error {
		color: var(--accent);
	}
	.retry {
		padding: 4px 8px;
	}
	.grp {
		display: flex;
	}
	.ic {
		display: inline-grid;
		place-items: center;
		width: 40px;
		height: 40px;
		padding: 0;
		border: 0;
		background: none;
		border-radius: var(--r-ctl);
		color: var(--text);
	}
	.ic:hover:not(:disabled) {
		background: var(--sunk);
	}
	.ic:disabled {
		color: var(--faint);
		cursor: default;
	}
	.ic.raised {
		background: var(--raised);
		box-shadow: 0 12px 32px -12px rgb(0 0 0 / 0.3), 0 0 0 1px var(--line);
	}
	.bar .btn {
		min-height: 40px;
	}
	.menu {
		position: relative;
	}
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 30;
	}
	.pop {
		position: absolute;
		right: 0;
		top: calc(100% + 8px);
		z-index: 31;
		width: min(360px, calc(100vw - 24px));
		padding: 12px;
		background: var(--raised);
		border-radius: var(--r-panel);
		box-shadow: 0 12px 32px -12px rgb(0 0 0 / 0.3), 0 0 0 1px var(--line);
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.keep {
		display: flex;
		gap: 8px;
	}
	.keep input {
		flex: 1;
		min-width: 0;
		min-height: 40px;
	}
	.note {
		margin: 0;
		font-size: 12.5px;
		color: var(--muted);
	}
	.vlist {
		list-style: none;
		margin: 0;
		padding: 0;
		max-height: 50vh;
		overflow: auto;
		border-top: 1px solid var(--line);
	}
	.vlist li {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 0;
		border-bottom: 1px solid var(--line);
	}
	.vmeta {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.vmeta b {
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.vmeta small {
		color: var(--muted);
		font-size: 12.5px;
	}
	.vlist .btn {
		min-height: 40px;
	}
	.export .item {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		text-align: left;
		border: 0;
		background: none;
		padding: 10px;
		border-radius: var(--r-ctl);
	}
	.export .item:hover:not(:disabled) {
		background: var(--sunk);
	}
	.export .item:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.export small {
		color: var(--muted);
		font-size: 12.5px;
	}

	/* ---------- stage ---------- */
	.stage {
		position: relative;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}
	.vp {
		position: absolute;
		inset: 0;
		touch-action: none;
	}
	.vp :global(.vp-label) {
		position: absolute;
		left: 0;
		top: 0;
		pointer-events: none;
		padding: 4px 8px;
		border-radius: var(--r-pill);
		background: var(--text);
		color: var(--bg);
		font: 600 12.5px/1.2 var(--font-sans);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.rail {
		position: absolute;
		left: 12px;
		top: 12px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 6px;
		border-radius: var(--r-panel);
		background: var(--raised);
		box-shadow: 0 12px 32px -12px rgb(0 0 0 / 0.3), 0 0 0 1px var(--line);
		max-height: calc(100% - 24px);
		overflow: auto;
	}
	.tool {
		width: 64px;
		min-height: 52px;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 3px;
		padding: 6px 2px;
		border: 0;
		background: none;
		border-radius: var(--r-ctl);
		color: var(--muted);
		font-size: 11.5px;
		line-height: 1.1;
		text-align: center;
	}
	.tool:hover {
		background: var(--sunk);
		color: var(--text);
	}
	.tool.on {
		background: var(--text);
		color: var(--bg);
	}

	.viewctl {
		position: absolute;
		right: 12px;
		top: 12px;
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.viewctl .seg {
		box-shadow: 0 12px 32px -12px rgb(0 0 0 / 0.3);
	}
	.viewctl .seg button {
		min-height: 40px;
		padding: 0 14px;
	}

	.dock {
		position: absolute;
		left: 50%;
		bottom: 16px;
		transform: translateX(-50%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		width: min(760px, calc(100% - 24px));
		pointer-events: none;
	}
	.dock > * {
		pointer-events: auto;
	}
	/* Keep the hint clear of the inspector (320px + gaps on the right). */
	.withpanel .dock {
		left: calc(50% - 170px);
		width: min(760px, calc(100% - 380px));
	}
	.hintbar,
	.palette {
		background: var(--raised);
		box-shadow: 0 12px 32px -12px rgb(0 0 0 / 0.3), 0 0 0 1px var(--line);
	}
	.hintbar {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 48px;
		padding: 4px 4px 4px 16px;
		border-radius: var(--r-pill);
		max-width: 100%;
	}
	.hint {
		font-size: 13px;
		color: var(--muted);
		padding: 6px 4px 6px 0;
	}
	.hintbar .btn {
		min-height: 40px;
		border-radius: var(--r-pill);
	}
	.palette {
		border-radius: var(--r-panel);
		padding: 8px;
		max-width: 100%;
	}
	.palette .swatches {
		flex-wrap: nowrap;
		overflow-x: auto;
	}

	.swatches {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.sw {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		width: 64px;
		padding: 6px 2px;
		border: 1px solid transparent;
		background: none;
		border-radius: var(--r-ctl);
		font-size: 11px;
		line-height: 1.15;
		color: var(--muted);
		text-align: center;
	}
	.sw:hover {
		background: var(--sunk);
	}
	.sw.on {
		border-color: var(--text);
		color: var(--text);
	}
	.dot {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.15);
	}
	.nm {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.empty {
		position: absolute;
		left: 50%;
		top: 38%;
		transform: translate(-50%, -50%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		text-align: center;
		pointer-events: none;
		color: var(--muted);
		max-width: 320px;
	}
	.empty b {
		font-size: 22px;
		color: var(--text);
		font-weight: 400;
	}

	.inspector {
		position: absolute;
		right: 12px;
		top: 64px;
		bottom: 12px;
		width: 320px;
		overflow: auto;
		padding: 12px 14px 16px;
		border-radius: var(--r-panel);
		background: var(--raised);
		box-shadow: 0 12px 32px -12px rgb(0 0 0 / 0.3), 0 0 0 1px var(--line);
		display: flex;
		flex-direction: column;
		gap: 12px;
		animation: slide 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	@keyframes slide {
		from {
			transform: translateX(16px);
			opacity: 0;
		}
	}
	.inspector header {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.kind {
		font-weight: 600;
		font-size: 16px;
	}
	.ifc {
		flex: 1;
		font: 11px/1 ui-monospace, Menlo, monospace;
		color: var(--faint);
	}
	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}
	.field > span:first-child,
	.matlabel span {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--muted);
	}
	.field input {
		min-height: 40px;
		width: 100%;
	}
	.num {
		position: relative;
	}
	.num input {
		padding-right: 26px;
		font-variant-numeric: tabular-nums;
	}
	.num em {
		position: absolute;
		right: 10px;
		top: 50%;
		transform: translateY(-50%);
		font-style: normal;
		color: var(--faint);
		font-size: 12.5px;
		pointer-events: none;
	}
	.matlabel {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
	}
	.matlabel b {
		font-weight: 600;
		font-size: 13px;
	}
	.del {
		align-self: flex-start;
		min-height: 40px;
		margin-top: 4px;
	}

	.toast {
		position: absolute;
		left: 50%;
		top: 16px;
		transform: translateX(-50%);
		background: var(--text);
		color: var(--bg);
		padding: 10px 16px;
		border-radius: var(--r-pill);
		font-size: 13px;
		z-index: 25;
	}
	.error {
		margin: 24px;
		color: var(--accent);
	}

	/* Tablets in portrait and phones: the inspector becomes a bottom sheet, the rail stays left. */
	@media (max-width: 900px) {
		.inspector {
			left: 0;
			right: 0;
			top: auto;
			bottom: 0;
			width: auto;
			max-height: 52%;
			border-radius: var(--r-panel) var(--r-panel) 0 0;
			z-index: 15;
		}
		.inspector .grid {
			grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
		}
		.lbl {
			display: none;
		}
		.withpanel .dock {
			left: 50%;
			width: min(760px, calc(100% - 24px));
		}
	}
	@media (max-width: 640px) {
		.status:not(.error) {
			display: none;
		}
		.pname,
		.home,
		.crumb .sep {
			display: none;
		}
		.rail {
			flex-direction: row;
			top: auto;
			bottom: 12px;
			left: 12px;
			right: 12px;
			max-height: none;
			overflow-x: auto;
		}
		.dock {
			bottom: 92px;
		}
		.viewctl {
			top: 12px;
		}
	}
	@media (pointer: coarse) {
		.tool {
			width: 68px;
			min-height: 56px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.inspector {
			animation: none;
		}
	}
</style>
