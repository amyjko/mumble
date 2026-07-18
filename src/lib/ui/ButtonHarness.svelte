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
		onclick?: ((event: MouseEvent) => void) | undefined;
	}

	let { text, variant, shape, pressed, disabled, label, onclick }: Props = $props();
</script>

<Button {variant} {shape} {pressed} {disabled} {label} {onclick}>{text}</Button>
