// Freeform regions: a stroke drawn on an image becomes a closed polygon (points are fractions 0..1 of
// the image). The region keeps x/y/w/h as the polygon's bounding box, so every place that only knows
// boxes (map cards, the public page, MCP) keeps working.
import type { Region } from './types.js';

export type Pt = [number, number];

const MAX_POINTS = 120;
/** Smaller than this (fraction of the image) on either side is a tap, not a shape. */
const MIN_SIZE = 0.02;

export function bboxOf(pts: Pt[]): { x: number; y: number; w: number; h: number } {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const [x, y] of pts) {
		x0 = Math.min(x0, x);
		y0 = Math.min(y0, y);
		x1 = Math.max(x1, x);
		y1 = Math.max(y1, y);
	}
	const r = (v: number) => Math.round(v * 10000) / 10000;
	return { x: r(x0), y: r(y0), w: r(x1 - x0), h: r(y1 - y0) };
}

function dist(p: Pt, a: Pt, b: Pt): number {
	const dx = b[0] - a[0], dy = b[1] - a[1];
	const len = Math.hypot(dx, dy);
	if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
	return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
}

/** Ramer–Douglas–Peucker: fewer points, same shape within tol. */
export function simplify(pts: Pt[], tol: number): Pt[] {
	if (pts.length < 3) return pts;
	let max = 0, at = 0;
	for (let i = 1; i < pts.length - 1; i++) {
		const d = dist(pts[i], pts[0], pts[pts.length - 1]);
		if (d > max) (max = d), (at = i);
	}
	if (max <= tol) return [pts[0], pts[pts.length - 1]];
	return [...simplify(pts.slice(0, at + 1), tol).slice(0, -1), ...simplify(pts.slice(at), tol)];
}

/** A finished stroke -> a region, or null for a tap or a tiny scribble. */
export function regionFromStroke(stroke: Pt[]): Region | null {
	const clamped = stroke.map(([x, y]): Pt => [Math.min(Math.max(x, 0), 1), Math.min(Math.max(y, 0), 1)]);
	let tol = 0.004;
	let pts = simplify(clamped, tol);
	while (pts.length > MAX_POINTS) pts = simplify(clamped, (tol *= 1.5));
	if (pts.length < 3) return null;
	const rounded = pts.map(([x, y]): Pt => [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000]);
	const box = bboxOf(rounded);
	if (box.w < MIN_SIZE || box.h < MIN_SIZE) return null;
	return { ...box, note: '', rating: null, points: rounded };
}

/** SVG `points` attribute for a viewBox of 0 0 1 1. */
export function svgPoints(pts: Pt[]): string {
	return pts.map(([x, y]) => `${x},${y}`).join(' ');
}
