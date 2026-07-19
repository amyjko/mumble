<script lang="ts">
	import Button from './Button.svelte';

	/**
	 * Test-only wrapper. Button takes its content as a snippet, which a test
	 * cannot pass as a plain prop — this supplies one from a string so
	 * Button.svelte.spec.ts can exercise the real component. Imported solely by
	 * that spec; nothing in the app references it.
	 */

	interface Props {
		text: string;
		variant?: 'secondary' | 'primary' | 'chrome' | undefined;
		shape?: 'text' | 'icon' | undefined;
		pressed?: boolean | undefined;
		disabled?: boolean | undefined;
		label?: string | undefined;
		tooltip?: string | null | undefined;
		/** Inline style on a wrapper, so a test can park the button at a screen edge. */
		wrapperStyle?: string | undefined;
		onclick?: ((event: MouseEvent) => void) | undefined;
	}

	let { text, variant, shape, pressed, disabled, label, tooltip, wrapperStyle, onclick }: Props = $props();
</script>

<div style={wrapperStyle}>
	<Button {variant} {shape} {pressed} {disabled} {label} {tooltip} {onclick}>{text}</Button>
</div>
