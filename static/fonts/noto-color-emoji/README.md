# Noto Color Emoji (vendored)

COLRv1 woff2 subset chunks of Noto Color Emoji, fetched from Google Fonts
(fonts.gstatic.com, notocoloremoji v39) with a Chromium User-Agent so the
COLRv1 build is delivered. Vendored here because:

- The `@fontsource/noto-color-emoji` npm package ships the **OT-SVG** build,
  which Chromium cannot render (blank glyphs); no COLRv1 build exists on npm.
- Self-hosting is required — the Workers CSP forbids external font hosts.

Served as static assets (not in the worker script; does not count against the
3 MB worker-script limit). `@font-face` CSS: `src/lib/theme/noto-color-emoji.css`.

Licensed under the SIL Open Font License 1.1 — see LICENSE.
