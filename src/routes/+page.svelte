<script lang="ts">
	import { resolve } from '$app/paths';

	/**
	 * The landing page.
	 *
	 * Its argument is the product's: a call is not a transcript. Everything
	 * listed here is something you can only do because the room is a PLACE —
	 * where you sit, what you point at, what you put down and leave for someone
	 * else. So the features are framed as things people do rather than as a
	 * capability inventory; "objects can be created on a shared canvas" says
	 * nothing about why anyone would want that.
	 *
	 * The room-naming form used to live here and now sits at /new, which is
	 * where account creation will intercept (AR-AUTH-1). One prominent link,
	 * one destination to guard.
	 */

	const features = [
		{
			title: 'Sit somewhere',
			body: 'Move your face around the room. Pull up beside someone, gather in a circle, or drift to the edge — where you are says something before you speak.'
		},
		{
			title: 'Put things down',
			body: 'Notes, timers, chats, and sketches live on the canvas, not in a sidebar. Anyone can move them, and they stay where you left them.'
		},
		{
			title: 'React without interrupting',
			body: 'Applaud, laugh, raise a hand, or step away. The room sees it on your face, so agreeing costs nobody the floor.'
		},
		{
			title: 'Rearrange the room',
			body: 'Save a layout and switch everyone to it mid-meeting — a circle for the check-in, a stage for the demo.'
		}
	];
</script>

<svelte:head>
	<title>mumble — communication is more than words</title>
	<meta
		name="description"
		content="A meeting room you can arrange: sit where you like, put things down, and react without interrupting."
	/>
</svelte:head>

<main>
	<header>
		<p class="wordmark">mumble</p>
		<h1>Communication is more than words.</h1>
		<p class="lede">
			Most meeting tools give you a grid of faces and a chat box. mumble gives you a room — one you
			can move around in, put things down in, and rearrange when the conversation changes.
		</p>
		<!--
			The one prominent action. A link, not a Button: it navigates, and once
			auth exists it will navigate somewhere that may redirect to sign-up
			first. Button is for in-app controls that DO something.
		-->
		<a class="cta" href={resolve('/new')}>Make a room</a>
	</header>

	<h2 class="sr-only">What you can do</h2>
	<ul class="features">
		{#each features as feature (feature.title)}
			<li>
				<h3>{feature.title}</h3>
				<p>{feature.body}</p>
			</li>
		{/each}
	</ul>

	<footer>
		<!-- The common case is being INVITED, so say plainly that following a
		     link costs nothing. Deliberately not repeated under the button
		     above: making a room is the thing that will need an account. -->
		<p>Been sent a link? Open it and you are in — no download, no account.</p>
	</footer>
</main>

<style>
	main {
		max-width: 62ch;
		margin: 0 auto;
		padding: max(8vh, var(--space-8)) var(--space-4) var(--space-8);
		font: var(--text-md) / var(--leading) var(--font-ui);
		color: var(--text);
	}
	.wordmark {
		margin: 0;
		font-size: var(--text-lg);
		font-weight: 600;
		letter-spacing: 0.02em;
		color: var(--text-muted);
	}
	h1 {
		/* Scales with the viewport but never below the xl step, so the claim
		   still reads as the headline on a phone. */
		font-size: clamp(var(--text-xl), 7vw, var(--text-3xl));
		line-height: 1.15;
		margin: var(--space-4) 0;
		text-wrap: balance;
	}
	.lede {
		font-size: var(--text-lg);
		color: var(--text-muted);
		margin: 0 0 var(--space-6);
		max-width: 54ch;
	}
	.cta {
		display: inline-block;
		padding: var(--space-3) var(--space-6);
		border-radius: var(--radius-md);
		background: var(--accent);
		color: var(--accent-contrast);
		font-size: var(--text-lg);
		font-weight: 600;
		text-decoration: none;
	}
	.cta:hover {
		/* No new colour: the same accent, dimmed, so a hover state cannot drift
		   from the token it is derived from. */
		opacity: 0.9;
	}
	.features {
		list-style: none;
		margin: var(--space-8) 0 0;
		padding: 0;
		display: grid;
		gap: var(--space-6);
		/* Two columns when there is room, one when there is not — no breakpoint
		   to keep in sync with a hard-coded width. */
		grid-template-columns: repeat(auto-fit, minmax(24ch, 1fr));
	}
	.features h3 {
		margin: 0 0 var(--space-1);
		font-size: var(--text-lg);
	}
	.features p {
		margin: 0;
		color: var(--text-muted);
	}
	footer {
		margin-top: var(--space-8);
		padding-top: var(--space-6);
		border-top: 1px solid var(--border);
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
	footer p {
		margin: 0;
	}
</style>
