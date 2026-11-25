// Browser check of the 3D house editor with real CDP input: mouse, touch (one and two fingers) and pen.
// Not part of CI. Needs a running backend + dev server, a user angelos-test@example.com / password123,
// and puppeteer-core outside the repo:  mkdir /tmp/e2e && cd /tmp/e2e && bun add puppeteer-core
// Run (ESM resolves imports next to the script):  cp web/scripts/house-e2e.mjs /tmp/e2e/ && node /tmp/e2e/house-e2e.mjs <appUrl> <pbUrl> <screenshotDir>
import puppeteer from 'puppeteer-core';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const [APP, PB, OUT, WEB] = process.argv.slice(2);
const DL = '/tmp/house3d/downloads';
rmSync(DL, { recursive: true, force: true });
mkdirSync(DL, { recursive: true });
mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log('•', ...a);
const ok = (cond, msg) => {
	if (!cond) throw new Error('FAIL: ' + msg);
	console.log('✓', msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
	executablePath: '/usr/bin/google-chrome',
	headless: 'new',
	args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--lang=el-GR']
});

async function signedInPage(viewport) {
	const page = await browser.newPage();
	await page.setViewport(viewport);
	page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
	page.on('console', (m) => m.type() === 'error' && console.log('CONSOLE', m.text()));
	await page.goto(APP + '/login', { waitUntil: 'networkidle0' });
	await page.evaluate(async () => {
		const { pb } = await import('/src/lib/pb.ts');
		await pb.collection('users').authWithPassword('angelos-test@example.com', 'password123');
		localStorage.setItem('moodboard:lang', 'el');
	});
	return page;
}

const model = (page) => page.evaluate(() => window.__house.model());
/** Screen position of a plan point [x, y] at height z. */
const screen = (page, x, y, z = 0) =>
	page.evaluate(
		(x, y, z) => {
			const vp = window.__house.vp;
			const v = vp.camera.position.clone().set(x, z, -y).project(vp.camera);
			const r = vp.renderer.domElement.getBoundingClientRect();
			return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
		},
		x,
		y,
		z
	);
const clickText = async (page, text, sel = 'button') => {
	const els = await page.$$(sel);
	for (const el of els) {
		const t = await el.evaluate((e) => e.textContent.trim());
		if (t === text || t.includes(text)) return el.click();
	}
	throw new Error('no button ' + text);
};
const wait = (page) => page.waitForFunction(() => !!window.__house, { timeout: 30000 });

// ------------------------------------------------------------------ Desktop: mouse
const desk = await signedInPage({ width: 1280, height: 800 });
const projectId = await desk.evaluate(async () => {
	const { pb } = await import('/src/lib/pb.ts');
	const { createProject } = await import('/src/lib/inspirations.ts');
	return (await createProject(pb, pb.authStore.record.id, 'Κατοικία Σύρος ' + Date.now().toString(36))).id;
});
await desk.goto(`${APP}/house?project=${projectId}`, { waitUntil: 'networkidle0' });
await wait(desk);
await desk.screenshot({ path: join(OUT, 'house-empty.png') });
await clickText(desk, 'Κάτοψη');
await sleep(300);

// Walls: a closed 8 × 6 m loop, mouse clicks; the last click on the first corner closes it.
await desk.evaluate(() => (window.__canvas = document.querySelector('.vp canvas')));
const topY = (await desk.evaluate(() => window.__house.vp.camera.position.y));
await clickText(desk, 'Τοίχος');
for (const [x, y] of [[0, 0], [8, 0], [8, 6], [0, 6], [0, 0]]) {
	const p = await screen(desk, x, y);
	await desk.mouse.move(p.x, p.y, { steps: 4 });
	await desk.mouse.click(p.x, p.y);
	await sleep(120);
}
let m = await model(desk);
ok(m.elements.length === 1 && m.elements[0].type === 'wall', 'one wall drawn with the mouse');
ok(JSON.stringify(m.elements[0].points) === '[[0,0],[8,0],[8,6],[0,6],[0,0]]', 'wall snapped to the grid and closed: ' + JSON.stringify(m.elements[0].points));
const wallId = m.elements[0].id;
ok(await desk.evaluate(() => window.__canvas === document.querySelector('.vp canvas') && window.__canvas.isConnected), 'edits keep the same renderer (canvas not rebuilt)');
ok(Math.abs((await desk.evaluate(() => window.__house.vp.camera.position.y)) - topY) < 1e-6, 'edits keep the plan camera');

// Window on the south wall, door on the east wall (click on the wall top in plan view).
await clickText(desk, 'Παράθυρο');
let p = await screen(desk, 4, 0, 3);
await desk.mouse.move(p.x, p.y, { steps: 3 });
await desk.mouse.click(p.x, p.y);
await sleep(150);
await clickText(desk, 'Πόρτα');
p = await screen(desk, 8, 3, 3);
await desk.mouse.move(p.x, p.y, { steps: 3 });
await desk.mouse.click(p.x, p.y);
await sleep(150);
m = await model(desk);
const win = m.elements.find((e) => e.type === 'window');
const door = m.elements.find((e) => e.type === 'door');
ok(win && win.host === wallId && win.segment === 0 && Math.abs(win.offset - 4) < 0.11, 'window on the south wall at 4 m: ' + JSON.stringify(win));
ok(door && door.host === wallId && door.segment === 1 && Math.abs(door.offset - 3) < 0.11, 'door on the east wall at 3 m: ' + JSON.stringify(door));

// Floor under the walls.
await clickText(desk, 'Δάπεδο');
await clickText(desk, 'Δάπεδο κάτω από τους τοίχους');
m = await model(desk);
ok(m.elements.some((e) => e.type === 'slab'), 'floor under the walls');

// Paint: pick brick and tap the wall; then terracotta for the floor via the inspector.
await clickText(desk, 'Βαφή');
await clickText(desk, 'Τούβλο', '.palette button');
p = await screen(desk, 2, 0, 3);
await desk.mouse.click(p.x, p.y);
await sleep(150);
m = await model(desk);
ok(m.elements.find((e) => e.id === wallId).material === 'brick', 'wall painted brick');

// Pool by dragging a rectangle (frame the house first: the plan camera stays where it was).
await desk.keyboard.press('Escape'); // close the floor's inspector
await desk.click('button[aria-label="Κεντράρισμα"]');
await sleep(200);
await clickText(desk, 'Πισίνα');
const a = await screen(desk, 10, 0);
const b = await screen(desk, 13, 6);
await desk.mouse.move(a.x, a.y);
await desk.mouse.down();
await desk.mouse.move(b.x, b.y, { steps: 8 });
await desk.mouse.up();
await sleep(150);
m = await model(desk);
const pool = m.elements.find((e) => e.type === 'pool');
ok(pool && pool.width === 3 && pool.length === 6, 'pool dragged 3 × 6 m: ' + JSON.stringify(pool));

// 3D view, select the wall → inspector.
await clickText(desk, '3D');
await clickText(desk, 'Επιλογή');
await sleep(300);
p = await screen(desk, 0, 3, 1.5);
await desk.mouse.click(p.x, p.y);
await sleep(300);
ok(await desk.$('.inspector'), 'tap on a wall opens the inspector');
await desk.screenshot({ path: join(OUT, 'house-desktop.png') });

// Autosave reached the server.
await desk.waitForFunction(() => document.querySelector('.status')?.textContent.includes('Αποθηκεύτηκε'), { timeout: 10000 });
ok(true, 'draft autosaved');

// Versions: save v1, add a volume, save v2, open v1.
await desk.keyboard.press('Escape');
await clickText(desk, 'Εκδόσεις');
await desk.type('.keep input', 'Πρώτη ιδέα');
await clickText(desk, 'Αποθήκευση έκδοσης');
await desk.waitForFunction(() => document.querySelectorAll('.vlist li').length === 1);
await desk.keyboard.press('Escape');
await clickText(desk, 'Κάτοψη');
await clickText(desk, 'Όγκος');
p = await screen(desk, 4, 3);
await desk.mouse.click(p.x, p.y);
await sleep(150);
m = await model(desk);
ok(m.elements.some((e) => e.type === 'box'), 'volume added after version 1');
await clickText(desk, 'Εκδόσεις');
await desk.type('.keep input', 'Με όγκο');
await clickText(desk, 'Αποθήκευση έκδοσης');
await desk.waitForFunction(() => document.querySelectorAll('.vlist li').length === 2);
await desk.screenshot({ path: join(OUT, 'house-versions.png') });
const names = await desk.$$eval('.vlist b', (els) => els.map((e) => e.textContent));
ok(names.join('|') === 'Με όγκο|Πρώτη ιδέα', 'two versions listed newest first');
const items = await desk.$$('.vlist li');
await (await items[1].$('button')).click();
await sleep(100);
await (await items[1].$('button')).click(); // confirm
await sleep(500);
m = await model(desk);
ok(!m.elements.some((e) => e.type === 'box') && m.elements.some((e) => e.type === 'pool'), 'opened version 1 (no volume, pool kept)');

// Query-only navigation A → B with an edit still waiting for its save: B stays empty, A keeps the edit.
await clickText(desk, 'Κάτοψη');
await clickText(desk, 'Όγκος');
p = await screen(desk, 4, 3);
await desk.mouse.click(p.x, p.y);
const projectB = await desk.evaluate(async () => {
	const { pb } = await import('/src/lib/pb.ts');
	const { createProject } = await import('/src/lib/inspirations.ts');
	return (await createProject(pb, pb.authStore.record.id, 'Άλλο ' + Date.now().toString(36))).id;
});
const goVia = (id) => desk.evaluate((u) => { const a = document.createElement('a'); a.href = u; document.body.append(a); a.click(); a.remove(); }, `/house?project=${id}`);
await goVia(projectB);
await desk.waitForFunction((id) => location.search.includes(id) && window.__house && window.__house.model().elements.length === 0, { timeout: 15000 }, projectB);
ok(true, 'switching project in-app shows the other project empty');
await sleep(1500);
await goVia(projectId);
await desk.waitForFunction(() => window.__house && window.__house.model().elements.some((e) => e.type === 'box'), { timeout: 15000 });
ok(true, 'back on the first project: the pending edit was saved there');

// Exports.
const cdp = await desk.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
await clickText(desk, 'Λήψη');
await clickText(desk, 'Μοντέλο 3D (.glb)');
await sleep(1500);
await clickText(desk, 'Λήψη');
await clickText(desk, 'Περιγραφή για AI/CAD (.json)');
await sleep(1500);
const files = readdirSync(DL);
log('downloads', files);
ok(files.some((f) => f.endsWith('.glb')) && files.some((f) => f.endsWith('.house.json')), 'downloaded .glb and .json');

// ------------------------------------------------------------------ Tablet: touch + pen
const tab = await signedInPage({ width: 1180, height: 820, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await tab.goto(`${APP}/house?project=${projectId}`, { waitUntil: 'networkidle0' });
await wait(tab);
await sleep(400);
m = await model(tab);
ok(m.elements.some((e) => e.type === 'pool') && m.elements.some((e) => e.type === 'box'), 'tablet sees the last saved state after load (pool and the volume added before the switch)');

// Reload right after an edit (before the autosave delay): the edit survives.
tab.on('dialog', (d) => void d.accept());
const before0 = (await model(tab)).elements.length;
await clickText(tab, 'Κάτοψη');
await clickText(tab, 'Όγκος');
const qv = await screen(tab, -3, -3);
await tab.touchscreen.tap(qv.x, qv.y);
await tab.reload({ waitUntil: 'networkidle0' });
await wait(tab);
await sleep(300);
ok((await model(tab)).elements.length === before0 + 1, 'an edit made just before a reload is kept');

const tcdp = await tab.createCDPSession();
const touch = (type, pts) => tcdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 4, radiusY: 4, force: 1 })) });
const cam = () => tab.evaluate(() => { const c = window.__house.vp.camera.position; const t = window.__house.vp.controls.target; return { x: c.x, y: c.y, z: c.z, d: c.distanceTo(t), tx: t.x, tz: t.z }; });

// One finger orbits in Select.
await clickText(tab, 'Επιλογή');
let before = await cam();
await touch('touchStart', [[600, 450]]);
for (let i = 1; i <= 10; i++) await touch('touchMove', [[600 + i * 20, 450]]);
await touch('touchEnd', []);
let after = await cam();
ok(Math.hypot(after.x - before.x, after.z - before.z) > 1 && Math.abs(after.d - before.d) < 0.01, 'one finger orbits (distance kept)');

// Two fingers pinch zoom.
before = await cam();
await touch('touchStart', [[500, 450], [700, 450]]);
for (let i = 1; i <= 10; i++) await touch('touchMove', [[500 - i * 15, 450], [700 + i * 15, 450]]);
await touch('touchEnd', []);
after = await cam();
ok(after.d < before.d - 0.5, `two-finger pinch zooms in (${before.d.toFixed(1)} → ${after.d.toFixed(1)})`);

// Two fingers in a drawing tool pan/zoom and place no wall point.
await clickText(tab, 'Τοίχος');
const n0 = (await model(tab)).elements.length;
await touch('touchStart', [[500, 500], [700, 500]]);
for (let i = 1; i <= 6; i++) await touch('touchMove', [[500 + i * 10, 500 + i * 10], [700 + i * 10, 500 + i * 10]]);
await touch('touchEnd', []);
ok((await tab.evaluate(() => window.__house.vp.drafting)) === false, 'two fingers in the wall tool do not draw');

// One finger taps in the wall tool draw (tablet without pen).
await clickText(tab, 'Κάτοψη');
await sleep(300);
for (const [x, y] of [[-6, 0], [-6, 5]]) {
	const q = await screen(tab, x, y);
	await touch('touchStart', [[q.x, q.y]]);
	await touch('touchEnd', []);
	await sleep(400); // two taps apart are not a double tap
}
await clickText(tab, 'Τέλος');
m = await model(tab);
ok(m.elements.length === n0 + 1 && m.elements.at(-1).type === 'wall', 'finger taps drew a wall');

// Pen draws a wall (Pointer Events pointerType "pen").
const pen = async (type, x, y, buttons) => tcdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, pointerType: 'pen', force: 0.5 });
for (const [x, y] of [[-6, 5], [-2, 5]]) {
	const q = await screen(tab, x, y);
	await pen('mouseMoved', q.x, q.y, 0);
	await pen('mousePressed', q.x, q.y, 1);
	await pen('mouseReleased', q.x, q.y, 0);
	await sleep(400);
}
await clickText(tab, 'Τέλος');
m = await model(tab);
const pw = m.elements.at(-1);
ok(pw.type === 'wall' && JSON.stringify(pw.points) === '[[-6,5],[-2,5]]', 'pen drew a wall: ' + JSON.stringify(pw.points));
await clickText(tab, '3D');
await sleep(400);
await tab.screenshot({ path: join(OUT, 'house-tablet.png') });

// Phone width (bottom rail).
await tab.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await sleep(500);
await tab.screenshot({ path: join(OUT, 'house-phone.png') });
await tab.setViewport({ width: 1180, height: 820, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await tab.reload({ waitUntil: 'networkidle0' });
await wait(tab);
await sleep(500);

// ------------------------------------------------------------------ Handles, items, typed length (tablet: pen, touch, mouse)
const it = await signedInPage({ width: 1180, height: 820, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const itName = 'Έπιπλα ' + Date.now().toString(36);
const itProject = await it.evaluate(async (name) => {
	const { pb } = await import('/src/lib/pb.ts');
	const { createProject } = await import('/src/lib/inspirations.ts');
	return (await createProject(pb, pb.authStore.record.id, name)).id;
}, itName);
await it.goto(`${APP}/house?project=${itProject}`, { waitUntil: 'networkidle0' });
await wait(it);
const icdp = await it.createCDPSession();
const iTouch = (type, pts) => icdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 4, radiusY: 4, force: 1 })) });
const iPen = (type, x, y, buttons) => icdp.send('Input.dispatchMouseEvent', { type, x, y, button: buttons || type === 'mouseReleased' ? 'left' : 'none', buttons, clickCount: 1, pointerType: 'pen', force: 0.5 });
const iMouse = (type, x, y, buttons) => icdp.send('Input.dispatchMouseEvent', { type, x, y, button: buttons || type === 'mouseReleased' ? 'left' : 'none', buttons, clickCount: 1, pointerType: 'mouse' });
const frame = () => it.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
const penTap = async (q) => {
	await iPen('mouseMoved', q.x, q.y, 0);
	await iPen('mousePressed', q.x, q.y, 1);
	await iPen('mouseReleased', q.x, q.y, 0);
	await sleep(400);
};
/** Press at a, move in steps to b (one frame each), optionally run `mid` before release. */
const penDrag = async (a, b, steps = 10, mid) => {
	await iPen('mouseMoved', a.x, a.y, 0);
	await iPen('mousePressed', a.x, a.y, 1);
	for (let i = 1; i <= steps; i++) {
		await iPen('mouseMoved', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps, 1);
		await frame();
	}
	if (mid) await mid();
	await iPen('mouseReleased', b.x, b.y, 0);
	await sleep(200);
};
const wallsOf = (m) => Object.fromEntries(m.elements.filter((e) => e.type === 'wall').map((e) => [e.id, e.points]));

// A closed 8 × 6 m room and a garden wall that shares its corner (8, 0).
await it.evaluate(() =>
	window.__house.commit({
		schema: 'moodboard.house/v1',
		units: 'm',
		elements: [
			{ id: 'room', type: 'wall', name: '', material: 'plaster_white', points: [[0, 0], [8, 0], [8, 6], [0, 6], [0, 0]], height: 3, thickness: 0.25, base: 0 },
			{ id: 'garden', type: 'wall', name: '', material: 'stone', points: [[8, 0], [12, 0]], height: 1.2, thickness: 0.25, base: 0 }
		]
	})
);
await clickText(it, 'Επιλογή');
await clickText(it, 'Κάτοψη');
await it.click('button[aria-label="Κεντράρισμα"]');
await sleep(300);
await penTap(await screen(it, 0, 3, 3));
ok((await it.evaluate(() => window.__house.vp.selected)) === 'room', 'pen tap selects the room wall');
const handleCount = await it.$$eval('.vp-handles .h', (els) => els.length);
ok(handleCount === 5 + 4, `room wall shows 5 corner and 4 "+" handles (${handleCount})`);
await it.screenshot({ path: join(OUT, 'house-items-handles.png') });

// Pen drags the shared corner (8, 0) to (9, -1): the garden wall follows; one undo step.
const depth0 = await it.evaluate(() => window.__house.undoDepth());
const m0 = await model(it);
await penDrag(await screen(it, 8, 0, 0), await screen(it, 9, -1, 0), 12, async () => {
	ok(await it.evaluate(() => window.__house.vp.dragging), 'pen press on a corner handle starts a drag (no orbit)');
	ok(JSON.stringify(await model(it)) === JSON.stringify(m0), 'the model is not committed while the pen moves');
	await it.screenshot({ path: join(OUT, 'house-items-drag.png') });
});
let mi = await model(it);
ok(JSON.stringify(wallsOf(mi).room[1]) === '[9,-1]' && JSON.stringify(wallsOf(mi).garden[0]) === '[9,-1]', 'corner and the joined garden wall moved to (9, -1): ' + JSON.stringify(wallsOf(mi)));
ok((await it.evaluate(() => window.__house.undoDepth())) === depth0 + 1, 'the drag is one undo step');
await it.click('button[aria-label="Αναίρεση"]');
ok(JSON.stringify(await model(it)) === JSON.stringify(m0), 'one undo restores the model before the drag');
await it.click('button[aria-label="Επανάληψη"]');
mi = await model(it);
ok(JSON.stringify(wallsOf(mi).room[1]) === '[9,-1]', 'redo brings the drag back');

// One finger drags a corner; a second finger cancels it and the model stays as it was.
const m1 = JSON.stringify(await model(it));
const depth1 = await it.evaluate(() => window.__house.undoDepth());
const c0 = await screen(it, 0, 6, 0);
await iTouch('touchStart', [[c0.x, c0.y]]);
for (let i = 1; i <= 6; i++) {
	await iTouch('touchMove', [[c0.x - i * 8, c0.y - i * 8]]);
	await frame();
}
ok(await it.evaluate(() => window.__house.vp.dragging), 'one finger on a corner handle drags it');
await iTouch('touchStart', [[c0.x - 48, c0.y - 48], [c0.x + 150, c0.y]]);
ok(!(await it.evaluate(() => window.__house.vp.dragging)), 'a second finger cancels the drag');
for (let i = 1; i <= 5; i++) await iTouch('touchMove', [[c0.x - 48 - i * 10, c0.y - 48], [c0.x + 150 + i * 10, c0.y]]);
await iTouch('touchEnd', []);
await sleep(200);
ok(JSON.stringify(await model(it)) === m1 && (await it.evaluate(() => window.__house.undoDepth())) === depth1, 'the cancelled drag left the model and the history unchanged');

// Items: a sofa and a stair from the catalog.
await clickText(it, 'Αντικείμενα');
await it.waitForSelector('.catalog');
await it.screenshot({ path: join(OUT, 'house-items-picker.png') });
await clickText(it, 'Καναπές', '.catalog button');
await penTap(await screen(it, 4, 3));
await clickText(it, 'Σκάλα', '.catalog button');
await penTap(await screen(it, 2, 1.5));
mi = await model(it);
const sofa = mi.elements.find((e) => e.type === 'item' && e.kind === 'sofa');
const stair = mi.elements.find((e) => e.type === 'item' && e.kind === 'stair');
ok(sofa && JSON.stringify(sofa.center) === '[4,3]', 'sofa placed at (4, 3): ' + JSON.stringify(sofa));
ok(stair && JSON.stringify(stair.center) === '[2,1.5]', 'stair placed at (2, 1.5): ' + JSON.stringify(stair));

// Select the sofa, turn it with the rotate knob (pen), then an Escape cancels a mouse move.
await clickText(it, 'Επιλογή');
await penTap(await screen(it, 4, 3, sofa.height));
ok((await it.evaluate(() => window.__house.vp.selected)) === sofa.id, 'pen tap selects the sofa');
ok((await it.$eval('.inspector .kind', (e) => e.textContent.trim())) === 'Καναπές' && (await it.$eval('.inspector .ifc', (e) => e.textContent.trim())) === 'IfcFurniture', 'inspector shows Καναπές / IfcFurniture');
const knob = await screen(it, 4, 3 + sofa.length / 2 + 0.5, sofa.height);
await penDrag(knob, await screen(it, 2.5, 3, sofa.height), 10);
mi = await model(it);
ok(mi.elements.find((e) => e.id === sofa.id).rotation === 90, 'rotate knob turned the sofa to 90°: ' + mi.elements.find((e) => e.id === sofa.id).rotation);
const m2 = JSON.stringify(mi);
const sc = await screen(it, 4, 3, sofa.height);
await iMouse('mouseMoved', sc.x, sc.y, 0);
await iMouse('mousePressed', sc.x, sc.y, 1);
for (let i = 1; i <= 6; i++) {
	await iMouse('mouseMoved', sc.x + i * 15, sc.y, 1);
	await frame();
}
await it.keyboard.press('Escape');
await iMouse('mouseReleased', sc.x + 90, sc.y, 0);
await sleep(200);
ok(JSON.stringify(await model(it)) === m2, 'Escape cancels a mouse drag of the sofa');
ok((await it.evaluate(() => window.__house.vp.selected)) === sofa.id, 'Escape during a drag keeps the selection');
await clickText(it, '3D');
await sleep(400);
await it.screenshot({ path: join(OUT, 'house-items-3d.png') });

// Typed length: one tap, the pen hovers north, then "3.2" + Enter places the next corner 3.2 m away.
await it.keyboard.press('Escape'); // close the inspector
await clickText(it, 'Κάτοψη');
await clickText(it, 'Τοίχος');
await sleep(200);
await penTap(await screen(it, -3, 0));
const north = await screen(it, -3, 2);
await iPen('mouseMoved', north.x, north.y, 0);
await sleep(100);
ok(await it.$('.len input'), 'the length field shows after the first corner');
await it.screenshot({ path: join(OUT, 'house-items-length.png') });
await it.keyboard.press('3'); // a digit on the page jumps into the field
await it.keyboard.type('.2');
await it.keyboard.press('Enter');
await sleep(150);
await clickText(it, 'Τέλος');
mi = await model(it);
const typed = mi.elements.at(-1);
const seg = Math.hypot(typed.points[1][0] - typed.points[0][0], typed.points[1][1] - typed.points[0][1]);
ok(typed.type === 'wall' && JSON.stringify(typed.points) === '[[-3,0],[-3,3.2]]' && Math.abs(seg - 3.2) < 1e-9, `typed length gave a ${seg} m wall: ` + JSON.stringify(typed.points));

// Exports: one glTF node item:<id> per item, IFC classes in the JSON.
const icdpDl = await it.createCDPSession();
await icdpDl.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
const already = new Set(readdirSync(DL));
await clickText(it, 'Λήψη');
await clickText(it, 'Μοντέλο 3D (.glb)');
await sleep(1500);
await clickText(it, 'Λήψη');
await clickText(it, 'Περιγραφή για AI/CAD (.json)');
await sleep(1500);
const fresh = readdirSync(DL).filter((f) => !already.has(f));
const glbFile = fresh.find((f) => f.endsWith('.glb'));
const jsonFile = fresh.find((f) => f.endsWith('.house.json'));
ok(glbFile && jsonFile, 'downloaded the items .glb and .json: ' + fresh.join(', '));
const glb = readFileSync(join(DL, glbFile));
const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
const itemIds = mi.elements.filter((e) => e.type === 'item').map((e) => e.id);
const nodeNames = gltf.nodes.map((n) => n.name);
ok(itemIds.every((id) => nodeNames.filter((n) => n === `item:${id}`).length === 1), 'glb has one node item:<id> per item: ' + nodeNames.filter((n) => n.startsWith('item:')).join(', '));
const sem = JSON.parse(readFileSync(join(DL, jsonFile), 'utf8'));
const classes = Object.fromEntries(sem.elements.filter((e) => e.type === 'item').map((e) => [e.objectType, e.ifcClass]));
ok(classes.sofa === 'IfcFurniture' && classes.stair === 'IfcStair', 'json: sofa IfcFurniture, stair IfcStair: ' + JSON.stringify(classes));

// Perf: 150 walls; a corner drag must not rebuild the scene per move.
await it.evaluate(() => {
	const m = window.__house.model();
	const extra = Array.from({ length: 150 }, (_, i) => ({
		id: 'p' + i, type: 'wall', name: '', material: 'plaster_white',
		points: [[(i % 10) * 4, 20 + Math.floor(i / 10) * 2], [(i % 10) * 4 + 3, 20 + Math.floor(i / 10) * 2]], height: 3, thickness: 0.2, base: 0
	}));
	window.__house.commit({ ...m, elements: [...m.elements, ...extra] });
});
await clickText(it, 'Επιλογή');
await it.click('button[aria-label="Κεντράρισμα"]');
await sleep(300);
await it.evaluate(() => window.__house.vp.on.select('p0'));
await sleep(200);
await it.evaluate(() => {
	window.__house.vp.stats.builds = 0;
	window.__house.vp.stats.previewMs.length = 0;
});
const pa = await screen(it, 3, 20, 0);
const pb2 = await screen(it, 3, 17, 0);
await iMouse('mouseMoved', pa.x, pa.y, 0);
await iMouse('mousePressed', pa.x, pa.y, 1);
const t0 = Date.now();
for (let i = 1; i <= 60; i++) {
	await iMouse('mouseMoved', pa.x + ((pb2.x - pa.x) * i) / 60, pa.y + ((pb2.y - pa.y) * i) / 60, 1);
	await frame();
}
const wallMs = (Date.now() - t0) / 60;
const during = await it.evaluate(() => ({ builds: window.__house.vp.stats.builds, ms: [...window.__house.vp.stats.previewMs] }));
await iMouse('mouseReleased', pb2.x, pb2.y, 0);
await sleep(200);
const builds = await it.evaluate(() => window.__house.vp.stats.builds);
const sorted = during.ms.slice().sort((x, y) => x - y);
const median = sorted[Math.floor(sorted.length / 2)];
log(`perf 150 walls: ${during.ms.length} previews, median ${median?.toFixed(2)} ms preview work per move, ${wallMs.toFixed(1)} ms per move incl. CDP + frame`);
ok(during.builds === 0 && builds === 1 && during.ms.length >= 50, `no full rebuild while dragging (${during.builds}), one on release (${builds})`);
ok(JSON.stringify(wallsOf(await model(it)).p0[1]) === '[3,17]', 'perf drag committed the corner at (3, 17)');

await browser.close();
console.log('ALL OK', projectId);
