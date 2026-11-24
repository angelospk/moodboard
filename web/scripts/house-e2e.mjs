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
ok(m.elements.some((e) => e.type === 'pool') && !m.elements.some((e) => e.type === 'box'), 'tablet sees the last saved state after load');

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

await browser.close();
console.log('ALL OK', projectId);
