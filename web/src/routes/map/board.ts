// Pure helpers for the project board: zone colours, zone anchors and the two custom forces.
import type { SimulationNodeDatum } from 'd3-force';
import type { Inspiration } from '#lib/types.js';

export interface CardNode extends SimulationNodeDatum {
	/** 'i:<inspiration id>' (the saved-position key). */
	id: string;
	item: Inspiration;
	/** The zone of a card is its first tag; null floats outside zones. */
	zone: string | null;
	/** Measured card box, world px. */
	w: number;
	h: number;
}

/** Zone rect padding around its cards; the top leaves room for the label. */
export const ZONE_PAD = 28;
export const ZONE_PAD_TOP = 44;
/** Free space between two zone rects. */
export const ZONE_GAP = 32;
/** Free space between two cards of the same zone. */
export const CARD_GAP = 16;

/** DESIGN.md zone palette (light). Dark mode: same hue, +18% lightness. */
export const PALETTE = ['#b4532a', '#6b7a3a', '#4e6a85', '#b08a2e', '#7a4e6e', '#5f8a74', '#a0674b', '#7d7a72'];

export interface ZoneColor {
	light: string;
	dark: string;
}

function hash(s: string) {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/** Same hue, `amount` percentage points lighter. */
export function lighten(hex: string, amount = 18): string {
	const n = parseInt(hex.slice(1), 16);
	const r = ((n >> 16) & 255) / 255;
	const g = ((n >> 8) & 255) / 255;
	const b = (n & 255) / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	let h = 0;
	let s = 0;
	const l = (max + min) / 2;
	if (max !== min) {
		const d = max - min;
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
		h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
		h /= 6;
	}
	const l2 = Math.min(1, l + amount / 100);
	const q = l2 < 0.5 ? l2 * (1 + s) : l2 + s - l2 * s;
	const p = 2 * l2 - q;
	const ch = (t: number) => {
		if (t < 0) t += 1;
		if (t > 1) t -= 1;
		const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
		return Math.round(v * 255)
			.toString(16)
			.padStart(2, '0');
	};
	return s === 0 ? `#${ch(l2)}${ch(l2)}${ch(l2)}` : `#${ch(h + 1 / 3)}${ch(h)}${ch(h - 1 / 3)}`;
}

/**
 * One colour per tag. Each tag prefers the hue its hash picks, so it keeps its colour across maps;
 * when two tags in view want the same hue, the later one (by name) takes the next free hue.
 */
export function zoneColors(tags: Iterable<string>): Map<string, ZoneColor> {
	const out = new Map<string, ZoneColor>();
	const used = new Set<number>();
	for (const t of [...new Set(tags)].sort()) {
		let i = hash(t) % PALETTE.length;
		if (used.size < PALETTE.length) {
			while (used.has(i)) i = (i + 1) % PALETTE.length;
		}
		used.add(i);
		out.set(t, { light: PALETTE[i], dark: lighten(PALETTE[i]) });
	}
	return out;
}

export interface Group {
	key: string;
	nodes: CardNode[];
}

/**
 * A target point per card. Inside its group (zone, or the untagged group) each card gets a slot in
 * masonry columns (pinned cards keep their place and get none); the groups are then laid out in
 * shelves around the origin, in rows as wide as the screen's shape asks for. When at least half of a
 * group is pinned, its free cards stack just below the pinned ones instead.
 */
export function layoutTargets(groups: Group[], aspect = 1.6): Map<string, { x: number; y: number }> {
	const a = Math.min(2.2, Math.max(0.4, aspect));
	const shape = Math.sqrt(Math.min(1.6, Math.max(0.8, a)));
	const boxes = groups.map((g) => {
		// Pinned cards stay where the user put them; only free cards get slots.
		const free = g.nodes.filter((n) => n.fx == null || n.fy == null);
		let area = 0;
		let maxW = 0;
		for (const n of free) {
			area += (n.w + CARD_GAP) * (n.h + CARD_GAP);
			maxW = Math.max(maxW, n.w);
		}
		// Masonry: cards share one width, so each goes to the shortest column.
		const colW = maxW + CARD_GAP;
		const cols = Math.max(1, Math.min(free.length, Math.round((Math.sqrt(area) * shape) / colW)));
		const heights = new Array<number>(cols).fill(0);
		const slots = new Map<string, { x: number; y: number }>();
		for (const n of free) {
			let c = 0;
			for (let i = 1; i < cols; i++) if (heights[i] < heights[c] - 1) c = i;
			slots.set(n.id, { x: c * colW + maxW / 2, y: heights[c] + n.h / 2 });
			heights[c] += n.h + CARD_GAP;
		}
		const innerW = cols * colW - CARD_GAP;
		const innerH = Math.max(0, Math.max(...heights) - CARD_GAP);
		return { g, free, slots, w: innerW + ZONE_PAD * 2, h: innerH + ZONE_PAD + ZONE_PAD_TOP };
	}).filter((b) => b.free.length > 0);

	const total = boxes.reduce((s, b) => s + (b.w + ZONE_GAP) * (b.h + ZONE_GAP), 0);
	const rowMax = Math.max(Math.sqrt(total * a) * 1.05, ...boxes.map((b) => b.w));
	const placed: { x: number; y: number }[] = [];
	const rows: { from: number; to: number; width: number }[] = [];
	let x = 0;
	let y = 0;
	let rowH = 0;
	let rowStart = 0;
	for (const b of boxes) {
		if (x > 0 && x + b.w > rowMax) {
			rows.push({ from: rowStart, to: placed.length, width: x - ZONE_GAP });
			rowStart = placed.length;
			x = 0;
			y += rowH + ZONE_GAP;
			rowH = 0;
		}
		placed.push({ x, y });
		x += b.w + ZONE_GAP;
		rowH = Math.max(rowH, b.h);
	}
	rows.push({ from: rowStart, to: placed.length, width: x - ZONE_GAP });
	const height = y + rowH;
	const width = Math.max(0, ...rows.map((r) => r.width));
	for (const r of rows) {
		// Centre each shelf, then the whole block on the origin.
		const shift = (width - r.width) / 2 - width / 2;
		for (let i = r.from; i < r.to; i++) {
			placed[i].x += shift;
			placed[i].y -= height / 2;
		}
	}

	const out = new Map<string, { x: number; y: number }>();
	boxes.forEach((b, i) => {
		let bx = placed[i].x;
		let by = placed[i].y;
		const pinned = b.g.nodes.filter((n) => n.fx != null && n.fy != null);
		// Mostly arranged by hand: the free cards stack just below that arrangement.
		if (pinned.length && pinned.length * 2 >= b.g.nodes.length) {
			bx = Math.min(...pinned.map((n) => (n.fx as number) - n.w / 2)) - ZONE_PAD;
			by = Math.max(...pinned.map((n) => (n.fy as number) + n.h / 2)) + CARD_GAP - ZONE_PAD_TOP;
		}
		for (const [id, s] of b.slots) out.set(id, { x: bx + ZONE_PAD + s.x, y: by + ZONE_PAD_TOP + s.y });
	});
	return out;
}

export const groupKey = (zone: string | null) => (zone === null ? '\u0000none' : zone);

/**
 * Pull each free card toward its slot. A damped spring, not scaled by alpha: the cards reach their
 * slots before the simulation cools, instead of freezing halfway.
 */
export function anchorForce(anchorOf: (n: CardNode) => { x: number; y: number } | undefined, strength = 0.07) {
	let nodes: CardNode[] = [];
	const force = () => {
		for (const n of nodes) {
			if (n.fx != null) continue;
			const a = anchorOf(n);
			if (!a) continue;
			n.vx = (n.vx ?? 0) + (a.x - (n.x ?? 0)) * strength;
			n.vy = (n.vy ?? 0) + (a.y - (n.y ?? 0)) * strength;
		}
	};
	force.initialize = (ns: CardNode[]) => {
		nodes = ns;
	};
	return force;
}

/** Free space two cards keep between them: small inside a zone, room for two zone paddings across. */
export function gapBetween(a: CardNode, b: CardNode): { x: number; y: number } {
	if (a.zone === b.zone) return { x: CARD_GAP, y: CARD_GAP };
	if (a.zone !== null && b.zone !== null) {
		return { x: ZONE_PAD * 2 + ZONE_GAP, y: ZONE_PAD + ZONE_PAD_TOP + ZONE_GAP };
	}
	return { x: ZONE_PAD + CARD_GAP, y: ZONE_PAD_TOP + CARD_GAP };
}

/**
 * Axis-aligned box collision with a sweep along x. A pinned card does not move; the card being
 * dragged (`skip`) takes no part, so it can pass over other zones. Two free cards only collide as
 * the layout settles (their slots never overlap): while it is hot they pass through each other on
 * the way to their slots instead of getting stuck behind a neighbour zone.
 */
export function rectCollide(skip: () => string | null, strength = 0.6) {
	let nodes: CardNode[] = [];
	const reach = ZONE_PAD * 2 + ZONE_GAP;
	const force = (alpha: number) => {
		const freeK = alpha >= 0.03 ? 0 : 1 - alpha / 0.03;
		const s = skip();
		const list = nodes.filter((n) => n.id !== s);
		const px = (n: CardNode) => (n.x ?? 0) + (n.vx ?? 0);
		const py = (n: CardNode) => (n.y ?? 0) + (n.vy ?? 0);
		list.sort((a, b) => px(a) - a.w / 2 - (px(b) - b.w / 2));
		for (let i = 0; i < list.length; i++) {
			const a = list[i];
			const aRight = px(a) + a.w / 2 + reach;
			for (let j = i + 1; j < list.length; j++) {
				const b = list[j];
				if (px(b) - b.w / 2 > aRight) break;
				const aFixed = a.fx != null;
				const bFixed = b.fx != null;
				if (aFixed && bFixed) continue;
				const gap = gapBetween(a, b);
				let dx = px(b) - px(a);
				let dy = py(b) - py(a);
				const ox = (a.w + b.w) / 2 + gap.x - Math.abs(dx);
				const oy = (a.h + b.h) / 2 + gap.y - Math.abs(dy);
				if (ox <= 0 || oy <= 0) continue;
				if (dx === 0 && dy === 0) {
					dx = (i % 2 ? 1 : -1) * 0.5;
					dy = 0.5;
				}
				const k = aFixed || bFixed ? strength : strength * freeK;
				if (k === 0) continue;
				const wa = aFixed ? 0 : bFixed ? 1 : 0.5;
				const wb = 1 - wa;
				if (ox < oy) {
					const p = ox * k * Math.sign(dx || 1);
					a.vx = (a.vx ?? 0) - p * wa;
					b.vx = (b.vx ?? 0) + p * wb;
				} else {
					const p = oy * k * Math.sign(dy || 1);
					a.vy = (a.vy ?? 0) - p * wa;
					b.vy = (b.vy ?? 0) + p * wb;
				}
			}
		}
	};
	force.initialize = (ns: CardNode[]) => {
		nodes = ns;
	};
	return force;
}

/** Bounding box of cards, grown by the zone padding. */
export function zoneBox(nodes: CardNode[], skipId: string | null = null) {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const n of nodes) {
		if (n.id === skipId) continue;
		const x = n.x ?? 0;
		const y = n.y ?? 0;
		minX = Math.min(minX, x - n.w / 2);
		maxX = Math.max(maxX, x + n.w / 2);
		minY = Math.min(minY, y - n.h / 2);
		maxY = Math.max(maxY, y + n.h / 2);
	}
	if (!Number.isFinite(minX)) return null;
	return {
		x: minX - ZONE_PAD,
		y: minY - ZONE_PAD_TOP,
		w: maxX - minX + ZONE_PAD * 2,
		h: maxY - minY + ZONE_PAD + ZONE_PAD_TOP
	};
}

/** Lowercase text of everything a search can match on one inspiration. */
export function searchText(i: Inspiration): string {
	return [i.note, i.source_title ?? '', ...(i.tags ?? []), ...(i.regions ?? []).map((r) => r.note)]
		.join(' ')
		.toLowerCase();
}

/** True when the key event comes from a place where the user types. */
export function isTyping(target: EventTarget | null): boolean {
	const el = target instanceof Element ? target : null;
	if (!el) return false;
	if (el.closest('textarea, select, [contenteditable=""], [contenteditable="true"]')) return true;
	const input = el.closest('input');
	if (!input) return false;
	return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'file', 'color'].includes(input.type);
}
