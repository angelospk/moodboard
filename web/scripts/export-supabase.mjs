#!/usr/bin/env node
// Exports the local Supabase (docker: supabase_*_moodboard) into the folder layout that
// `moodboard import <dir>` reads: export.json + files/<inspiration id>.<ext>.
//
// Usage: node web/scripts/export-supabase.mjs <outDir>
//
// It never prints keys, password hashes or row contents. It prints only counts at the end.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const DB_CONTAINER = 'supabase_db_moodboard';
const STORAGE_BASE = 'http://127.0.0.1:54421';
const BUCKET = 'inspirations';

function fail(message) {
	console.error(`export: ${message}`);
	process.exit(1);
}

const outDir = process.argv[2];
if (!outDir) {
	console.error('usage: node web/scripts/export-supabase.mjs <outDir>');
	process.exit(2);
}

// One psql call per table; each query returns a single JSON value.
function query(sql) {
	let out;
	try {
		out = execFileSync(
			'docker',
			['exec', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-c', sql],
			{ encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }
		);
	} catch (err) {
		// Never echo err.stdout/stderr: they can hold row contents.
		fail(`psql query failed (is the ${DB_CONTAINER} container running?)`);
	}
	const text = out.trim();
	if (!text) return [];
	try {
		return JSON.parse(text);
	} catch (err) {
		fail(`cannot parse SQL output (${err.message})`);
	}
}

// PocketBase DateTime layout is "yyyy-mm-dd HH:mm:ss.SSSZ" in UTC.
function pbDate(value) {
	if (!value) return '';
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return '';
	return d.toISOString().replace('T', ' ');
}

function serviceRoleKey() {
	if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
	// `supabase status` exits non-zero when some optional service is stopped, so ignore its
	// exit code and only look for the key line on stdout.
	const res = spawnSync('npx', ['supabase', 'status', '-o', 'env'], {
		cwd: new URL('../..', import.meta.url).pathname,
		encoding: 'utf8',
		maxBuffer: 16 * 1024 * 1024
	});
	const out = res.stdout ?? '';
	const line = out.split('\n').find((l) => l.startsWith('SERVICE_ROLE_KEY='));
	if (!line) fail('SERVICE_ROLE_KEY not found in `supabase status -o env` (is the local stack running?)');
	return line.slice('SERVICE_ROLE_KEY='.length).trim().replace(/^"|"$/g, '');
}

let key;
try {
	key = serviceRoleKey();
} catch (err) {
	fail(`cannot read the service role key (${err.message})`);
}

// Test runs left hundreds of throwaway accounts (@example.com, some with fake image rows): skip them.
const REAL = `(select id from auth.users where email not like '%@example.com')`;

const users = query(
	`select coalesce(json_agg(t), '[]') from (
		select id::text as id, email, encrypted_password
		from auth.users where id in ${REAL} order by created_at
	) t`
);
const projects = query(
	`select coalesce(json_agg(t), '[]') from (
		select id::text as id, user_id::text as user_id, name, description, created_at
		from public.projects where user_id in ${REAL} order by created_at
	) t`
);
const inspirations = query(
	`select coalesce(json_agg(t), '[]') from (
		select id::text as id, user_id::text as user_id, project_id::text as project_id,
		image_path, source_url, source_title, note, tags, level::text as level,
		coalesce(regions, '[]'::jsonb) as regions, created_at
		from public.inspirations where user_id in ${REAL} order by created_at
	) t`
);
const positions = query(
	`select coalesce(json_agg(t), '[]') from (
		select user_id::text as user_id, scope, node_key, x, y
		from public.map_positions where user_id in ${REAL}
	) t`
);

// Count only: rows whose image_path has no object in the bucket. Used to make a failed
// download message useful without printing any row contents.
const orphans = query(
	`select coalesce(json_agg(t), '[]') from (
		select count(*)::int as n from public.inspirations i
		where i.user_id in ${REAL} and not exists (
			select 1 from storage.objects o
			where o.bucket_id = 'inspirations' and o.name = i.image_path
		)
	) t`
)[0].n;

rmSync(outDir, { recursive: true, force: true });
const filesDir = join(outDir, 'files');
mkdirSync(filesDir, { recursive: true });

async function download(imagePath, id) {
	const url = `${STORAGE_BASE}/storage/v1/object/${BUCKET}/` + imagePath.split('/').map(encodeURIComponent).join('/');
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${key}`, apikey: key }
	});
	if (!res.ok) {
		// No path or row contents here: the id is enough to find the row.
		throw new Error(
			`download failed for inspiration ${id}: HTTP ${res.status} ${res.statusText}` +
				(orphans
					? ` (${orphans} inspiration(s) point at an image_path with no object in bucket '${BUCKET}'; ` +
						`remove or re-upload them, then run again)`
					: '')
		);
	}
	const bytes = new Uint8Array(await res.arrayBuffer());
	const ext = extname(imagePath.split('/').pop() ?? '');
	const name = ext ? `${id}${ext}` : id;
	writeFileSync(join(filesDir, name), bytes);
	return { file: `files/${name}`, body: bytes.byteLength };
}

const seen = new Set();
const outInspirations = [];
let totalBytes = 0;

try {
	for (const row of inspirations) {
		if (!row.image_path) throw new Error(`inspiration ${row.id} has no image_path`);
		if (seen.has(row.image_path)) throw new Error(`inspiration ${row.id}: duplicate image_path`);
		seen.add(row.image_path);
		const file = await download(row.image_path, row.id);
		totalBytes += file.body;
		outInspirations.push({
			id: row.id,
			user_id: row.user_id,
			project_id: row.project_id,
			file: file.file,
			source_url: row.source_url,
			source_title: row.source_title,
			note: row.note ?? '',
			tags: Array.isArray(row.tags) ? row.tags : [],
			level: row.level,
			regions: row.regions ?? [],
			created_at: pbDate(row.created_at)
		});
	}
} catch (err) {
	rmSync(outDir, { recursive: true, force: true });
	fail(err.message);
}

const exportData = {
	users: users.map((u) => ({ id: u.id, email: u.email, password_hash: u.encrypted_password })),
	projects: projects.map((p) => ({
		id: p.id,
		user_id: p.user_id,
		name: p.name,
		description: p.description ?? '',
		created_at: pbDate(p.created_at)
	})),
	inspirations: outInspirations,
	map_positions: positions.map((p) => ({
		user_id: p.user_id,
		scope: p.scope,
		node_key: p.node_key,
		x: p.x,
		y: p.y
	}))
};

writeFileSync(join(outDir, 'export.json'), JSON.stringify(exportData));

console.log(
	`users: ${exportData.users.length}, projects: ${exportData.projects.length}, ` +
		`inspirations: ${exportData.inspirations.length}, positions: ${exportData.map_positions.length}, ` +
		`total bytes: ${totalBytes}`
);
