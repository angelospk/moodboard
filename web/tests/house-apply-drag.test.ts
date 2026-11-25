import { describe, expect, it } from 'vitest';
import { applyDrag } from '../src/lib/house/gesture';
import { handlesFor } from '../src/lib/house/handles';
import { newItem } from '../src/lib/house/catalog';
import { emptyModel, type HouseModel, type Item } from '../src/lib/house/model';

function modelWith(rotation: number): { model: HouseModel; item: Item } {
	const item = newItem('table', [4, 3], rotation);
	return { model: { ...emptyModel(), elements: [item] }, item };
}

const rotationOf = (m: HouseModel) => (m.elements[0] as Item).rotation;

describe('applyDrag: rotate knob', () => {
	it('keeps the rotation when the knob is released where it started', () => {
		for (const r of [0, 45, 90, 180, 270]) {
			const { model, item } = modelWith(r);
			const knob = handlesFor(item).find((h) => h.kind === 'rotate')!;
			expect(rotationOf(applyDrag(model, knob, knob.at, knob.at)!)).toBe(r);
		}
	});

	it('turns the item to the angle the knob is dragged to', () => {
		const { model, item } = modelWith(0);
		const knob = handlesFor(item).find((h) => h.kind === 'rotate')!;
		// A knob of an item turned by 90 deg sits on the -x side of the centre.
		const to: [number, number] = [item.center[0] - (item.length / 2 + 0.5), item.center[1]];
		expect(rotationOf(applyDrag(model, knob, knob.at, to)!)).toBe(90);
		// 180 deg: below the centre.
		const down: [number, number] = [item.center[0], item.center[1] - (item.length / 2 + 0.5)];
		expect(rotationOf(applyDrag(model, knob, knob.at, down)!)).toBe(180);
	});

	it('moves the knob handle to the dragged position (round trip)', () => {
		const { model, item } = modelWith(0);
		const knob = handlesFor(item).find((h) => h.kind === 'rotate')!;
		const to: [number, number] = [item.center[0] + 2, item.center[1]]; // right of the centre = 270 deg
		const next = applyDrag(model, knob, knob.at, to)!;
		const again = handlesFor(next.elements[0]).find((h) => h.kind === 'rotate')!;
		expect(Math.atan2(again.at[1] - item.center[1], again.at[0] - item.center[0])).toBeCloseTo(0, 5);
	});
});
