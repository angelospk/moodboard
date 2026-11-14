<script lang="ts">
	import { t, tn } from '#lib/i18n.js';
	import { cleanSourceProject, SOURCE_PROJECT_MAX, type SourceProjectSuggestion } from '#lib/sourceProjects.js';
	import { hostOf } from '#lib/sources.js';
	import type { Inspiration } from '#lib/types.js';

	// Images without a source project that were saved from the same web page. Only offers: the user
	// edits the name and presses «Ορισμός»; nothing is applied by itself. One compact row each, the
	// first one shown, so the block never pushes the image grid far down.
	interface Props {
		suggestions: SourceProjectSuggestion[];
		/** Dismissed suggestions that would still apply; they can be shown again. */
		hidden: number;
		byId: Map<string, Inspiration>;
		urls: Record<string, string>;
		names: string[];
		busy: boolean;
		onapply: (ids: string[], name: string) => void;
		ondismiss: (key: string) => void;
		onrestore: () => void;
	}
	let { suggestions, hidden, byId, urls, names, busy, onapply, ondismiss, onrestore }: Props = $props();

	const SHOWN = 1;
	const THUMBS = 4;
	let all = $state(false);
	/** The name the user typed, by suggestion key; absent = the offered one. */
	let drafts = $state<Record<string, string>>({});
	const uid = $props.id();
	const listId = `sps-${uid}`;
	const shown = $derived(all ? suggestions : suggestions.slice(0, SHOWN));

	function nameOf(s: SourceProjectSuggestion): string {
		return drafts[s.key] ?? s.name;
	}

	function pageLabel(url: string): string {
		try {
			const u = new URL(url);
			return (hostOf(url) ?? u.hostname) + (u.pathname.length > 1 ? u.pathname.replace(/\/$/, '') : '');
		} catch {
			return url;
		}
	}
</script>

{#if suggestions.length || hidden}
	<section class="sugs" aria-label={t('sp.suggest.title')}>
		<datalist id={listId}>
			{#each names as n (n)}<option value={n}></option>{/each}
		</datalist>
		{#each shown as s (s.key)}
			{@const images = tn('common.images', s.ids.length)}
			<form
				class="sug"
				onsubmit={(e) => {
					e.preventDefault();
					const name = cleanSourceProject(nameOf(s));
					if (name && !busy) onapply(s.ids, name);
				}}
			>
				<div class="thumbs" aria-hidden="true">
					{#each s.ids.slice(0, THUMBS) as id (id)}
						{@const src = urls[byId.get(id)?.image_path ?? '']}
						{#if src}<img {src} alt="" loading="lazy" decoding="async" />{:else}<span class="ph"></span>{/if}
					{/each}
					{#if s.ids.length > THUMBS}<span class="more">+{s.ids.length - THUMBS}</span>{/if}
				</div>
				<div class="what">
					<p class="q">
						{s.existing ? t('sp.suggest.existing', { images, name: s.name }) : t('sp.suggest.new', { images })}
					</p>
					<a class="page" href={s.url} target="_blank" rel="noopener noreferrer" title={s.url}>{pageLabel(s.url)}</a>
				</div>
				<div class="row">
					<input
						type="text"
						list={listId}
						value={nameOf(s)}
						oninput={(e) => (drafts[s.key] = e.currentTarget.value)}
						aria-label={t('sp.suggest.name')}
						maxlength={SOURCE_PROJECT_MAX}
						autocomplete="off"
					/>
					<button type="submit" class="btn primary" disabled={busy || !cleanSourceProject(nameOf(s))}>
						{t('sp.suggest.apply')}
					</button>
					<button type="button" class="btn ghost" onclick={() => ondismiss(s.key)}>{t('sp.suggest.dismiss')}</button>
				</div>
			</form>
		{/each}
		{#if suggestions.length > SHOWN || hidden}
			<div class="foot">
				{#if suggestions.length > SHOWN}
					<button type="button" class="link" aria-expanded={all} onclick={() => (all = !all)}>
						{all ? t('sp.suggest.less') : t('sp.suggest.more', { n: suggestions.length - SHOWN })}
					</button>
				{/if}
				{#if hidden}
					<button type="button" class="link" onclick={onrestore}>{t('sp.suggest.restore', { n: hidden })}</button>
				{/if}
			</div>
		{/if}
	</section>
{/if}

<style>
	.sugs {
		margin: 0 0 16px;
		background: var(--sunk);
		border: 1px solid var(--line);
		border-radius: var(--r-ctl);
	}
	.sug {
		display: flex;
		gap: 12px;
		align-items: center;
		padding: 8px 12px;
	}
	.sug + .sug { border-top: 1px solid var(--line); }
	.thumbs { display: flex; gap: 3px; flex: none; }
	.thumbs img, .thumbs .ph, .thumbs .more {
		width: 32px;
		height: 32px;
		border-radius: var(--r-img);
		object-fit: cover;
		background: var(--line);
	}
	.thumbs .more { display: grid; place-items: center; font-size: 12.5px; color: var(--muted); background: none; }
	.what { display: grid; gap: 2px; min-width: 0; flex: 1; }
	.q { margin: 0; font-size: 14px; }
	.page {
		font-size: 12.5px;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.row { display: flex; gap: 8px; align-items: center; flex: 0 1 520px; min-width: 0; }
	.row input { flex: 1 1 200px; min-width: 0; }
	.foot {
		display: flex;
		gap: 16px;
		flex-wrap: wrap;
		padding: 2px 12px;
	}
	.sug ~ .foot { border-top: 1px solid var(--line); }
	.link {
		border: 0;
		background: none;
		padding: 0;
		min-height: 32px;
		font-size: 12.5px;
		color: var(--muted);
		text-decoration: underline;
		text-underline-offset: 3px;
		cursor: pointer;
	}
	.link:hover { color: var(--text); }
	@media (max-width: 760px) {
		.sug { flex-wrap: wrap; }
		.what { flex: 1 1 calc(100% - 160px); }
		.row { flex: 1 1 100%; }
	}
</style>
