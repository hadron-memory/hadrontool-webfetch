import { describe, expect, it } from 'vitest';
import { extractLinks, extractTitle, htmlToMarkdown, htmlToText } from './convert.js';

const PAGE = `<!doctype html>
<html>
<head><title>My &amp; Page</title><script>alert('xss')</script><style>.x{}</style></head>
<body>
  <h1>Heading</h1>
  <p>Some <strong>bold</strong> text with a <a href="/relative">relative link</a>.</p>
  <p><a href="https://other.example/abs">absolute</a> and <a href="javascript:alert(1)">bad scheme</a>
     and <a href="mailto:x@example.com">mail</a> and <a href="https://other.example/abs">duplicate</a>.</p>
  <script>document.write('never')</script>
</body>
</html>`;

describe('extractTitle', () => {
  it('extracts and entity-decodes the title from raw html', () => {
    expect(extractTitle(PAGE)).toBe('My & Page');
  });
  it('returns undefined when absent', () => {
    expect(extractTitle('<html><body>x</body></html>')).toBeUndefined();
  });
});

describe('htmlToMarkdown', () => {
  it('converts structure and strips scripts/styles', () => {
    const md = htmlToMarkdown(PAGE);
    expect(md).toContain('# Heading');
    expect(md).toContain('**bold**');
    expect(md).not.toContain('alert');
    expect(md).not.toContain('document.write');
    expect(md).not.toContain('My & Page'); // <title> must not leak into the body
  });
});

describe('htmlToText', () => {
  it('drops all tags and script content, collapses whitespace', () => {
    const text = htmlToText(PAGE);
    expect(text).toContain('Heading');
    expect(text).toContain('Some bold text');
    expect(text).not.toContain('<');
    expect(text).not.toContain('alert');
  });
});

describe('extractLinks', () => {
  it('absolutizes, filters non-http(s), and dedupes', () => {
    const links = extractLinks(PAGE, 'https://example.com/dir/page');
    const hrefs = links.map((l) => l.href);
    expect(hrefs).toContain('https://example.com/relative');
    expect(hrefs).toContain('https://other.example/abs');
    expect(hrefs.filter((h) => h === 'https://other.example/abs').length).toBe(1);
    expect(hrefs.some((h) => h.startsWith('javascript:'))).toBe(false);
    expect(hrefs.some((h) => h.startsWith('mailto:'))).toBe(false);
    const rel = links.find((l) => l.href === 'https://example.com/relative');
    expect(rel?.text).toBe('relative link');
  });
});
