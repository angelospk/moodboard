<script lang="ts">
	// STUB: worker B implements. Contract below is fixed.
	interface Props {
		/** Chosen tags (bindable). Always lowercase, trimmed, unique. */
		tags: string[];
		/** Past tags of the user, most used first. */
		suggestions?: string[];
		placeholder?: string;
		/** id for the text input, so a <label for> can point at it. */
		id?: string;
	}
	let { tags = $bindable([]), suggestions = [], placeholder = 'ξύλο, φως…', id }: Props = $props();
</script>

<input {id} {placeholder} value={tags.join(', ')} />
