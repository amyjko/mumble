<script lang="ts">
	/**
	 * The one text input (AR-STYLE-1). Wraps the control in a real <label>, so
	 * the accessible name comes from markup rather than a hand-written
	 * aria-label at each of the five sites that used to style inputs ad hoc.
	 *
	 * `labelHidden` keeps the name for assistive tech while dropping the visible
	 * caption, for places where surrounding context already says what the field
	 * is (a chat compose row, a room-name field under a heading).
	 */

	interface Props {
		value?: string | undefined;
		/** Visible caption AND accessible name. Never omit it. */
		label: string;
		placeholder?: string | undefined;
		multiline?: boolean | undefined;
		labelHidden?: boolean | undefined;
		/** Marks the control as object content so a drag doesn't start on it. */
		editableTarget?: boolean | undefined;
		rows?: number | undefined;
		/**
		 * Form-submission and input-mode props, added for the sign-in form.
		 * `name` matters most: without it a native form submits nothing, and
		 * the login action works before hydration precisely so it does not
		 * depend on JavaScript having loaded.
		 */
		type?: 'text' | 'email' | undefined;
		name?: string | undefined;
		autocomplete?: 'email' | 'off' | undefined;
		required?: boolean | undefined;
		onkeydown?: ((event: KeyboardEvent) => void) | undefined;
		/**
		 * Fired on blur with the CURRENT VALUE, not the event. Handing back a
		 * typed string keeps callers out of `event.currentTarget`, which arrives
		 * untyped in a Svelte template and lands squarely on the no-unsafe-*
		 * rules — the sort of boundary the TypeScript norms exist to guard.
		 */
		oncommit?: ((value: string) => void) | undefined;
		onpointerdown?: ((event: PointerEvent) => void) | undefined;
	}

	let {
		value = $bindable(''),
		label,
		placeholder,
		multiline = false,
		labelHidden = false,
		editableTarget = false,
		rows,
		type = 'text',
		name,
		autocomplete,
		required = false,
		onkeydown,
		oncommit,
		onpointerdown
	}: Props = $props();

	function handleBlur(): void {
		oncommit?.(value);
	}
</script>

<label class="field">
	<span class:sr-only={labelHidden}>{label}</span>
	{#if multiline}
		<textarea
			bind:value
			{placeholder}
			{rows}
			{onkeydown}
			onblur={handleBlur}
			{onpointerdown}
			data-editable={editableTarget ? '' : undefined}
		></textarea>
	{:else}
		<input
			bind:value
			{type}
			{name}
			{autocomplete}
			{required}
			{placeholder}
			{onkeydown}
			onblur={handleBlur}
			{onpointerdown}
			data-editable={editableTarget ? '' : undefined}
		/>
	{/if}
</label>

<style>
	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	input,
	textarea {
		min-height: var(--control-height);
		padding: var(--space-1) var(--space-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		color: var(--text);
		/* Longhand, never the `font:` shorthand — see Button.svelte. */
		font-family: var(--font-ui);
		font-size: var(--text-sm);
		line-height: var(--leading);
	}
	textarea {
		resize: vertical;
	}
</style>
