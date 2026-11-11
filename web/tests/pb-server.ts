// Vitest global setup: build the Go backend (../server) and run it on a temp data dir, so the
// client helpers are tested against the real API rules, hooks and routes.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

const PORT = 18190;
let proc: ChildProcess | undefined;
let dir = '';

export async function setup(project: TestProject) {
	dir = mkdtempSync(join(tmpdir(), 'mb-pb-'));
	const bin = join(dir, 'moodboard');
	const server = new URL('../../server', import.meta.url).pathname;
	execFileSync('go', ['build', '-o', bin, '.'], { cwd: server, stdio: 'inherit' });
	execFileSync(bin, ['superuser', 'upsert', 'admin@test.local', 'admin-password-1', '--dir', join(dir, 'data')]);
	proc = spawn(bin, ['serve', '--http', `127.0.0.1:${PORT}`, '--dir', join(dir, 'data')], { stdio: 'ignore' });
	const url = `http://127.0.0.1:${PORT}`;
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(`${url}/api/health`)).ok) break;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	project.provide('pbUrl', url);
}

export async function teardown() {
	proc?.kill();
	if (dir) rmSync(dir, { recursive: true, force: true });
}

declare module 'vitest' {
	export interface ProvidedContext {
		pbUrl: string;
	}
}
