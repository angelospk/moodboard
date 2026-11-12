<script lang="ts">
	import { t } from '#lib/i18n.js';
	import { onMount } from 'svelte';
	import Icon from './Icon.svelte';
	import { CANVASES, THEMES, applyPrefs, loadPrefs, type Prefs, type Theme } from '#lib/appearance.js';

	let prefs = $state<Prefs>({ theme: 'auto', light: 'paper', dark: 'night' });
	let osDark = $state(false);
	let open = $state(false);
	let btn = $state<HTMLButtonElement>();
	let pop = $state<HTMLDivElement>();

	/** The side the page shows now; the canvas row offers that side's swatches. */
	const mode = $derived(prefs.theme === 'auto' ? (osDark ? 'dark' : 'light') : prefs.theme);

	onMount(() => {
		prefs = loadPrefs();
		const mq = window.matchMedia('(prefers-color-scheme: dark)');
		osDark = mq.matches;
		const on = (e: MediaQueryListEvent) => (osDark = e.matches);
		mq.addEventListener('change', on);
		return () => mq.removeEventListener('change', on);
	});

	function set(patch: Partial<Prefs>) {
		prefs = { ...prefs, ...patch };
		applyPrefs(prefs);
	}

	const toggle = () => (open = !open);

	// Close on a click outside or Esc; the Esc must not also close the image panel.
	$effect(() => {
		if (!open) return;
		const down = (e: PointerEvent) => {
			const t = e.target as Node;
			if (!pop?.contains(t) && !btn?.contains(t)) open = false;
		};
		const key = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			e.stopPropagation();
			open = false;
			btn?.focus();
		};
		window.addEventListener('pointerdown', down, true);
		window.addEventListener('keydown', key, true);
		return () => {
			window.removeEventListener('pointerdown', down, true);
			window.removeEventListener('keydown', key, true);
		};
	});
</script>

<span class="wrap">
<button
	type="button"
	class="dbtn icon"
	class:on={open}
	aria-label={t('appearance.title')}
	aria-expanded={open}
	aria-haspopup="dialog"
	bind:this={btn}
	onclick={toggle}
>
	<Icon name="contrast" />
	{#if !open}<span class="tip" aria-hidden="true">{t('appearance.tip')}</span>{/if}
</button>

{#if open}
	<div
		class="pop"
		role="dialog"
		aria-label={t('appearance.title')}
		tabindex="-1"
		bind:this={pop}
		onkeydown={(e) => {
			// Arrow keys here must not reach the board (they switch the open image).
			if (e.key.startsWith('Arrow')) e.stopPropagation();
		}}
	>
		<div class="row">
			<span class="h">{t('appearance.theme')}</span>
			<div class="seg" role="group" aria-label={t('appearance.theme')}>
				{#each THEMES as t (t.id)}
					<button
						type="button"
												aria-pressed={prefs.theme === t.id}
						class:on={prefs.theme === t.id}
						onclick={() => set({ theme: t.id as Theme })}>{t.name}</button
					>
				{/each}
			</div>
		</div>
		<div class="row">
			<span class="h">{t('appearance.canvas')}</span>
			<div class="sw" role="group" aria-label={t('appearance.canvasColor')}>
				{#each CANVASES[mode] as c (c.id)}
					{@const on = prefs[mode] === c.id}
					<button
						type="button"
												aria-pressed={on}
						class:on
						title={c.name}
						onclick={() => set({ [mode]: c.id })}
					>
						<span class="dot" style:background={c.color}></span>
						<span class="name">{c.name}</span>
					</button>
				{/each}
			</div>
		</div>
	</div>
{/if}
</span>

<style>
	.wrap {
		position: relative;
		display: inline-flex;
	}
	.pop {
		/* The button is the dock's last control: open leftwards so the popover stays on screen. */
		position: absolute;
		bottom: calc(100% + 14px);
		right: 0;
		z-index: 30;
		width: max-content;
		max-width: calc(100vw - 24px);
		display: grid;
		gap: 14px;
		padding: 14px;
		background: var(--raised);
		border-radius: var(--r-panel);
		box-shadow:
			0 12px 32px -12px rgb(0 0 0 / 0.3),
			0 0 0 1px var(--line);
		animation: rise 0.16s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
	}
	.row {
		display: grid;
		gap: 7px;
	}
	.h {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--muted);
	}
	.seg {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
	}
	.seg button {
		min-height: 32px;
	}
	.sw {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 64px));
		gap: 6px;
	}
	.sw button {
		display: grid;
		justify-items: center;
		gap: 5px;
		padding: 6px 2px 5px;
		border: 0;
		border-radius: var(--r-ctl);
		background: none;
		color: var(--muted);
		font-size: 12px;
	}
	.sw button:hover {
		background: var(--sunk);
		color: var(--text);
	}
	.dot {
		width: 30px;
		height: 30px;
		border-radius: 999px;
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 18%, transparent);
	}
	.sw button.on {
		color: var(--text);
	}
	.sw button.on .dot {
		box-shadow:
			inset 0 0 0 1px color-mix(in srgb, var(--text) 18%, transparent),
			0 0 0 2px var(--raised),
			0 0 0 4px var(--accent);
	}
	@media (prefers-reduced-motion: reduce) {
		.pop {
			animation: none;
		}
	}
</style>
