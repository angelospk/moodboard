<script lang="ts">
	import { t } from '#lib/i18n.js';
	// «Κοινοποίηση»: make a board public at /s/<project id> and pick what visitors see. Every change
	// saves at once; on an error the switch goes back.
	import type PocketBase from 'pocketbase';
	import { getShare, publicLink, saveShare, type ShareSettings } from '#lib/share.js';
	import Icon from './Icon.svelte';

	let { pb, projectId }: { pb: PocketBase; projectId: string } = $props();

	const OPTIONS: { key: Exclude<keyof ShareSettings, 'public'>; label: string }[] = [
		{ key: 'notes', label: t('share.optNotes') },
		{ key: 'regions', label: t('share.optRegions') },
		{ key: 'tags', label: t('share.optTags') },
		{ key: 'sources', label: t('share.optSources') }
	];

	let open = $state(false);
	let s = $state<ShareSettings | null>(null);
	let busy = $state(false);
	let msg = $state('');
	const link = $derived(publicLink(projectId));

	async function load() {
		busy = true;
		msg = '';
		try {
			s = await getShare(pb, projectId);
		} catch (e) {
			msg = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	function toggle() {
		open = !open;
		if (open && !s) void load();
	}

	async function change(key: keyof ShareSettings, value: boolean) {
		if (!s || busy) return;
		const before = s;
		s = { ...s, [key]: value };
		msg = '';
		busy = true;
		try {
			await saveShare(pb, projectId, { [key]: value });
			if (key === 'public' && value) await copy();
		} catch (e) {
			s = before;
			msg = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	async function copy() {
		try {
			await navigator.clipboard.writeText(link);
			msg = t('share.copied');
		} catch {
			msg = t('share.copyManual');
		}
	}
</script>

<div class="share">
	<button type="button" class="btn ghost" class:on={s?.public} aria-haspopup="dialog" aria-expanded={open} onclick={toggle} title={t('common.shareTitle')}>
		<Icon name="open" size={15} /> <span class="lbl">{s?.public ? t('share.public') : t('common.shareTitle')}</span>
	</button>
	{#if open}
		<div class="scrim" role="presentation" onpointerdown={() => (open = false)}></div>
		<div class="pop" role="dialog" aria-label={t('common.shareTitle')}>
			{#if !s}
				{#if busy}
					<p class="hint">{t('common.loading')}</p>
				{:else}
					<button type="button" class="btn" onclick={load}>{t('share.retry')}</button>
				{/if}
			{:else}
				<label class="switch">
					<input type="checkbox" checked={s.public} disabled={busy} onchange={(e) => change('public', e.currentTarget.checked)} />
					<span>
						<b>{t('share.publicBoard')}</b>
						<small>{t('share.publicHint')}</small>
					</span>
				</label>
				{#if s.public}
					<div class="row">
						<input class="url" readonly value={link} aria-label={t('share.link')} onfocus={(e) => e.currentTarget.select()} />
						<button type="button" class="btn" onclick={copy}><Icon name="copy" size={14} /> {t('common.copy')}</button>
					</div>
				{/if}
				<fieldset>
					<legend>{t('share.whatShows')}</legend>
					{#each OPTIONS as o (o.key)}
						<label class="opt">
							<input type="checkbox" checked={s[o.key]} disabled={busy} onchange={(e) => change(o.key, e.currentTarget.checked)} />
							{o.label}
						</label>
					{/each}
				</fieldset>
			{/if}
			{#if msg}<p class="msg" role="status">{msg}</p>{/if}
		</div>
	{/if}
</div>

<style>
	.share {
		position: relative;
	}
	.on {
		color: var(--accent);
	}
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 30;
	}
	.pop {
		position: absolute;
		right: 0;
		top: calc(100% + 8px);
		z-index: 31;
		width: min(360px, calc(100vw - 32px));
		padding: 14px;
		background: var(--raised);
		border-radius: var(--r-panel);
		box-shadow: 0 12px 32px -12px rgb(0 0 0 / 0.3), 0 0 0 1px var(--line);
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.switch {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		cursor: pointer;
	}
	.switch span {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.switch b {
		font-weight: 600;
	}
	small,
	.hint,
	.msg {
		margin: 0;
		font-size: 12.5px;
		color: var(--muted);
	}
	.msg {
		color: var(--text);
	}
	input[type='checkbox'] {
		accent-color: var(--accent);
		width: 16px;
		height: 16px;
		margin: 2px 0 0;
	}
	.row {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.url {
		flex: 1;
		min-width: 0;
		font: inherit;
		font-size: 12.5px;
		padding: 6px 8px;
		border: 1px solid var(--line-strong);
		border-radius: var(--r-ctl);
		background: var(--surface);
		color: var(--text);
	}
	fieldset {
		border: 0;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	legend {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--muted);
		padding: 0 0 4px;
	}
	.opt {
		display: flex;
		gap: 8px;
		align-items: center;
		min-height: 32px;
		cursor: pointer;
	}
	@media (max-width: 900px) {
		.lbl {
			display: none;
		}
	}
	@media (max-width: 640px) {
		.pop {
			position: fixed;
			top: 64px;
			left: 16px;
			right: 16px;
			width: auto;
		}
	}
</style>
