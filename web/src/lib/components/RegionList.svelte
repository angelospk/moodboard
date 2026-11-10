<script lang="ts">
	// CONTRACT (fixed). One row per region: number, note input, 5 rating squares (click again clears), delete.
	import type { Region } from '#lib/types.js';
	import { tick, untrack } from 'svelte';
	interface Props {
		/** Bindable. Always assign a new array. */
		regions: Region[];
		/** Bindable highlighted index, shared with RegionEditor. */
		active?: number | null;
	}
	let { regions = $bindable([]), active = $bindable(null) }: Props = $props();

	const WORDS: Record<number, string> = {
		1: 'όχι αυτό',
		2: 'μάλλον όχι',
		3: 'ενδιαφέρον',
		4: 'μου αρέσει',
		5: 'ακριβώς αυτό'
	};

	let inputs: HTMLInputElement[] = $state([]);

	// A region just drawn (one more row, empty, active) gets the caret, so the user can type its note at once.
	let seen = untrack(() => regions.length);
	$effect(() => {
		const n = regions.length;
		const last = regions[n - 1];
		const fresh = n === seen + 1 && last && last.note === '' && last.rating == null && untrack(() => active) === n - 1;
		seen = n;
		if (fresh) tick().then(() => inputs[n - 1]?.focus({ preventScroll: false }));
	});

	function patch(i: number, change: Partial<Region>) {
		regions = regions.map((r, j) => (j === i ? { ...r, ...change } : r));
	}

	/** Clicking the current rating again clears it. */
	function rate(i: number, n: number) {
		patch(i, { rating: regions[i].rating === n ? null : n });
	}

	function remove(i: number) {
		regions = regions.filter((_, j) => j !== i);
		active = null;
	}

	function leave(e: FocusEvent, i: number) {
		const row = e.currentTarget as HTMLElement;
		if (row.contains(e.relatedTarget as Node | null)) return;
		if (active === i) active = null;
	}
</script>

<div class="rl">
	{#if regions.length}
		<p class="legend">1 = όχι αυτό · 5 = ακριβώς αυτό</p>
		<ol>
			{#each regions as r, i (i)}
				<li
					class={{ on: active === i }}
					onpointerenter={() => (active = i)}
					onpointerleave={(e) => {
						// A row with focus stays highlighted while the pointer moves on.
						if (active === i && !e.currentTarget.contains(document.activeElement)) active = null;
					}}
					onfocusin={() => (active = i)}
					onfocusout={(e) => leave(e, i)}
				>
					<span class="n">{i + 1}</span>
					<input
						bind:this={inputs[i]}
						type="text"
						value={r.note}
						placeholder="Τι σου αρέσει σε αυτό;"
						aria-label={`Σημείωση περιοχής ${i + 1}`}
						maxlength="300"
						oninput={(e) => patch(i, { note: e.currentTarget.value })}
					/>
					<button type="button" class="del" aria-label={`Διαγραφή περιοχής ${i + 1}`} title="Διαγραφή περιοχής" onclick={() => remove(i)}>
						<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
					</button>
					<div class="sub">
						<div class="rate" role="group" aria-label={`Βαθμός περιοχής ${i + 1}`}>
							{#each [1, 2, 3, 4, 5] as n (n)}
								<button
									type="button"
									class={['sq', n <= (r.rating ?? 0) && 'fill']}
									aria-pressed={r.rating === n}
									aria-label={`Βαθμός ${n} από 5`}
									title={WORDS[n]}
									onclick={() => rate(i, n)}><i></i></button
								>
							{/each}
						</div>
						<span class={['word', r.rating == null && 'none']}>{r.rating ? WORDS[r.rating] : 'χωρίς βαθμό'}</span>
					</div>
				</li>
			{/each}
		</ol>
	{:else}
		<p class="empty">Σύρε πάνω στην εικόνα για να σημειώσεις μια λεπτομέρεια.</p>
	{/if}
</div>

<style>
	.rl {
		min-width: 0;
	}
	.legend {
		margin: 0 0 4px;
		font-size: 12px;
		color: var(--muted);
	}
	ol {
		list-style: none;
		margin: 0;
		padding: 0;
		border-top: 1px solid var(--line);
	}
	li {
		display: grid;
		grid-template-columns: 22px minmax(0, 1fr) 28px;
		gap: 2px 10px;
		align-items: center;
		padding: 8px 6px 6px;
		margin: 0 -6px;
		border-bottom: 1px solid var(--line);
		border-radius: 0;
		transition: background-color 150ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	li.on {
		background: color-mix(in srgb, var(--accent) 6%, transparent);
	}

	.n {
		width: 22px;
		height: 22px;
		display: grid;
		place-items: center;
		background: var(--accent);
		color: var(--on-accent);
		border-radius: 3px;
		font-size: 12px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	input {
		width: 100%;
		min-width: 0;
		border: 0;
		border-bottom: 1px solid transparent;
		border-radius: 0;
		background: none;
		padding: 5px 0;
		font-size: 14px;
		color: var(--text);
	}
	input::placeholder {
		color: var(--faint);
	}
	input:hover {
		border-bottom-color: var(--line-strong);
	}
	input:focus {
		outline: none;
		border-bottom-color: var(--accent);
	}

	.del {
		width: 28px;
		height: 28px;
		display: grid;
		place-items: center;
		padding: 0;
		border: 0;
		background: none;
		border-radius: var(--r-ctl);
		color: var(--faint);
	}
	.del svg {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
	}
	.del:hover {
		color: var(--accent);
		background: var(--sunk);
	}

	.sub {
		grid-column: 2 / 4;
		display: flex;
		align-items: center;
		gap: 8px;
		margin-left: -7px;
	}
	.rate {
		display: flex;
	}
	/* 28px hit area around a 14px square. */
	.sq {
		width: 28px;
		height: 28px;
		display: grid;
		place-items: center;
		padding: 0;
		border: 0;
		background: none;
		border-radius: var(--r-ctl);
	}
	.sq i {
		width: 14px;
		height: 14px;
		border: 1.5px solid var(--line-strong);
		border-radius: 2px;
		transition:
			background-color 150ms cubic-bezier(0.2, 0.8, 0.2, 1),
			border-color 150ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.sq.fill i {
		background: var(--accent);
		border-color: var(--accent);
	}
	/* Hover previews the rating: the hovered square and the ones before it. */
	.rate:hover .sq i {
		background: none;
		border-color: var(--line-strong);
	}
	.rate .sq:hover i,
	.rate .sq:has(~ .sq:hover) i {
		background: color-mix(in srgb, var(--accent) 45%, transparent);
		border-color: var(--accent);
	}
	.sq:focus-visible {
		outline-offset: -4px;
	}
	.word {
		font-size: 12.5px;
		color: var(--text);
	}
	.word.none {
		color: var(--faint);
	}

	.empty {
		margin: 0;
		padding: 14px;
		border: 1px dashed var(--line-strong);
		border-radius: var(--r-ctl);
		color: var(--muted);
		font-size: 12.5px;
		line-height: 1.45;
	}

	@media (prefers-reduced-motion: reduce) {
		li,
		.sq i {
			transition: none;
		}
	}
</style>
