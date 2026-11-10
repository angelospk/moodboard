<script lang="ts">
	// Project board: header, tag row, canvas with tag zones, dock, inspiration panel.
	// Board.svelte owns the canvas (simulation, pan/zoom, drag, drop, saved positions); this page owns
	// the data, filters, selection, adding images, menus and toasts.
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount, tick, untrack } from 'svelte';
	import type { Inspiration, Level } from '#lib/types.js';
	import {
		checkImage,
		copyInspiration,
		createInspiration,
		deleteInspiration,
		updateInspiration
	} from '#lib/inspirations.js';
	import InspirationPanel from '#lib/components/InspirationPanel.svelte';
	import Board, { type BoardContext, type Spot } from './Board.svelte';
	import BoardHeader from './BoardHeader.svelte';
	import TagChips from './TagChips.svelte';
	import Dock from './Dock.svelte';
	import ContextMenu, { type MenuItem } from './ContextMenu.svelte';
	import Toasts, { type Toast } from './Toasts.svelte';
	import Icon from './Icon.svelte';
	import { CARD_GAP, isTyping, searchText, zoneColors } from './board.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const LS_KEY = 'moodboard:map';
	const SIZE_MIN = 80;
	const SIZE_MAX = 360;
	const PANEL_W = 400;
	const MOBILE = 640;
	const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/avif';
	const ROW_FIELDS = 'id, project_id, tags, level, note, image_path, regions, source_url, source_title, created_at';

	const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

	// ------------------------------------------------------------------ Data

	/** Local copy of the rows: edits, adds and deletes show at once; a reload replaces it. */
	let items = $derived(data.inspirations);
	/** Blob URLs of images added in this session, by inspiration id. */
	let localUrls = $state.raw<Record<string, string>>({});
	/** Signed URL per image path, kept stable across reloads so images do not re-download. */
	const urlCache = new Map<string, { url: string; at: number }>();

	function urlOf(i: Inspiration): string | null {
		const local = localUrls[i.id];
		if (local) return local;
		const fresh = data.urls[i.image_path];
		const hit = urlCache.get(i.image_path);
		// Signed URLs live an hour; take the newer one after 50 minutes.
		if (hit && Date.now() - hit.at < 50 * 60_000) return hit.url;
		if (!fresh) return hit?.url ?? null;
		urlCache.set(i.image_path, { url: fresh, at: Date.now() });
		return fresh;
	}

	function setItem(row: Inspiration) {
		items = items.map((i) => (i.id === row.id ? { ...i, ...row } : i));
	}

	// -------------------------------------------------------------- Filters

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
				: (data.projects.find((p) => p.id === project)?.name ?? 'Project')
	);
	/** Project of new images added on this board. */
	const newProjectId = $derived(project === 'all' || project === 'none' ? null : project);

	let level = $state<Level | ''>('');
	let search = $state('');
	let highlight = $state<string | null>(null);
	let notesOn = $state(false);
	let size = $state(160);
	let prefsLoaded = false;

	const inProject = $derived(
		items.filter((i) => (project === 'none' ? i.project_id === null : project === 'all' || i.project_id === project))
	);
	const filtered = $derived(level ? inProject.filter((i) => i.level === level) : inProject);

	const matches = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (!q) return null;
		return new Set(filtered.filter((i) => searchText(i).includes(q)).map((i) => i.id));
	});

	const tagStats = $derived.by(() => {
		const count = new Map<string, number>();
		for (const i of filtered) for (const t of new Set(i.tags ?? [])) count.set(t, (count.get(t) ?? 0) + 1);
		return [...count]
			.map(([tag, n]) => ({ tag, count: n }))
			.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
	});
	const colors = $derived(zoneColors(tagStats.map((t) => t.tag)));

	const options = $derived.by(() => {
		const per = new Map<string | null, number>();
		for (const i of items) per.set(i.project_id, (per.get(i.project_id) ?? 0) + 1);
		return [
			{ id: 'all', name: 'Όλα τα projects', count: items.length },
			...data.projects.map((p) => ({ id: p.id, name: p.name, count: per.get(p.id) ?? 0 })),
			{ id: 'none', name: 'Χωρίς project', count: per.get(null) ?? 0 }
		];
	});

	// A highlighted tag that left the view is no longer a filter.
	$effect(() => {
		const h = highlight;
		if (h && !tagStats.some((t) => t.tag === h)) untrack(() => (highlight = null));
	});

	function selectProject(id: string) {
		const url = id === 'all' ? '/map' : `/map?project=${encodeURIComponent(id)}`;
		highlight = null;
		// `reset: false` keeps focus and scroll.
		void goto(url, { replace: true, reset: false });
	}

	function toggleTag(tag: string) {
		highlight = highlight === tag ? null : tag;
	}

	// ------------------------------------------------------------ Selection

	let selectedId = $state<string | null>(null);
	let focusNote = $state(false);
	let innerWidth = $state(1280);

	const selIndex = $derived(selectedId ? filtered.findIndex((i) => i.id === selectedId) : -1);
	const selected = $derived(selIndex >= 0 ? filtered[selIndex] : null);
	const panelOpen = $derived(!!selected && !!data.userId);
	const rightInset = $derived(panelOpen && innerWidth > MOBILE ? PANEL_W : 0);

	let board = $state<ReturnType<typeof Board>>();

	function select(id: string | null, opts: { focus?: boolean } = {}) {
		selectedId = id;
		focusNote = !!opts.focus;
		// The panel may now cover the card: pan it into view once the inset is known.
		if (id) void tick().then(() => board?.reveal(id));
	}

	function step(dir: -1 | 1) {
		if (selIndex < 0) return;
		const next = filtered[selIndex + dir];
		if (!next) return;
		select(next.id);
	}

	// ---------------------------------------------------------------- Toasts

	let toasts = $state<Toast[]>([]);
	let toastSeq = 0;
	const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();

	function dismiss(id: number) {
		toasts = toasts.filter((t) => t.id !== id);
		clearTimeout(toastTimers.get(id));
		toastTimers.delete(id);
	}

	function toast(t: Omit<Toast, 'id'> | string, ms = 2800): number {
		const id = ++toastSeq;
		const entry = typeof t === 'string' ? { text: t } : t;
		toasts = [...toasts, { ...entry, id }].slice(-4);
		if (ms) toastTimers.set(id, setTimeout(() => dismiss(id), ms));
		return id;
	}

	const errText = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback);

	// ------------------------------------------------------------ Adding

	let fileInput = $state<HTMLInputElement | null>(null);
	/** Where images picked in the file dialog go; null = centre of the view. */
	let pickSpot: Spot | null = null;
	let isMac = $state(true);
	const mod = $derived(isMac ? '⌘' : 'Ctrl+');

	function pickFiles(spot: Spot | null = null) {
		if (!data.userId) {
			toast({ text: 'Συνδέσου για να προσθέσεις εικόνες', tone: 'error' }, 5000);
			return;
		}
		pickSpot = spot;
		if (fileInput) {
			fileInput.value = '';
			fileInput.click();
		}
	}

	function onFilesPicked(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const files = [...(input.files ?? [])];
		const spot = pickSpot ?? board?.centreSpot() ?? { x: 0, y: 0, zone: null };
		pickSpot = null;
		if (files.length) void addFiles(files, spot);
	}

	async function fetchRow(id: string, fallback: Inspiration): Promise<Inspiration> {
		const { data: row } = await data.supabase.from('inspirations').select(ROW_FIELDS).eq('id', id).maybeSingle();
		return row ? ({ ...fallback, ...(row as Partial<Inspiration>) } as Inspiration) : fallback;
	}

	/** Save each image at once, pinned where it was added, then open the first in the panel. */
	async function addFiles(files: File[], spot: Spot) {
		const userId = data.userId;
		if (!userId) {
			toast({ text: 'Συνδέσου για να προσθέσεις εικόνες', tone: 'error' }, 5000);
			return;
		}
		// A new image must be visible where it lands: clear what would hide or fade it.
		search = '';
		if (highlight && highlight !== spot.zone) highlight = null;
		const projectId = newProjectId;
		const tags = spot.zone ? [spot.zone] : [];
		const cols = Math.ceil(Math.sqrt(files.length));
		let first: string | null = null;
		let added = 0;
		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			const x = spot.x + (i % cols) * (size + CARD_GAP);
			const y = spot.y + Math.floor(i / cols) * (size * 0.9 + CARD_GAP);
			const label = files.length > 1 ? `Ανεβαίνει ${i + 1} από ${files.length}…` : 'Ανεβαίνει η εικόνα…';
			const busy = toast({ text: label, tone: 'busy' }, 0);
			try {
				checkImage(file);
				const { id } = await createInspiration(data.supabase, userId, file, {
					project_id: projectId,
					tags,
					level: level || null
				});
				const now = new Date().toISOString();
				const row = await fetchRow(id, {
					id,
					project_id: projectId,
					image_path: '',
					source_url: null,
					source_title: null,
					note: '',
					tags,
					level: level || null,
					regions: [],
					created_at: now,
					updated_at: now
				});
				localUrls = { ...localUrls, [id]: URL.createObjectURL(file) };
				board?.place(id, x, y);
				items = [row, ...items];
				first ??= id;
				added++;
			} catch (err) {
				const name = file.name && file.name !== 'image.png' ? `${file.name}: ` : '';
				toast({ text: name + errText(err, 'Η εικόνα δεν αποθηκεύτηκε'), tone: 'error' }, 8000);
			} finally {
				dismiss(busy);
			}
		}
		if (!first) return;
		select(first, { focus: true });
		if (added > 1) toast(`Προστέθηκαν ${added} εικόνες`);
		void invalidate('moodboard:data');
	}

	function onPaste(e: ClipboardEvent) {
		if (isTyping(e.target) || isTyping(document.activeElement)) return;
		const files: File[] = [];
		for (const it of e.clipboardData?.items ?? []) {
			if (it.kind !== 'file' || !it.type.startsWith('image/')) continue;
			const f = it.getAsFile();
			if (f) files.push(f);
		}
		if (!files.length) return;
		e.preventDefault();
		menu = null;
		void addFiles(files, board?.pointerSpot() ?? { x: 0, y: 0, zone: null });
	}

	/** «Επικόλληση εδώ»: read an image from the clipboard (needs permission; falls back to a hint). */
	async function pasteAt(spot: Spot) {
		try {
			const entries = await navigator.clipboard.read();
			const files: File[] = [];
			for (const entry of entries) {
				const type = entry.types.find((t) => t.startsWith('image/'));
				if (!type) continue;
				const blob = await entry.getType(type);
				files.push(new File([blob], `paste.${type.split('/')[1]}`, { type }));
			}
			if (!files.length) {
				toast('Δεν υπάρχει εικόνα στο πρόχειρο');
				return;
			}
			await addFiles(files, spot);
		} catch {
			toast(`Πάτα ${mod}V για επικόλληση`, 4000);
		}
	}

	// ------------------------------------------------------------ Organising

	type From = { x?: number; y?: number; fx?: number | null; fy?: number | null };

	async function rezone(item: Inspiration, tag: string, from: From) {
		const prev = item.tags ?? [];
		const next = [tag, ...prev.filter((t) => t !== tag)];
		setItem({ ...item, tags: next });
		try {
			setItem(await updateInspiration(data.supabase, item.id, { tags: next }));
			toast({ text: `+ #${tag}`, action: { label: 'Αναίρεση', run: () => void undoRezone(item.id, tag, prev, from) } }, 5000);
		} catch (err) {
			setItem(item);
			toast({ text: errText(err, 'Το tag δεν αποθηκεύτηκε'), tone: 'error' }, 6000);
		}
	}

	/** Undo only the retag: later tag edits stay. */
	async function undoRezone(id: string, tag: string, prev: string[], from: From) {
		const cur = items.find((i) => i.id === id);
		if (!cur) return;
		const rest = (cur.tags ?? []).filter((t) => t !== tag);
		const at = prev.indexOf(tag);
		const tags = at < 0 ? rest : [...rest.slice(0, at), tag, ...rest.slice(at)];
		setItem({ ...cur, tags });
		board?.restore(id, from);
		try {
			setItem(await updateInspiration(data.supabase, id, { tags }));
		} catch (err) {
			setItem(cur);
			toast({ text: errText(err, 'Η αναίρεση απέτυχε'), tone: 'error' }, 6000);
		}
	}

	async function copyTo(id: string, projectId: string | null) {
		const userId = data.userId;
		if (!userId) return;
		try {
			await copyInspiration(data.supabase, userId, id, projectId);
			onCopied(projectId ? (data.projects.find((p) => p.id === projectId)?.name ?? null) : null);
		} catch (err) {
			toast({ text: errText(err, 'Η αντιγραφή απέτυχε'), tone: 'error' }, 6000);
		}
	}

	function onCopied(projectName: string | null) {
		toast(projectName ? `Αντιγράφηκε στο ${projectName}` : 'Αντιγράφηκε χωρίς project');
		void invalidate('moodboard:data');
	}

	function onDeleted(id: string) {
		items = items.filter((i) => i.id !== id);
		if (selectedId === id) select(null);
		board?.forget(id);
		toast('Η εικόνα διαγράφηκε');
	}

	async function remove(id: string) {
		try {
			await deleteInspiration(data.supabase, id);
			onDeleted(id);
		} catch (err) {
			toast({ text: errText(err, 'Η διαγραφή απέτυχε'), tone: 'error' }, 6000);
		}
	}

	// ----------------------------------------------------------------- Menus

	type Menu =
		| { view: 'canvas'; x: number; y: number; spot: Spot }
		| { view: 'card' | 'copy' | 'delete'; x: number; y: number; id: string };

	let menu = $state<Menu | null>(null);
	let switcherOpen = $state(false);
	let filtersOpen = $state(false);

	function onContext(c: BoardContext) {
		menu =
			c.kind === 'card'
				? { view: 'card', x: c.clientX, y: c.clientY, id: c.id }
				: { view: 'canvas', x: c.clientX, y: c.clientY, spot: c.spot };
	}

	function act(fn: () => void) {
		return () => {
			menu = null;
			fn();
		};
	}

	const menuModel = $derived.by((): { title?: string; onback?: () => void; items: MenuItem[] } | null => {
		const m = menu;
		if (!m) return null;
		if (m.view === 'canvas') {
			const spot = m.spot;
			return {
				items: [
					{ label: 'Νέα εικόνα εδώ…', icon: 'image', kbd: 'N', onselect: act(() => pickFiles(spot)) },
					{ label: 'Επικόλληση εδώ', icon: 'paste', kbd: `${mod}V`, onselect: act(() => void pasteAt(spot)) },
					{ label: 'Κεντράρισμα', icon: 'fit', kbd: 'F', onselect: act(() => board?.fit()) }
				]
			};
		}
		const id = m.id;
		const back = () => (menu = { ...m, view: 'card' });
		if (m.view === 'copy') {
			return {
				title: 'Αντιγραφή σε',
				onback: back,
				items: [
					...data.projects.map((p) => ({ label: p.name, onselect: act(() => void copyTo(id, p.id)) })),
					{ label: 'Χωρίς project', onselect: act(() => void copyTo(id, null)) }
				]
			};
		}
		if (m.view === 'delete') {
			return {
				title: 'Διαγραφή εικόνας;',
				onback: back,
				items: [
					{ label: 'Διαγραφή οριστικά', icon: 'trash', danger: true, onselect: act(() => void remove(id)) },
					{ label: 'Άκυρο', onselect: () => (menu = null) }
				]
			};
		}
		return {
			items: [
				{ label: 'Άνοιγμα', icon: 'open', onselect: act(() => select(id)) },
				{ label: 'Αντιγραφή σε…', icon: 'copy', more: true, onselect: () => (menu = { ...m, view: 'copy' }) },
				{ label: 'Διαγραφή', icon: 'trash', danger: true, more: true, onselect: () => (menu = { ...m, view: 'delete' }) }
			]
		};
	});

	// -------------------------------------------------------------- Keyboard

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			// First Esc leaves the field (e.g. the note focused after adding); the next one closes.
			if (isTyping(e.target)) {
				if (!e.defaultPrevented && e.target instanceof HTMLElement && !e.target.closest('.menu, .pop')) e.target.blur();
				return;
			}
			if (menu) menu = null;
			else if (switcherOpen) switcherOpen = false;
			else if (filtersOpen) filtersOpen = false;
			else if (selectedId) select(null);
			else if (highlight) highlight = null;
			else return;
			e.preventDefault();
			return;
		}
		if (e.metaKey || e.ctrlKey || e.altKey || e.repeat && e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return;
		if (isTyping(e.target) || menu || switcherOpen || filtersOpen) return;
		const t = e.target as HTMLElement | null;
		// e.code, so the keys also work with a Greek keyboard layout.
		if (e.code === 'KeyN') pickFiles(null);
		else if (e.code === 'KeyF') board?.fit();
		else if (e.code === 'KeyL') void board?.autoLayout();
		else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && selected && t?.getAttribute('type') !== 'range') {
			step(e.key === 'ArrowLeft' ? -1 : 1);
		} else return;
		e.preventDefault();
	}

	// ------------------------------------------------------------- Lifecycle

	onMount(() => {
		isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
		try {
			const raw = localStorage.getItem(LS_KEY);
			if (raw) {
				const v = JSON.parse(raw) as { size?: unknown; notesOn?: unknown };
				if (typeof v.size === 'number' && Number.isFinite(v.size)) size = clamp(Math.round(v.size), SIZE_MIN, SIZE_MAX);
				if (typeof v.notesOn === 'boolean') notesOn = v.notesOn;
			}
		} catch {
			/* storage unavailable: keep the defaults */
		}
		prefsLoaded = true;
		return () => {
			for (const t of toastTimers.values()) clearTimeout(t);
			for (const u of Object.values(localUrls)) URL.revokeObjectURL(u);
		};
	});

	$effect(() => {
		const prefs = { size, notesOn };
		if (!prefsLoaded) return;
		try {
			localStorage.setItem(LS_KEY, JSON.stringify(prefs));
		} catch {
			/* ignore */
		}
	});

	const boardEmpty = $derived(inProject.length === 0);
	const hint = $derived(filtered.length < 3 && !boardEmpty ? `${mod}V επικόλληση · σύρε εικόνες εδώ` : null);
</script>

<svelte:head>
	<title>{projectName} · Moodboard</title>
</svelte:head>

<svelte:window bind:innerWidth onkeydown={onKey} onpaste={onPaste} />

<div class="page">
	<BoardHeader
		current={project}
		currentName={projectName}
		{options}
		onproject={selectProject}
		bind:search
		bind:level
		bind:switcherOpen
		bind:filtersOpen
		tags={tagStats}
		{colors}
		{highlight}
		ontoggletag={toggleTag}
	/>

	{#if tagStats.length}
		<div class="tagrow">
			<TagChips tags={tagStats} {colors} {highlight} ontoggle={toggleTag} />
		</div>
	{/if}

	<div class="body">
		{#if data.error}
			<p class="msg">Σφάλμα φόρτωσης: {data.error}</p>
		{:else}
			<Board
				bind:this={board}
				supabase={data.supabase}
				items={filtered}
				{urlOf}
				{colors}
				{size}
				{notesOn}
				selectedId={panelOpen ? selectedId : null}
				{highlight}
				{matches}
				scope={data.positionsScope}
				seed={data.positions}
				canSave={!!data.userId}
				{rightInset}
				onselect={(id) => select(id)}
				onbackground={() => {
					if (selectedId) select(null);
				}}
				oncontext={onContext}
				onfiles={(files, spot) => void addFiles(files, spot)}
				onpick={(spot) => pickFiles(spot)}
				onrezone={(item, tag, from) => void rezone(item, tag, from)}
				onzoneadd={(_tag, spot) => pickFiles(spot)}
				ontoast={(msg) => toast({ text: msg, tone: 'error' }, 5000)}
			/>

			{#if boardEmpty}
				<div class="empty" style:--inset="{rightInset}px">
					<div class="emptybox">
						<svg class="emptyart" viewBox="0 0 96 64" aria-hidden="true">
							<rect x="6" y="14" width="34" height="42" rx="3" />
							<rect x="30" y="6" width="40" height="30" rx="3" />
							<rect x="52" y="28" width="38" height="30" rx="3" />
						</svg>
						<h1>{project === 'all' ? 'Ο πίνακας είναι άδειος' : `Το «${projectName}» δεν έχει εικόνες`}</h1>
						<p>Σύρε εικόνες εδώ, κάνε επικόλληση με <kbd class="kbd">{mod}V</kbd> ή διάλεξε αρχεία.</p>
						<div class="emptyacts">
							<button type="button" class="btn primary" onclick={() => pickFiles(null)}>
								<Icon name="plus" size={15} /> Εικόνα <kbd class="kbd onacc">N</kbd>
							</button>
							<button
								type="button"
								class="btn"
								onclick={() => void pasteAt(board?.centreSpot() ?? { x: 0, y: 0, zone: null })}
							>
								<Icon name="paste" size={15} /> Επικόλληση
							</button>
						</div>
					</div>
				</div>
			{:else if filtered.length === 0}
				<div class="empty" style:--inset="{rightInset}px">
					<div class="emptybox small">
						<p>Καμία εικόνα σε αυτό το επίπεδο.</p>
						<button type="button" class="btn" onclick={() => (level = '')}>Όλα τα επίπεδα</button>
					</div>
				</div>
			{:else if matches && matches.size === 0}
				<p class="nomatch" style:--inset="{rightInset}px">Καμία εικόνα για «{search.trim()}»</p>
			{/if}

			{#if !boardEmpty}
				<Dock
					bind:notesOn
					bind:size
					min={SIZE_MIN}
					max={SIZE_MAX}
					{hint}
					inset={rightInset}
					onadd={() => pickFiles(null)}
					onfit={() => board?.fit()}
					onlayout={() => void board?.autoLayout()}
				/>
			{/if}
			<Toasts {toasts} inset={rightInset} ondismiss={dismiss} />
		{/if}

		{#if panelOpen && selected && data.userId}
			<div class="panelwrap">
				<InspirationPanel
					supabase={data.supabase}
					userId={data.userId}
					item={selected}
					imageUrl={urlOf(selected)}
					projects={data.projects}
					suggestions={data.tags}
					{focusNote}
					onsaved={setItem}
					oncopied={onCopied}
					ondeleted={onDeleted}
					onclose={() => select(null)}
					onprev={selIndex > 0 ? () => step(-1) : undefined}
					onnext={selIndex >= 0 && selIndex < filtered.length - 1 ? () => step(1) : undefined}
				/>
			</div>
		{/if}
	</div>
</div>

{#if menu && menuModel}
	<ContextMenu
		x={menu.x}
		y={menu.y}
		items={menuModel.items}
		title={menuModel.title}
		onback={menuModel.onback}
		onclose={() => (menu = null)}
	/>
{/if}

<input bind:this={fileInput} class="file" type="file" accept={ACCEPT} multiple tabindex="-1" aria-hidden="true" onchange={onFilesPicked} />

<style>
	.page {
		position: fixed;
		inset: 0;
		display: flex;
		flex-direction: column;
		background: var(--bg);
		overflow: hidden;
	}
	.tagrow {
		flex: none;
		height: 40px;
		display: flex;
		align-items: center;
		padding: 0 20px;
		background: var(--surface);
		border-bottom: 1px solid var(--line);
		position: relative;
		z-index: 20;
	}
	.body {
		position: relative;
		flex: 1;
		min-height: 0;
	}
	.msg {
		color: var(--muted);
		padding: 32px 20px;
		margin: 0;
	}

	.panelwrap {
		position: absolute;
		top: 0;
		right: 0;
		bottom: 0;
		width: 400px;
		z-index: 25;
		overflow-y: auto;
		overscroll-behavior: contain;
		background: var(--surface);
		border-left: 1px solid var(--line);
		box-shadow: -16px 0 32px -24px rgb(0 0 0 / 0.35);
		animation: slide 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	@keyframes slide {
		from {
			transform: translateX(24px);
			opacity: 0;
		}
	}

	.empty {
		position: absolute;
		inset: 0 var(--inset, 0px) 0 0;
		display: grid;
		place-items: center;
		padding: 16px;
		pointer-events: none;
	}
	.emptybox {
		pointer-events: auto;
		max-width: 380px;
		text-align: center;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
	}
	.emptyart {
		width: 96px;
		height: 64px;
		margin-bottom: 8px;
		fill: var(--raised);
		stroke: var(--line-strong);
		stroke-width: 1;
	}
	.emptybox h1 {
		margin: 0;
		font-size: 22px;
		font-weight: 600;
		line-height: 1.25;
		text-wrap: balance;
	}
	.emptybox p {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
		line-height: 1.55;
		text-wrap: pretty;
	}
	.emptyacts {
		display: flex;
		gap: 8px;
		margin-top: 10px;
	}
	.emptyacts .btn {
		min-height: 38px;
	}
	.kbd.onacc {
		background: transparent;
		color: inherit;
		border-color: color-mix(in srgb, var(--on-accent) 45%, transparent);
		margin-left: 2px;
	}
	.emptybox.small {
		flex-direction: row;
		gap: 12px;
		padding: 8px 8px 8px 16px;
		border-radius: var(--r-pill);
		background: var(--raised);
		box-shadow:
			0 12px 32px -12px rgb(0 0 0 / 0.3),
			0 0 0 1px var(--line);
		max-width: none;
	}
	.nomatch {
		position: absolute;
		top: 14px;
		left: calc((100% - var(--inset, 0px)) / 2);
		transform: translateX(-50%);
		margin: 0;
		padding: 6px 14px;
		border-radius: var(--r-pill);
		background: var(--raised);
		box-shadow: 0 0 0 1px var(--line);
		font-size: 13px;
		color: var(--muted);
		white-space: nowrap;
		pointer-events: none;
	}
	.file {
		position: fixed;
		width: 1px;
		height: 1px;
		opacity: 0;
		pointer-events: none;
		left: -10px;
		top: -10px;
	}

	@media (max-width: 640px) {
		.tagrow {
			display: none;
		}
		.panelwrap {
			position: fixed;
			top: auto;
			left: 0;
			width: auto;
			height: 75vh;
			height: 75dvh;
			z-index: 45;
			border-left: 0;
			border-radius: var(--r-panel) var(--r-panel) 0 0;
			box-shadow: 0 -16px 40px -16px rgb(0 0 0 / 0.4);
			padding-bottom: env(safe-area-inset-bottom);
			animation-name: sheet;
		}
		@keyframes sheet {
			from {
				transform: translateY(32px);
				opacity: 0;
			}
		}
		.emptyacts {
			flex-direction: column;
			width: 100%;
		}
		.emptyacts .btn {
			justify-content: center;
			min-height: 42px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.panelwrap {
			animation: none;
		}
	}
</style>
