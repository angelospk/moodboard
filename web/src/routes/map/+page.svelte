<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { LEVELS, type Level } from '#lib/types.js';
	import { LEVEL_LABELS } from '#lib/tags.js';
	import type cytoscape from 'cytoscape';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let container = $state<HTMLDivElement | null>(null);
	let cy = $state<cytoscape.Core | null>(null);

	let project = $state('all');
	let showTags = $state(true);
	let level = $state<Level | ''>('');

	const filtered = $derived.by(() =>
		data.inspirations.filter((i) => {
			if (project === 'none' ? i.project_id !== null : project !== 'all' && i.project_id !== project) {
				return false;
			}
			if (level && i.level !== level) return false;
			return true;
		})
	);

	const hasNone = $derived(data.inspirations.some((i) => i.project_id === null));

	// Nodes and edges for the current filters. Cytoscape reads them from here.
	const graph = $derived.by(() => {
		const nodes: cytoscape.ElementDefinition[] = [];
		const edges: cytoscape.ElementDefinition[] = [];
		const items = filtered;

		const usedProjects = new Set<string>();
		for (const i of items) if (i.project_id) usedProjects.add(i.project_id);

		for (const p of data.projects) {
			if (!usedProjects.has(p.id)) continue;
			nodes.push({ group: 'nodes', data: { id: `p:${p.id}`, type: 'project', label: p.name } });
		}

		const known = new Set(data.projects.map((p) => p.id));
		let orphans = false;
		for (const i of items) {
			const pid = i.project_id && known.has(i.project_id) ? i.project_id : null;
			if (!pid) orphans = true;
			nodes.push({
				group: 'nodes',
				data: {
					id: `i:${i.id}`,
					type: 'inspiration',
					href: `/i/${i.id}`,
					img: data.urls[i.image_path] ?? '',
					badge: i.regions?.length ? String(i.regions.length) : ''
				}
			});
			const target = pid ? `p:${pid}` : 'p:none';
			edges.push({
				group: 'edges',
				data: { id: `e:i:${i.id}:${target}`, source: `i:${i.id}`, target }
			});
		}

		if (orphans) {
			nodes.push({ group: 'nodes', data: { id: 'p:none', type: 'project', label: 'Χωρίς project' } });
		}

		if (showTags) {
			const tags = new Set<string>();
			for (const i of items) for (const t of i.tags) tags.add(t);
			for (const t of [...tags].sort()) {
				nodes.push({ group: 'nodes', data: { id: `t:${t}`, type: 'tag', label: `#${t}` } });
			}
			for (const i of items) {
				for (const t of new Set(i.tags)) {
					edges.push({
						group: 'edges',
						data: { id: `e:i:${i.id}:t:${t}`, source: `i:${i.id}`, target: `t:${t}` }
					});
				}
			}
		}

		return { nodes, edges };
	});

	function palette() {
		const css = getComputedStyle(document.documentElement);
		const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
		return {
			bg: v('--bg', '#f6f4f0'),
			surface: v('--surface', '#ffffff'),
			muted: v('--muted', '#6f6a62'),
			line: v('--line', '#e3ded5'),
			accent: v('--accent', '#b4532a')
		};
	}

	/** Node width from the label length, so the pill grows with its text. */
	function pillWidth(ele: cytoscape.NodeSingular, perChar: number, pad: number, min: number) {
		const label = String(ele.data('label') ?? '');
		return Math.max(min, Math.min(220, label.length * perChar + pad));
	}

	function stylesheet(): cytoscape.StylesheetStyle[] {
		const c = palette();
		return [
			{
				selector: 'node',
				style: {
					'font-family': 'system-ui, -apple-system, Segoe UI, sans-serif',
					'font-size': 12,
					'min-zoomed-font-size': 5,
					'overlay-opacity': 0,
					'background-color': c.surface,
					'border-color': c.line,
					'border-width': 1,
					'text-valign': 'center',
					'text-halign': 'center',
					'text-wrap': 'ellipsis',
					'text-max-width': '160px'
				}
			},
			{
				selector: 'node[type="project"]',
				style: {
					shape: 'round-rectangle',
					label: 'data(label)',
					width: ((ele: cytoscape.NodeSingular) => pillWidth(ele, 7.4, 30, 86)) as cytoscape.Css.PropertyValueNode<number>,
					height: 38,
					'background-color': c.accent,
					'background-opacity': 1,
					'border-width': 0,
					color: '#ffffff',
					'font-size': 13,
					'font-weight': 600
				}
			},
			{
				selector: 'node[type="tag"]',
				style: {
					shape: 'round-rectangle',
					label: 'data(label)',
					width: ((ele: cytoscape.NodeSingular) => pillWidth(ele, 6.2, 18, 40)) as cytoscape.Css.PropertyValueNode<number>,
					height: 22,
					'background-color': c.bg,
					'background-opacity': 1,
					'border-color': c.line,
					'border-width': 1,
					color: c.muted,
					'font-size': 10
				}
			},
			{
				selector: 'node[type="inspiration"]',
				style: {
					shape: 'round-rectangle',
					width: 70,
					height: 70,
					'background-color': c.bg,
					'background-image': ((ele: cytoscape.NodeSingular) => ele.data('img') || 'none') as cytoscape.Css.PropertyValueNode<string>,
					'background-fit': 'cover',
					'background-clip': 'node',
					'background-image-opacity': 1,
					'border-color': c.line,
					'border-width': 1,
					label: 'data(badge)',
					color: '#ffffff',
					'font-size': 10,
					'text-margin-x': 6,
					'text-margin-y': 5,
					'text-halign': 'right',
					'text-valign': 'top',
					'text-background-color': c.accent,
					'text-background-opacity': 1,
					'text-background-shape': 'roundrectangle',
					'text-background-padding': '4px',
					'text-border-opacity': 0
				}
			},
			{
				selector: 'node[type="inspiration"]:active',
				style: { 'border-color': c.accent, 'border-width': 2 }
			},
			{
				selector: 'edge',
				style: {
					width: 1.5,
					'line-color': c.line,
					'curve-style': 'bezier',
					'overlay-opacity': 0
				}
			},
			{
				selector: '.faded',
				style: { opacity: 0.2, 'text-opacity': 0 }
			}
		] as cytoscape.StylesheetStyle[];
	}

	const LAYOUT: cytoscape.CoseLayoutOptions = {
		name: 'cose',
		animate: false,
		fit: true,
		padding: 60,
		randomize: true,
		nodeRepulsion: () => 12000,
		idealEdgeLength: () => 90,
		nodeOverlap: 16,
		gravity: 0.35,
		numIter: 1500,
		componentSpacing: 90,
		coolingFactor: 0.97
	};

	function runLayout(instance: cytoscape.Core) {
		instance.elements().unselect();
		instance.layout(LAYOUT).run();
	}

	function focusTag(instance: cytoscape.Core, node: cytoscape.NodeSingular) {
		const hood = node.closedNeighborhood();
		instance.elements().not(hood).addClass('faded');
		hood.removeClass('faded');
	}

	function clearFocus(instance: cytoscape.Core) {
		instance.elements().removeClass('faded');
	}

	let repaint: (() => void) | null = null;

	onMount(() => {
		const theme = window.matchMedia('(prefers-color-scheme: dark)');
		const onThemeChange = () => repaint?.();
		theme.addEventListener('change', onThemeChange);

		let resizeTimer: ReturnType<typeof setTimeout> | undefined;
		const onResize = () => {
			clearTimeout(resizeTimer);
			resizeTimer = setTimeout(() => {
				cy?.resize();
				cy?.fit(undefined, 60);
			}, 120);
		};
		window.addEventListener('resize', onResize);

		return () => {
			clearTimeout(resizeTimer);
			window.removeEventListener('resize', onResize);
			theme.removeEventListener('change', onThemeChange);
		};
	});

	// Create Cytoscape whenever the canvas element exists (it can appear after a reload of data).
	$effect(() => {
		const el = container;
		if (!el) return;
		let disposed = false;
		let instance: cytoscape.Core | null = null;
		(async () => {
			const cytoscape = (await import('cytoscape')).default;
			if (disposed) return;

			const inst = cytoscape({
				container: el,
				elements: [],
				style: stylesheet(),
				minZoom: 0.15,
				maxZoom: 3,
				selectionType: 'single'
			});
			instance = inst;

			inst.on('tap', 'node[type="inspiration"]', (e) => {
				const href = (e.target as cytoscape.NodeSingular).data('href') as string;
				goto(href);
			});
			inst.on('tap', 'node[type="tag"]', (e) => {
				focusTag(inst, e.target as cytoscape.NodeSingular);
			});
			inst.on('tap', (e) => {
				if (e.target === inst) clearFocus(inst);
			});

			// Repaint with the current CSS variables when the colour scheme changes.
			repaint = () => {
				if (disposed) return;
				inst.style(stylesheet());
				inst.forceRender();
			};

			cy = inst;
		})();

		return () => {
			disposed = true;
			repaint = null;
			instance?.destroy();
			cy = null;
		};
	});

	// Keep the graph in sync with the filters.
	$effect(() => {
		const instance = cy;
		const g = graph;
		if (!instance) return;
		instance.elements().remove();
		instance.add([...g.nodes, ...g.edges]);
		runLayout(instance);
	});
</script>

<svelte:head>
	<title>Χάρτης · Moodboard</title>
</svelte:head>

<div class="page">
	<header>
		<a class="back" href="/">← Πίνακας</a>
		<div class="controls">
			<select bind:value={project} aria-label="Project">
				<option value="all">Όλα τα projects</option>
				{#each data.projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
				{#if hasNone}<option value="none">Χωρίς project</option>{/if}
			</select>
			<select bind:value={level} aria-label="Επίπεδο">
				<option value="">Όλα τα επίπεδα</option>
				{#each LEVELS as l (l)}<option value={l}>{LEVEL_LABELS[l]}</option>{/each}
			</select>
			<label class="toggle">
				<input type="checkbox" bind:checked={showTags} />
				Tags
			</label>
			<button type="button" onclick={() => cy?.fit(undefined, 60)}>Κεντράρισμα</button>
		</div>
	</header>

	{#if data.error}
		<p class="msg">Σφάλμα φόρτωσης: {data.error}</p>
	{:else if data.inspirations.length === 0}
		<p class="msg">Δεν υπάρχουν ακόμα εικόνες. <a href="/new">Πρόσθεσε την πρώτη εικόνα →</a></p>
	{:else}
		<div class="canvas" bind:this={container}></div>
		{#if filtered.length === 0}
			<p class="hint">Καμία εικόνα με αυτά τα φίλτρα.</p>
		{/if}
	{/if}
</div>

<style>
	.page {
		position: fixed;
		inset: 0;
		display: flex;
		flex-direction: column;
		background: var(--bg);
		overflow: hidden;
	}

	header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		border-bottom: 1px solid var(--line);
		background: var(--surface);
	}
	.back {
		display: inline-flex;
		align-items: center;
		border-radius: 8px;
		padding: 0.45rem 0.75rem;
		border: 1px solid var(--line);
		text-decoration: none;
		white-space: nowrap;
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.controls select { min-width: 0; max-width: 100%; }
	.toggle { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 0.85rem; padding: 0 4px; }
	.toggle input { accent-color: var(--accent); }

	.canvas {
		flex: 1;
		min-height: 0;
		width: 100%;
		touch-action: none;
	}

	.msg { color: var(--muted); padding: 32px 16px; margin: 0; }
	.msg a { color: var(--accent); margin-left: 4px; }
	.hint {
		position: absolute;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		margin: 0;
		color: var(--muted);
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 999px;
		padding: 6px 14px;
		font-size: 0.82rem;
		pointer-events: none;
	}

	@media (max-width: 560px) {
		header { padding: 8px 10px; gap: 6px; flex-direction: column; align-items: stretch; }
		.back { align-self: flex-start; }
		.controls { flex: 0 1 auto; }
		.controls select { flex: 1 1 100%; min-width: 0; }
	}
</style>
