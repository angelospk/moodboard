<script lang="ts">
	import { reloadData } from '#lib/reload.js';
	import { forceNextLoad } from '#lib/datacache.js';
	import { t } from '#lib/i18n.js';
	// Project board: header, tag row, canvas with tag zones, dock, inspiration panel.
	// Board.svelte owns the canvas (simulation, pan/zoom, drag, drop, saved positions); this page owns
	// the data, filters, selection, adding images, menus and toasts.
	import { goto } from '$app/navigation';
	import { searchByMeaning, SmartSearchError } from '#lib/semantic.js';
	import { needSmart } from '#lib/smart.svelte.js';
	import { page } from '$app/state';
	import { onMount, tick, untrack } from 'svelte';
	import type { Crop, Inspiration, Level } from '#lib/types.js';
	import {
		checkImage,
		newId,
		copyInspiration,
		createInspiration,
		deleteInspiration,
		updateInspiration,
		imageUrls,
		toInspiration
	} from '#lib/inspirations.js';
	import { applyEvent, subscribeLive } from '#lib/realtime.js';
	import type { RecordModel, RecordSubscription } from 'pocketbase';
	import InspirationPanel from '#lib/components/InspirationPanel.svelte';
	import ImageViewer from '#lib/components/ImageViewer.svelte';
	import { neighborUrls } from '#lib/prefetch.js';
	import Board, { type BoardContext, type Spot } from './Board.svelte';
	import BoardHeader from './BoardHeader.svelte';
	import TagChips from './TagChips.svelte';
	import Dock from './Dock.svelte';
	import ContextMenu, { type MenuItem } from './ContextMenu.svelte';
	import Toasts, { type Toast } from './Toasts.svelte';
	import Icon from './Icon.svelte';
	import ShareMenu from './ShareMenu.svelte';
	import { CARD_GAP, isTyping, searchText, viewerList, zoneColors } from './board.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const LS_KEY = 'moodboard:map';
	const SIZE_MIN = 140;
	const SIZE_MAX = 520;
	const PANEL_W = 400;
	const MOBILE = 640;
	const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/avif';

	const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

	// ------------------------------------------------------------------ Data

	/** Cards added here whose upload has not finished, by id. Not reactive: read only when the server
	 *  data reloads, so a reload during an upload keeps those cards on the board. */
	const pendingRows = new Map<string, Inspiration>();
	$effect(() => {
		for (const i of data.inspirations) pendingRows.delete(i.id);
	});
	/** Local copy of the rows: edits, adds and deletes show at once; a reload replaces it. */
	let items = $derived.by(() => {
		const known = new Set(data.inspirations.map((i) => i.id));
		return [...[...pendingRows.values()].filter((r) => !known.has(r.id)), ...data.inspirations];
	});
	/** Blob URLs of images added in this session, by inspiration id. */
	let localUrls = $state.raw<Record<string, string>>({});
	/** Image URLs of rows that arrived live (added on another device), by image path. */
	let liveUrls = $state.raw<Record<string, string>>({});

	/** Full-size URL. The file token is cached for days, so a reload gives the same URL (browser cache). */
	function urlOf(i: Inspiration): string | null {
		return localUrls[i.id] ?? data.urls[i.image_path] ?? liveUrls[i.image_path] ?? null;
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
			? t('common.allProjects')
			: project === 'none'
				? t('common.noProject')
				: (data.projects.find((p) => p.id === project)?.name ?? 'Project')
	);
	/** Project of new images added on this board. */
	const newProjectId = $derived(project === 'all' || project === 'none' ? null : project);

	let level = $state<Level | ''>('');
	let search = $state('');
	let highlight = $state<string | null>(null);
	let notesOn = $state(false);
	let size = $state(220);
	let prefsLoaded = false;

	const inProject = $derived(
		items.filter((i) => (project === 'none' ? i.project_id === null : project === 'all' || i.project_id === project))
	);
	const filtered = $derived(level ? inProject.filter((i) => i.level === level) : inProject);

	// Search by meaning: the ids the server found for the last query, best first (needs consent).
	let byMeaning = $state(false);
	let meaningBusy = $state(false);
	let meaning = $state<{ q: string; ids: string[] } | null>(null);

	const matches = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (byMeaning) {
			// Until Enter runs the query (or after the text changed), nothing is dimmed.
			if (!meaning || meaning.q !== search.trim()) return null;
			const shown = new Set(filtered.map((i) => i.id));
			return new Set(meaning.ids.filter((id) => shown.has(id)));
		}
		if (!q) return null;
		return new Set(filtered.filter((i) => searchText(i).includes(q)).map((i) => i.id));
	});

	async function toggleMeaning() {
		if (!byMeaning && !(await needSmart('embed'))) return;
		byMeaning = !byMeaning;
		meaning = null;
	}

	async function runMeaning() {
		const q = search.trim();
		if (!q || meaningBusy) return;
		if (!(await needSmart('embed'))) return;
		meaningBusy = true;
		try {
			const scope = project !== 'all' && project !== 'none' ? project : '';
			const out = await searchByMeaning(data.pb, q, scope);
			if (!out.enabled) {
				toast(t('search.meaningUnavailable'));
				return;
			}
			meaning = { q, ids: out.results.map((h) => h.id) };
			if (!meaning.ids.length) toast(t('search.meaningNone'));
		} catch (e) {
			toast({ text: e instanceof SmartSearchError && e.kind === 'limit' ? t('search.meaningLimit') : t('search.meaningFailed'), tone: 'error' }, 5000);
		} finally {
			meaningBusy = false;
		}
	}

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
			{ id: 'all', name: t('common.allProjects'), count: items.length },
			...data.projects
				.filter((p) => !p.archived || p.id === project)
				.map((p) => ({ id: p.id, name: p.name, count: per.get(p.id) ?? 0 })),
			{ id: 'none', name: t('common.noProject'), count: per.get(null) ?? 0 }
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
	let panel = $state<ReturnType<typeof InspirationPanel>>();

	function select(id: string | null, opts: { focus?: boolean } = {}) {
		selectedId = id;
		focusNote = !!opts.focus;
		// The panel may now cover the card: pan it into view once the inset is known.
		if (id) void tick().then(() => board?.reveal(id));
	}

	/** A similar image was pressed in the panel: open it here, switching project or level if needed. */
	async function pickSimilar(id: string) {
		const it = items.find((i) => i.id === id);
		if (!it) return void goto(`/i/${id}`);
		const shown = project === 'all' || (project === 'none' ? it.project_id === null : it.project_id === project);
		if (!shown) {
			const to = it.project_id ?? 'none';
			highlight = null;
			await goto(`/map?project=${encodeURIComponent(to)}`, { replace: true, reset: false });
		}
		if (level && it.level !== level) level = '';
		await tick();
		select(id);
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
			toast({ text: t('map.signInToAdd'), tone: 'error' }, 5000);
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

	/** Ids of cards whose image is still uploading (shown faded; the panel waits for them). */
	let uploading = $state.raw<Set<string>>(new Set());
	const UPLOADS_AT_ONCE = 3;

	/** Show every image at once where it was added, under its final id, and upload in the background
	 *  (3 at a time). A failed upload takes its card away again and says why. */
	async function addFiles(files: File[], spot: Spot) {
		const userId = data.userId;
		if (!userId) {
			toast({ text: t('map.signInToAdd'), tone: 'error' }, 5000);
			return;
		}
		// A new image must be visible where it lands: clear what would hide or fade it.
		search = '';
		if (highlight && highlight !== spot.zone) highlight = null;
		const projectId = newProjectId;
		const tags = spot.zone ? [spot.zone] : [];
		const lvl = level || null;
		const cols = Math.ceil(Math.sqrt(files.length));
		const queue: { id: string; file: File }[] = [];
		const now = new Date().toISOString();
		files.forEach((file, i) => {
			try {
				checkImage(file, true);
			} catch (err) {
				const name = file.name && file.name !== 'image.png' ? `${file.name}: ` : '';
				toast({ text: name + errText(err, t('map.imageNotSaved')), tone: 'error' }, 8000);
				return;
			}
			const id = newId();
			const x = spot.x + (i % cols) * (size + CARD_GAP);
			const y = spot.y + Math.floor(i / cols) * (size * 0.9 + CARD_GAP);
			localUrls = { ...localUrls, [id]: URL.createObjectURL(file) };
			board?.place(id, x, y);
			const row: Inspiration = {
				id, project_id: projectId, image_path: '', source_url: null, source_title: null, image_url: null,
				crop: null, note: '', tags, level: lvl, regions: [], suggestion: null, colors: [], created_at: now, updated_at: now
			};
			pendingRows.set(id, row);
			items = [row, ...items];
			queue.push({ id, file });
		});
		if (!queue.length) return;
		uploading = new Set([...uploading, ...queue.map((q) => q.id)]);
		const first = queue[0].id;
		const busy = toast({ text: queue.length > 1 ? t('map.uploadingMany', { n: queue.length }) : t('map.uploadingOne'), tone: 'busy' }, 0);
		let added = 0;

		const upload = async ({ id, file }: { id: string; file: File }) => {
			try {
				const row = await createInspiration(data.pb, userId, file, { id, project_id: projectId, tags, level: lvl });
				// Keep edits made meanwhile on the board (e.g. a retag); take the server's file name.
				const cur = items.find((i) => i.id === id);
				const merged = cur ? { ...row, tags: cur.tags, project_id: cur.project_id, level: cur.level } : row;
				if (pendingRows.has(id)) pendingRows.set(id, merged);
				setItem(merged);
				added++;
				if (id === first && selectedId === null) select(id, { focus: true });
			} catch (err) {
				pendingRows.delete(id);
				items = items.filter((i) => i.id !== id);
				board?.forget(id);
				URL.revokeObjectURL(localUrls[id]);
				const { [id]: _, ...rest } = localUrls;
				localUrls = rest;
				const name = file.name && file.name !== 'image.png' ? `${file.name}: ` : '';
				toast({ text: name + errText(err, t('map.imageNotSaved')), tone: 'error' }, 8000);
			} finally {
				const next = new Set(uploading);
				next.delete(id);
				uploading = next;
				// The row stays in pendingRows until a reload contains it (the effect at the top drops it): a reload
				// that started before this upload ended must not drop the card.
			}
		};
		const work = [...queue];
		await Promise.all(
			Array.from({ length: Math.min(UPLOADS_AT_ONCE, work.length) }, async () => {
				for (let job = work.shift(); job; job = work.shift()) await upload(job);
			})
		);
		dismiss(busy);
		if (added > 1) toast(t('map.added', { n: added }));
		// Reload only when nothing else is uploading (pending rows survive a reload anyway).
		if (added && !uploading.size) void reloadData();
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
				toast(t('map.noClipboardImage'));
				return;
			}
			await addFiles(files, spot);
		} catch {
			toast(t('map.pressPaste', { mod }), 4000);
		}
	}

	// ------------------------------------------------------------ Organising

	type From = { x?: number; y?: number; fx?: number | null; fy?: number | null };

	async function rezone(item: Inspiration, tag: string, from: From) {
		if (uploading.has(item.id)) {
			board?.restore(item.id, from);
			toast(t('map.stillUploading'));
			return;
		}
		const prev = item.tags ?? [];
		const next = [tag, ...prev.filter((t) => t !== tag)];
		setItem({ ...item, tags: next });
		try {
			setItem(await updateInspiration(data.pb, item.id, { tags: next }));
			toast({ text: `+ #${tag}`, action: { label: t('map.undo'), run: () => void undoRezone(item.id, tag, prev, from) } }, 5000);
		} catch (err) {
			setItem(item);
			toast({ text: errText(err, t('map.tagNotSaved')), tone: 'error' }, 6000);
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
			setItem(await updateInspiration(data.pb, id, { tags }));
		} catch (err) {
			setItem(cur);
			toast({ text: errText(err, t('map.undoFailed')), tone: 'error' }, 6000);
		}
	}

	async function copyTo(id: string, projectId: string | null) {
		const userId = data.userId;
		if (!userId) return;
		try {
			await copyInspiration(data.pb, userId, id, projectId);
			onCopied(projectId ? (data.projects.find((p) => p.id === projectId)?.name ?? null) : null);
		} catch (err) {
			toast({ text: errText(err, t('map.copyFailed')), tone: 'error' }, 6000);
		}
	}

	function onCopied(projectName: string | null) {
		toast(projectName ? t('map.copiedTo', { name: projectName }) : t('map.copiedNoProject'));
		void reloadData();
	}

	function onDeleted(id: string) {
		items = items.filter((i) => i.id !== id);
		if (selectedId === id) select(null);
		board?.forget(id);
		toast(t('map.imageDeleted'));
	}

	/** Full-screen viewer: the expand button on a card or on the panel image, or Space on the selected one. */
	let viewId = $state<string | null>(null);
	/** The viewer steps only through the images of this tag; null = every image. */
	let viewTag = $state<string | null>(null);
	const viewList = $derived(viewerList(filtered, viewTag));
	const viewIndex = $derived(viewId ? viewList.findIndex((i) => i.id === viewId) : -1);
	const viewItem = $derived(viewIndex >= 0 ? viewList[viewIndex] : null);
	const viewTags = $derived(tagStats.map((s) => ({ ...s, color: colors.get(s.tag)?.dark })));
	// The shown image left the list (its tag removed, deleted, filtered out): show it among every
	// image when it still exists, else close the viewer so the map keys work again.
	$effect(() => {
		if (!viewId || viewIndex >= 0) return;
		if (viewTag !== null && filtered.some((i) => i.id === viewId)) viewTag = null;
		else viewId = null;
	});
	function viewStep(dir: -1 | 1) {
		const next = viewList[viewIndex + dir];
		if (next) viewId = next.id;
	}
	/** Open the viewer on an image, limited to its zone tag (its first tag). */
	function openView(id: string | null) {
		viewTag = (id && items.find((i) => i.id === id)?.tags?.[0]) || null;
		viewId = id;
	}
	/** Another tag chip: stay on the image when it has the tag, else go to the tag's first image. */
	function pickViewTag(tag: string | null) {
		const list = viewerList(filtered, tag);
		if (!list.length) return;
		viewTag = tag;
		if (!list.some((i) => i.id === viewId)) viewId = list[0].id;
	}

	/** The card shows the new crop at once; if the server refuses, the old one comes back. */
	/** Crop saves of one row run one after another, so the server ends with the last crop chosen. */
	const cropQueue = new Map<string, Promise<void>>();
	/** Newest crop chosen per row: only its answer (or failure) updates the card. */
	const cropSeq = new Map<string, number>();
	/** Last crop the server confirmed per row, for a rollback. */
	const cropSaved = new Map<string, Crop | null>();

	function saveCrop(item: Inspiration, crop: Crop | null): Promise<void> {
		const seq = (cropSeq.get(item.id) ?? 0) + 1;
		cropSeq.set(item.id, seq);
		if (!cropSaved.has(item.id)) cropSaved.set(item.id, item.crop);
		setItem({ ...item, crop });
		const run = async () => {
			if (cropSeq.get(item.id) !== seq) return; // a newer crop is queued: skip this one
			try {
				const row = await updateInspiration(data.pb, item.id, { crop });
				cropSaved.set(item.id, row.crop);
				if (cropSeq.get(item.id) !== seq) return;
				const cur = items.find((i) => i.id === item.id);
				// Keep the server's updated_at: an older live echo (e.g. an autosave) then cannot undo the crop.
				if (cur) setItem({ ...cur, crop: row.crop, updated_at: row.updated_at });
				toast(crop ? t('map.cropSaved') : t('map.cropRemoved'));
			} catch (err) {
				if (cropSeq.get(item.id) !== seq) return;
				const cur = items.find((i) => i.id === item.id);
				if (cur) setItem({ ...cur, crop: cropSaved.get(item.id) ?? null });
				toast({ text: errText(err, t('map.cropNotSaved')), tone: 'error' }, 6000);
			}
		};
		const next = (cropQueue.get(item.id) ?? Promise.resolve()).then(run);
		cropQueue.set(item.id, next);
		return next;
	}

	/** An autosave of the panel: take only the fields the panel edits (a crop saved meanwhile stays). */
	function onPanelSaved(row: Inspiration) {
		const cur = items.find((i) => i.id === row.id);
		if (!cur) return;
		const { note, tags, level, regions, project_id, suggestion, updated_at } = row;
		setItem({ ...cur, note, tags, level, regions, project_id, suggestion, updated_at });
	}

	/** The card goes at once; if the server refuses, it comes back. */
	async function remove(id: string) {
		const row = items.find((i) => i.id === id);
		if (!row) return;
		items = items.filter((i) => i.id !== id);
		if (selectedId === id) select(null);
		try {
			await deleteInspiration(data.pb, id);
			board?.forget(id);
			toast(t('map.imageDeleted'));
		} catch (err) {
			if (!items.some((i) => i.id === id)) items = [row, ...items];
			toast({ text: errText(err, t('map.deleteFailed')), tone: 'error' }, 6000);
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
					{ label: t('map.menuNewHere'), icon: 'image', kbd: 'N', onselect: act(() => pickFiles(spot)) },
					{ label: t('map.menuPasteHere'), icon: 'paste', kbd: `${mod}V`, onselect: act(() => void pasteAt(spot)) },
					{ label: t('map.menuFit'), icon: 'fit', kbd: 'F', onselect: act(() => board?.fit()) }
				]
			};
		}
		const id = m.id;
		const back = () => (menu = { ...m, view: 'card' });
		if (m.view === 'copy') {
			return {
				title: t('map.menuCopyTitle'),
				onback: back,
				items: [
					...data.projects
						.filter((p) => !p.archived)
						.map((p) => ({ label: p.name, onselect: act(() => void copyTo(id, p.id)) })),
					{ label: t('common.noProject'), onselect: act(() => void copyTo(id, null)) }
				]
			};
		}
		if (m.view === 'delete') {
			return {
				title: t('map.menuDeleteTitle'),
				onback: back,
				items: [
					{ label: t('map.menuDeleteForever'), icon: 'trash', danger: true, onselect: act(() => void remove(id)) },
					{ label: t('common.cancel'), onselect: () => (menu = null) }
				]
			};
		}
		return {
			items: [
				{ label: t('map.menuOpen'), icon: 'open', onselect: act(() => select(id)) },
				{ label: t('map.menuCopyTo'), icon: 'copy', more: true, onselect: () => (menu = { ...m, view: 'copy' }) },
				{ label: t('common.delete'), icon: 'trash', danger: true, more: true, onselect: () => (menu = { ...m, view: 'delete' }) }
			]
		};
	});

	// -------------------------------------------------------------- Keyboard

	function onKey(e: KeyboardEvent) {
		if (viewId) return; // the full-screen viewer handles its own keys
		if (e.key === 'Escape') {
			// First Esc leaves the field (e.g. the note focused after adding); the next one closes.
			if (isTyping(e.target)) {
				if (!e.defaultPrevented && e.target instanceof HTMLElement && !e.target.closest('.menu, .pop')) e.target.blur();
				return;
			}
			if (menu) menu = null;
			else if (switcherOpen) switcherOpen = false;
			else if (filtersOpen) filtersOpen = false;
			else if (selectedId) void (panel ? panel.close() : select(null));
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
		else if (e.code === 'Space' && selected && !uploading.has(selected.id)) openView(selected.id);
		else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && selected && t?.getAttribute('type') !== 'range') {
			step(e.key === 'ArrowLeft' ? -1 : 1);
		} else return;
		e.preventDefault();
	}

	// ------------------------------------------------------------ Live (SSE)

	/** Fold a change made elsewhere (another tab or device) into the board. Own saves come back too;
	 *  applyEvent ignores those unless they are newer than what is shown. */
	async function onLive(e: RecordSubscription<RecordModel>) {
		// Apply first, then fetch a thumbnail: a delete that arrives meanwhile must not be undone.
		const next = applyEvent(items, e);
		if (next === items) return;
		items = next;
		// The cached rows (and tags) are now old: the next page load asks the server.
		forceNextLoad();
		if (e.action === 'delete' && selectedId === e.record.id) select(null);
		if (e.action === 'create' && !data.urls[e.record.image] && !liveUrls[e.record.image]) {
			try {
				const urls = await imageUrls(data.pb, [toInspiration(e.record)]);
				liveUrls = { ...liveUrls, ...urls }; // read liveUrls after the await: parallel creates
			} catch {
				/* no thumbnail until the next reload */
			}
		}
	}

	let projectsTimer: ReturnType<typeof setTimeout> | undefined;
	onMount(() => {
		let off: (() => Promise<void>) | null = null;
		let gone = false;
		subscribeLive(data.pb, {
			inspiration: (e) => void onLive(e),
			// Projects change rarely: reload the data (names, counts) once a burst settles.
			project: () => {
				clearTimeout(projectsTimer);
				projectsTimer = setTimeout(() => void reloadData(), 300);
			}
		})
			.then((u) => {
				if (gone) void u();
				else off = u;
			})
			.catch(() => {
				/* live updates are a bonus: the board works without them */
			});
		return () => {
			gone = true;
			clearTimeout(projectsTimer);
			void off?.();
		};
	});

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
	const hint = $derived(filtered.length < 3 && !boardEmpty ? t('map.hintPaste', { mod }) : null);
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
		{byMeaning}
		{meaningBusy}
		onmeaningtoggle={() => void toggleMeaning()}
		onmeaning={() => void runMeaning()}
	>
		{#snippet actions()}
			{#if project !== 'all' && project !== 'none'}
				{#key project}<ShareMenu pb={data.pb} projectId={project} />{/key}
			{/if}
		{/snippet}
	</BoardHeader>

	{#if tagStats.length}
		<div class="tagrow">
			<TagChips tags={tagStats} {colors} {highlight} ontoggle={toggleTag} />
		</div>
	{/if}

	<div class="body">
		{#if data.error}
			<p class="msg">{t('common.loadError', { error: data.error })}</p>
		{:else}
			<Board
				bind:this={board}
				pb={data.pb}
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
				{uploading}
				onselect={(id) => (uploading.has(id) ? toast(t('map.stillUploading')) : select(id))}
				onexpand={(id) => (uploading.has(id) ? toast(t('map.stillUploading')) : openView(id))}
				onbackground={() => {
					if (selectedId) select(null);
				}}
				oncontext={onContext}
				onfiles={(files, spot) => void addFiles(files, spot)}
				onpick={(spot) => pickFiles(spot)}
				onrezone={(item, tag, from) => void rezone(item, tag, from)}
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
						<h1>{project === 'all' ? t('map.emptyBoard') : t('map.emptyProject', { name: projectName })}</h1>
						<p>{@html t('map.emptyHint', { kbd: `<kbd class="kbd">${mod}V</kbd>` })}</p>
						<div class="emptyacts">
							<button type="button" class="btn primary" onclick={() => pickFiles(null)}>
								<Icon name="plus" size={15} /> {t('map.addImage')} <kbd class="kbd onacc">N</kbd>
							</button>
							<button
								type="button"
								class="btn"
								onclick={() => void pasteAt(board?.centreSpot() ?? { x: 0, y: 0, zone: null })}
							>
								<Icon name="paste" size={15} /> {t('map.paste')}
							</button>
						</div>
					</div>
				</div>
			{:else if filtered.length === 0}
				<div class="empty" style:--inset="{rightInset}px">
					<div class="emptybox small">
						<p>{t('map.noImageLevel')}</p>
						<button type="button" class="btn" onclick={() => (level = '')}>{t('home.allLevels')}</button>
					</div>
				</div>
			{:else if matches && matches.size === 0}
				<p class="nomatch" style:--inset="{rightInset}px">{t('map.noMatch', { query: search.trim() })}</p>
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
					bind:this={panel}
					pb={data.pb}
					userId={data.userId}
					item={selected}
					imageUrl={urlOf(selected)}
					projects={data.projects}
					suggestions={data.tags}
					{focusNote}
					onsaved={onPanelSaved}
					oncopied={onCopied}
					ondeleted={onDeleted}
					onclose={() => select(null)}
					onprev={selIndex > 0 ? () => step(-1) : undefined}
					onnext={selIndex >= 0 && selIndex < filtered.length - 1 ? () => step(1) : undefined}
					onexpand={() => openView(selected?.id ?? null)}
					onpick={pickSimilar}
				/>
			</div>
		{/if}

		{#if viewItem}
			<ImageViewer
				src={urlOf(viewItem)}
				alt={viewItem.note || t('item.alt')}
				sourceUrl={viewItem.source_url}
				crop={viewItem.crop}
				regions={viewItem.regions}
				tags={viewTags}
				tag={viewTag}
				position={{ n: viewIndex + 1, of: viewList.length }}
				neighbors={neighborUrls(viewList, viewIndex, urlOf)}
				ontag={pickViewTag}
				oncrop={(c) => void saveCrop(viewItem, c)}
				onedit={() => {
					const id = viewItem.id;
					viewId = null;
					select(id);
				}}
				onclose={() => (viewId = null)}
				onprev={viewIndex > 0 ? () => viewStep(-1) : undefined}
				onnext={viewIndex < viewList.length - 1 ? () => viewStep(1) : undefined}
			/>
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
