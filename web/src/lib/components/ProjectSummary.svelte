<script lang="ts">
	import { t } from '#lib/i18n.js';
	import type PocketBase from 'pocketbase';
	import { untrack } from 'svelte';
	import { setProjectDescription } from '#lib/inspirations.js';
	import { composeDraft, draftSummary, SmartSearchError, type DraftPart } from '#lib/semantic.js';

	// The description of a project. The owner writes it; the AI drafts it only when the button is pressed.
	// A draft has places where the AI is unsure and offers 2-3 readings: the owner picks one at each place,
	// then edits the text. Nothing is saved until the owner uses the text or leaves the field.
	let {
		pb,
		projectId,
		description,
		aiAllowed,
		onsaved
	}: { pb: PocketBase; projectId: string; description: string; aiAllowed: boolean; onsaved: () => void } = $props();

	let text = $state(untrack(() => description));
	let savedText = $state(untrack(() => description));
	let status = $state<'idle' | 'saving' | 'saved' | 'error'>('idle');

	let drafting = $state(false);
	let error = $state('');
	let parts = $state<DraftPart[] | null>(null);
	let picks = $state<Record<number, number>>({});

	// The text of the last save request: a change back to the saved text while a save runs must still go out.
	let sentText = untrack(() => description);

	async function save(next: string) {
		if (next === sentText) return;
		sentText = next;
		status = 'saving';
		try {
			await setProjectDescription(pb, projectId, next);
			if (sentText !== next) return; // a newer save follows and sets the state
			savedText = next;
			status = 'saved';
			onsaved();
		} catch {
			if (sentText !== next) return; // a newer save follows and sets the state
			sentText = savedText;
			status = 'error';
		}
	}

	async function draft() {
		if (drafting) return;
		drafting = true;
		error = '';
		try {
			const out = await draftSummary(pb, projectId);
			if (!out.enabled) {
				error = t('summary.off');
				return;
			}
			parts = out.parts;
			picks = {};
		} catch (e) {
			error = e instanceof SmartSearchError && e.kind === 'limit' ? t('summary.limit') : t('summary.failed');
		} finally {
			drafting = false;
		}
	}

	function use() {
		if (!parts) return;
		text = composeDraft(parts, picks);
		parts = null;
		void save(text);
	}

	function autogrow(el: HTMLTextAreaElement) {
		void text;
		el.style.height = 'auto';
		el.style.height = `${el.scrollHeight + 2}px`;
	}
</script>

<section class="summary" aria-label={t('summary.title')}>
	<div class="head">
		<h3>{t('summary.title')}</h3>
		<span class="state" aria-live="polite">
			{#if status === 'saving'}…{:else if status === 'saved'}{t('summary.saved')}{:else if status === 'error'}<span class="err">{t('summary.saveFailed')}</span>{/if}
		</span>
		<span class="grow"></span>
		{#if aiAllowed && !parts}
			<button class="btn" type="button" disabled={drafting} onclick={draft} title={t('summary.sendNote')}>
				{drafting ? t('summary.drafting') : text.trim() ? t('summary.redo') : t('summary.draft')}
			</button>
		{/if}
	</div>

	{#if parts}
		<div class="draft" role="group" aria-label={t('summary.pick')}>
			<p class="pick">{t('summary.pick')}</p>
			<p class="body">
				{#each parts as part, i (i)}
					{#if part.choices?.length}
						<span class="choices" role="radiogroup">
							{#each part.choices as c, k (k)}
								<button
									type="button"
									role="radio"
									aria-checked={(picks[i] ?? 0) === k}
									class={['opt', (picks[i] ?? 0) === k && 'on']}
									onclick={() => (picks[i] = k)}>{c}</button
								>
							{/each}
						</span>
					{:else}{part.text}{/if}
				{/each}
			</p>
			<div class="row">
				<button class="btn primary" type="button" onclick={use}>{t('summary.use')}</button>
				<button class="btn" type="button" disabled={drafting} onclick={draft}>{drafting ? t('summary.drafting') : t('summary.redo')}</button>
				<button class="btn ghost" type="button" onclick={() => (parts = null)}>{t('common.cancel')}</button>
			</div>
		</div>
	{/if}

	<textarea
		bind:value={text}
		{@attach autogrow}
		rows="2"
		maxlength="5000"
		placeholder={t('summary.placeholder')}
		aria-label={t('summary.title')}
		onblur={() => void save(text.trim())}
	></textarea>
	{#if error}<p class="err" role="alert">{error}</p>{/if}
</section>

<style>
	.summary {
		display: grid;
		gap: 8px;
		margin: 0 0 14px;
		max-width: 860px;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	h3 {
		margin: 0;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--muted);
	}
	.grow {
		flex: 1;
	}
	.state {
		font-size: 0.78rem;
		color: var(--muted);
	}
	.err {
		color: var(--accent);
		font-size: 0.82rem;
		margin: 0;
	}
	textarea {
		width: 100%;
		min-height: 56px;
		resize: none;
		overflow: hidden;
		font-size: 0.95rem;
		line-height: 1.5;
		background: var(--raised, var(--surface));
	}
	.draft {
		display: grid;
		gap: 8px;
		padding: 12px 14px;
		border: 1px solid var(--line-strong, var(--line));
		border-radius: var(--r-ctl);
		background: var(--accent-soft);
	}
	.pick {
		margin: 0;
		font-size: 0.78rem;
		color: var(--muted);
	}
	.body {
		margin: 0;
		font-size: 0.98rem;
		line-height: 2.1;
	}
	.choices {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 4px;
		vertical-align: baseline;
		margin: 0 2px;
	}
	.opt {
		padding: 1px 9px;
		border-radius: 999px;
		font: inherit;
		font-size: 0.9rem;
		line-height: 1.6;
		text-align: left;
		background: var(--surface);
		border: 1px dashed var(--line-strong, var(--line));
		color: var(--text);
	}
	.opt.on {
		background: var(--text);
		border: 1px solid var(--text);
		color: var(--bg);
	}
	.row {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
</style>
