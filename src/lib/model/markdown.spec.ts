import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

describe('renderMarkdown (UX-OBJ-2) — safe subset', () => {
	it('renders headings, emphasis, code, and links', () => {
		expect(renderMarkdown('# Title')).toBe('<h1>Title</h1>');
		expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>');
		expect(renderMarkdown('_em_')).toContain('<em>em</em>');
		expect(renderMarkdown('`x = 1`')).toContain('<code>x = 1</code>');
		expect(renderMarkdown('[site](https://example.com)')).toContain(
			'<a href="https://example.com" target="_blank" rel="noopener noreferrer">site</a>'
		);
	});

	it('renders lists and blockquotes', () => {
		expect(renderMarkdown('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
		expect(renderMarkdown('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
		expect(renderMarkdown('> quote')).toBe('<blockquote>quote</blockquote>');
	});

	it('fenced code is escaped, not interpreted', () => {
		const out = renderMarkdown('```\n<script>alert(1)</script>\n```');
		expect(out).toContain('<pre><code>');
		expect(out).not.toContain('<script>');
		expect(out).toContain('&lt;script&gt;');
	});

	// The mutation test: raw HTML and dangerous URLs must never reach the DOM.
	it('REJECTS injected HTML and unsafe link schemes', () => {
		expect(renderMarkdown('<img src=x onerror=alert(1)>')).not.toContain('<img');
		expect(renderMarkdown('<script>alert(1)</script>')).not.toContain('<script>');
		// javascript: link is not turned into an anchor — it stays inert text,
		// which is safe (no href, not clickable, nothing executes).
		const js = renderMarkdown('[x](javascript:alert(1))');
		expect(js).not.toContain('<a ');
		expect(js).not.toContain('href');
		// A quote/attr break-out attempt in an href never becomes an anchor, and
		// its quotes are escaped so it cannot form an attribute.
		const breakout = renderMarkdown('[x](https://a" onmouseover="evil)');
		expect(breakout).not.toContain('<a ');
		expect(breakout).not.toContain('onmouseover="');
	});

	it('empty input yields empty output', () => {
		expect(renderMarkdown('')).toBe('');
		expect(renderMarkdown('   \n  ')).toBe('');
	});
});
