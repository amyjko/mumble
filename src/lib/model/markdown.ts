/**
 * A deliberately small, safe Markdown→HTML renderer for notes (UX-OBJ-2,
 * render side). Safety is structural, not bolted on: the input is
 * HTML-escaped FIRST, so no user markup can ever reach the DOM; only the tags
 * this file emits appear, and link hrefs are scheme-validated. That is why the
 * output is safe to pass to {@html} without a sanitizer dependency. Pure and
 * node-tested — the XSS-rejection cases are its mutation test. Not full
 * CommonMark: headings, bold/italic, inline + fenced code, links, lists,
 * blockquotes, paragraphs.
 */

function escapeHtml(s: string): string {
	return s
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

/** Only http(s), mailto, and same-page anchors may become links. */
function safeHref(raw: string): string | null {
	const url = raw.trim();
	if (/^(https?:\/\/|mailto:)/i.test(url)) return url;
	if (url.startsWith('#') || url.startsWith('/')) return url;
	return null;
}

/** Inline spans, applied to already-escaped text. */
function inline(escaped: string): string {
	let out = escaped;
	// Inline code first, so its contents aren't further transformed.
	out = out.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`);
	// Links: [text](href) — text stays escaped; href is validated.
	out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, text: string, href: string) => {
		const safe = safeHref(href);
		if (safe === null) return whole;
		return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
	});
	out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
	out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
	out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
	out = out.replace(/(^|[^_])_([^_\s][^_]*)_/g, '$1<em>$2</em>');
	return out;
}

export function renderMarkdown(md: string): string {
	const lines = md.replace(/\r\n/g, '\n').split('\n');
	const html: string[] = [];
	let i = 0;
	let listKind: 'ul' | 'ol' | null = null;

	const closeList = (): void => {
		if (listKind !== null) {
			html.push(`</${listKind}>`);
			listKind = null;
		}
	};

	while (i < lines.length) {
		const line = lines[i] ?? '';

		// Fenced code block.
		if (line.startsWith('```')) {
			closeList();
			const body: string[] = [];
			i++;
			while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
				body.push(lines[i] ?? '');
				i++;
			}
			i++; // consume closing fence
			html.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
			continue;
		}

		const heading = /^(#{1,3})\s+(.*)$/.exec(line);
		if (heading) {
			closeList();
			const level = heading[1]?.length ?? 1;
			html.push(`<h${String(level)}>${inline(escapeHtml(heading[2] ?? ''))}</h${String(level)}>`);
			i++;
			continue;
		}

		const ordered = /^\d+\.\s+(.*)$/.exec(line);
		const unordered = /^[-*]\s+(.*)$/.exec(line);
		if (ordered ?? unordered) {
			const kind = ordered ? 'ol' : 'ul';
			if (listKind !== kind) {
				closeList();
				html.push(`<${kind}>`);
				listKind = kind;
			}
			const item = (ordered?.[1] ?? unordered?.[1]) ?? '';
			html.push(`<li>${inline(escapeHtml(item))}</li>`);
			i++;
			continue;
		}

		if (line.startsWith('>')) {
			closeList();
			html.push(`<blockquote>${inline(escapeHtml(line.replace(/^>\s?/, '')))}</blockquote>`);
			i++;
			continue;
		}

		if (line.trim() === '') {
			closeList();
			i++;
			continue;
		}

		// Paragraph: gather consecutive non-blank, non-special lines.
		closeList();
		const para: string[] = [line];
		i++;
		while (i < lines.length) {
			const next = lines[i] ?? '';
			if (next.trim() === '' || /^(#{1,3}\s|```|>|[-*]\s|\d+\.\s)/.test(next)) break;
			para.push(next);
			i++;
		}
		html.push(`<p>${inline(escapeHtml(para.join('\n'))).replaceAll('\n', '<br>')}</p>`);
	}

	closeList();
	return html.join('');
}
