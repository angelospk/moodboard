<script lang="ts">
	// Pick the app language. The choice is saved and the page reloads (see lib/i18n.ts).
	import { LOCALES, LOCALE_NAMES, getLocale, setLocale, t, type Locale } from '#lib/i18n.js';
</script>

<select
	class="lang"
	value={getLocale()}
	aria-label={t('lang.label')}
	title={t('lang.label')}
	onchange={(e) => setLocale(e.currentTarget.value as Locale)}
>
	{#each LOCALES as l (l)}<option value={l}>{LOCALE_NAMES[l]}</option>{/each}
</select>

<style>
	.lang {
		font-size: 0.85rem;
		padding: 6px 8px;
		border: 1px solid var(--line);
		border-radius: var(--r-ctl);
		background: var(--surface);
		color: var(--text);
	}
</style>
