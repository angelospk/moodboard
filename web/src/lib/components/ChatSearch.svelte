<script lang="ts">
	import { t } from '#lib/i18n.js';
	import { onMount, untrack } from 'svelte';
	import { buildChatPrompt, chatLinks, type ChatPromptInput } from '#lib/chatlinks.js';

	// Opens a new ChatGPT or Claude chat with a message already typed in. The user writes what they
	// want first (or picks a suggestion); the message is shown and can be edited before the link opens.
	let { context, onclose }: { context: Omit<ChatPromptInput, 'want'>; onclose: () => void } = $props();

	let dialog = $state<HTMLDialogElement | null>(null);
	let want = $state('');
	let message = $state(untrack(() => buildChatPrompt({ ...context })));

	const suggestions = $derived([t('chat.s1'), t('chat.s2'), t('chat.s3'), t('chat.s4')]);
	const links = $derived(chatLinks(message));
	const ready = $derived(want.trim() !== '');

	onMount(() => {
		if (dialog && !dialog.open) dialog.showModal();
	});

	function setWant(v: string) {
		want = v;
		// The message follows what the user wants. A hand edit of the message is kept until they change this.
		message = buildChatPrompt({ ...context, want: v });
	}

	function onDialogClick(e: MouseEvent) {
		if (e.target === dialog) onclose();
	}
</script>

<dialog bind:this={dialog} oncancel={(e) => { e.preventDefault(); onclose(); }} onclick={onDialogClick}>
	<div class="box">
		<div class="top">
			<h2>{t('chat.title')}</h2>
			<button class="x" type="button" onclick={onclose} aria-label={t('common.close')}>×</button>
		</div>

		<label class="field">
			<span class="lbl">{t('chat.want')}</span>
			<textarea
				rows="2"
				value={want}
				oninput={(e) => setWant(e.currentTarget.value)}
				placeholder={t('chat.wantPlaceholder')}
			></textarea>
		</label>
		<div class="chips" role="group" aria-label={t('chat.want')}>
			{#each suggestions as s (s)}
				<button type="button" class={['chip', want === s && 'on']} onclick={() => setWant(s)}>{s}</button>
			{/each}
		</div>

		<label class="field">
			<span class="lbl">{t('chat.preview')}</span>
			<textarea rows="8" bind:value={message} maxlength="1500"></textarea>
		</label>
		<p class="note">{t('chat.attach')}</p>

		<div class="row">
			{#if ready}
				<a class="btn primary" href={links.chatgpt} target="_blank" rel="noopener noreferrer">{t('chat.openGpt')}</a>
				<a class="btn primary" href={links.claude} target="_blank" rel="noopener noreferrer">{t('chat.openClaude')}</a>
			{:else}
				<button class="btn" type="button" disabled>{t('chat.openGpt')}</button>
				<button class="btn" type="button" disabled>{t('chat.openClaude')}</button>
			{/if}
		</div>
	</div>
</dialog>

<style>
	dialog {
		border: 1px solid var(--line-strong, var(--line));
		border-radius: 12px;
		padding: 0;
		width: min(560px, calc(100vw - 24px));
		background: var(--surface);
		color: var(--text);
	}
	dialog::backdrop {
		background: rgb(0 0 0 / 0.45);
	}
	.box {
		display: grid;
		gap: 12px;
		padding: 18px;
	}
	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	h2 {
		margin: 0;
		font-family: var(--font-serif);
		font-size: 1.1rem;
	}
	.x {
		border: 0;
		background: none;
		font-size: 22px;
		line-height: 1;
		padding: 2px 8px;
	}
	.field {
		display: grid;
		gap: 6px;
	}
	.lbl {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--muted);
	}
	textarea {
		width: 100%;
		resize: vertical;
		font-size: 14px;
		line-height: 1.45;
	}
	.note {
		margin: 0;
		font-size: 12.5px;
		color: var(--muted);
	}
	.row {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	.btn:disabled {
		opacity: 0.55;
		cursor: default;
	}
	a.btn {
		text-decoration: none;
	}
</style>
