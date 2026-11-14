<script lang="ts">
	import { t, tn } from '#lib/i18n.js';
	import { cleanSourceProject, SOURCE_PROJECT_MAX, type SourceProjectSuggestion } from '#lib/sourceProjects.js';
	import { hostOf } from '#lib/sources.js';
	import type { Inspiration } from '#lib/types.js';

	// Images without a source project that were saved from the same web page. Only offers: the user
	// edits the name and presses «Ορισμός»; nothing is applied by itself.
	interface Props {
		suggestions: SourceProjectSuggestion[];
		byId: Map<string, Inspiration>;
		urls: Record<string, string>;
		names: string[];
		busy: boolean;
		onapply: (ids: string[], name: string) => void;
		ondismiss: (key: string) => void;
	}
	let { suggestions, byId, urls, names, busy, onapply, ondismiss }: Props = $props();

	const SHOWN = 2;
	const THUMBS = 6;
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

{#if suggestions.length}
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
				</div>
			</form>
		{/each}
		{#if suggestions.length > SHOWN}
			<button type="button" class="btn ghost toggle" onclick={() => (all = !all)}>
				{all ? t('sp.suggest.less') : t('sp.suggest.more', { n: suggestions.length - SHOWN })}
			</button>
		{/if}
	</section>
{/if}

<style>
	.sugs { display: grid; gap: 10px; margin: 0 0 16px; }
	.sug {
		display: flex;
		gap: 14px;
		align-items: flex-start;
		padding: 12px;
		background: var(--sunk);
		border: 1px solid var(--line);
		border-radius: var(--r-ctl);
	}
	.thumbs { display: flex; gap: 4px; flex: none; max-width: 40%; flex-wrap: wrap; }
	.thumbs img, .thumbs .ph, .thumbs .more {
		width: 44px;
		height: 44px;
		border-radius: var(--r-img);
		object-fit: cover;
		background: var(--line);
	}
	.thumbs .more { display: grid; place-items: center; font-size: 12.5px; color: var(--muted); background: none; }
	.what { display: grid; gap: 6px; min-width: 0; flex: 1; }
	.q { margin: 0; font-size: 14px; }
	.page { font-size: 12.5px; color: var(--muted); overflow-wrap: anywhere; }
	.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
	.row input { flex: 1 1 200px; min-width: 0; }
	.toggle { justify-self: start; }
	@media (max-width: 600px) {
		.sug { flex-direction: column; }
		.thumbs { max-width: 100%; }
	}
</style>
