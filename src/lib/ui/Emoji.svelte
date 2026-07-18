<script lang="ts">
	/**
	 * Every emoji in the product renders through here, so they all get
	 * --font-emoji (self-hosted Noto Color Emoji, COLRv1) and look identical
	 * across platforms. Previously only the avatar face carried the font, so
	 * the reaction picker, the raised hand, and the away badge silently fell
	 * back to the system set — the exact inconsistency the vendored font exists
	 * to prevent.
	 *
	 * Emoji are decorative by default: the meaning belongs in the surrounding
	 * control's accessible name, not in a glyph a screen reader would spell out.
	 * Pass `label` only when the glyph itself is the information.
	 */

	interface Props {
		glyph: string;
		/** Accessible name. Omit (the default) to hide the glyph from AT. */
		label?: string | undefined;
		/** Font size; defaults to inheriting from the surrounding control. */
		size?: string | undefined;
	}

	let { glyph, label, size }: Props = $props();
</script>

<span
	class="emoji"
	style:font-size={size}
	aria-hidden={label === undefined ? 'true' : undefined}
	aria-label={label}
	role={label === undefined ? undefined : 'img'}>{glyph}</span
>

<style>
	.emoji {
		font-family: var(--font-emoji);
		/* Emoji have their own vertical metrics; keep them from stretching the
		   line box of whatever control they sit in. */
		line-height: 1;
	}
</style>
