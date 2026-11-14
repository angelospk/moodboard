<script lang="ts">
	import { t } from '#lib/i18n.js';
	import { cleanSource } from '#lib/inspirations.js';
	import { hostOf } from '#lib/sources.js';
	import { activeSource } from '#lib/activeSource.svelte.js';
	import { SOURCE_PROJECT_MAX } from '#lib/sourceProjects.js';
	import Icon from './Icon.svelte';

	// «Πηγή» in the dock: the page (and source project) every new image gets, until stopped.
	interface Props {
		/** Source project names in use (suggestions). */
		names: string[];
		/** The name the images of a page already have, if any. */
		nameFor: (url: string) => string | null;
		/** The paste shortcut, e.g. ⌘ or Ctrl+. */
		mod: string;
	}
	let { names, nameFor, mod }: Props = $props();

	const live = $derived(activeSource.live);
	const host = $derived(live ? (hostOf(live.url) ?? live.url) : '');
	const uid = $props.id();

	let open = $state(false);
	let btn = $state<HTMLButtonElement>();
	let pop = $state<HTMLDivElement>();
	let url = $state('');
	let project = $state('');
	let error = $state('');

	function toggle() {
		open = !open;
		if (!open) return;
		url = live?.url ?? '';
		project = live?.project ?? '';
		error = '';
	}

	/** A page with a known name fills an empty name field. */
	function onUrl() {
		error = '';
		const page = cleanSource(url);
		if (page && !project.trim()) project = nameFor(page) ?? '';
	}

	function submit(e: SubmitEvent) {
		e.preventDefault();
		const page = cleanSource(url);
		if (!page) {
			error = t('src.badUrl');
			return;
		}
		activeSource.start(page, project);
		open = false;
		btn?.focus();
	}

	function stop() {
		activeSource.stop();
		open = false;
		btn?.focus();
	}

	// Close on a click outside or Esc; the Esc must not also close the image panel.
	$effect(() => {
		if (!open) return;
		const down = (e: PointerEvent) => {
			const n = e.target as Node;
			if (!pop?.contains(n) && !btn?.contains(n)) open = false;
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
		class="dbtn src"
		class:on={!!live || open}
		class:live={!!live}
		aria-label={live ? t('src.tipOn', { host }) : t('src.tipOff')}
		aria-expanded={open}
		aria-haspopup="dialog"
		bind:this={btn}
		onclick={toggle}
	>
		<Icon name="link" />
		<span class="lbl">{live ? host : t('src.button')}</span>
		{#if live?.project}<span class="lbl name">{live.project}</span>{/if}
		{#if live}<span class="dot" aria-hidden="true"></span>{/if}
		{#if !open}<span class="tip" aria-hidden="true">{live ? t('src.tipOn', { host }) : t('src.tipOff')}</span>{/if}
	</button>

	{#if open}
		<div
			class="pop"
			role="dialog"
			aria-label={t('src.title')}
			tabindex="-1"
			bind:this={pop}
			onkeydown={(e) => {
				// Arrow keys and letters here must not reach the board (they switch images, run shortcuts).
				if (e.key !== 'Escape') e.stopPropagation();
			}}
		>
		<form onsubmit={submit}>
			<p class="h">{t('src.title')}</p>
			<label class="row">
				<span>{t('src.page')}</span>
				<!-- svelte-ignore a11y_autofocus -->
				<input
					type="text"
					inputmode="url"
					bind:value={url}
					placeholder="https://…"
					autocomplete="off"
					autofocus={!live}
					oninput={() => (error = '')}
					onchange={onUrl}
					aria-invalid={!!error}
				/>
			</label>
			<label class="row">
				<span>{t('sp.label')}</span>
				<!-- svelte-ignore a11y_autofocus -->
				<!-- A live source: the name is what changes most; either way focus leaves the dock button,
				     so the board's shortcuts (N, F, L) do not fire while the form is open. -->
				<input
					type="text"
					list="src-names-{uid}"
					autofocus={!!live}
					bind:value={project}
					placeholder={t('sp.placeholder')}
					maxlength={SOURCE_PROJECT_MAX}
					autocomplete="off"
				/>
				<datalist id="src-names-{uid}">
					{#each names as n (n)}<option value={n}></option>{/each}
				</datalist>
			</label>
			{#if error}<p class="err" role="alert">{error}</p>{/if}
			<p class="note">{t('src.note')}</p>
			<p class="note">{t('src.pasteHint', { mod })}</p>
			<div class="acts">
				<button type="submit" class="btn primary">{live ? t('src.update') : t('src.start')}</button>
				{#if live}<button type="button" class="btn" onclick={stop}>{t('src.stop')}</button>{/if}
			</div>
		</form>
		</div>
	{/if}
</span>

<style>
	.wrap {
		position: relative;
		display: inline-flex;
	}
	.src .lbl {
		max-width: 150px;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.src .name {
		color: var(--muted);
	}
	.src .name::before {
		content: '· ';
	}
	.dot {
		position: absolute;
		top: 6px;
		left: 22px;
		width: 7px;
		height: 7px;
		border-radius: 999px;
		background: var(--accent);
		box-shadow: 0 0 0 2px var(--raised);
	}
	form {
		display: grid;
		gap: 10px;
		margin: 0;
	}
	.pop {
		position: absolute;
		bottom: calc(100% + 14px);
		left: 0;
		z-index: 30;
		width: 300px;
		max-width: calc(100vw - 24px);
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
	.h {
		margin: 0;
		font-size: 13px;
		font-weight: 600;
	}
	.row {
		display: grid;
		gap: 5px;
		font-size: 12.5px;
		font-weight: 600;
		color: var(--muted);
	}
	.row input {
		min-width: 0;
		font-weight: 400;
	}
	.note,
	.err {
		margin: 0;
		font-size: 12px;
		line-height: 1.4;
		color: var(--muted);
	}
	.err {
		color: var(--accent);
	}
	.acts {
		display: flex;
		gap: 8px;
	}
	@media (max-width: 640px) {
		.src .name {
			display: none;
		}
		.dot {
			top: 7px;
			left: 24px;
		}
		.pop {
			position: fixed;
			left: 12px;
			right: 12px;
			bottom: calc(76px + env(safe-area-inset-bottom));
			width: auto;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.pop {
			animation: none;
		}
	}
</style>
