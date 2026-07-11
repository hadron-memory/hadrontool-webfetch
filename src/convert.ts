/**
 * HTML normalization for fetch-url — sanitize first, then convert, so
 * nothing executable survives into content that lands in an LLM context or
 * a memory node. The sanitize + turndown pipeline mirrors hadrontool-pdf's
 * html-to-markdown import endpoint (spec cor:cnv:010:01); conversion is
 * lossy by design.
 */

import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import sanitizeHtml from 'sanitize-html';

const MAX_TITLE_CHARS = 300;
export const MAX_LINKS = 500;

/**
 * The structural tags we keep before converting to Markdown. Anything not in
 * this list is dropped (its text is preserved by sanitize-html unless it is a
 * `nonTextTags` member below). Presentational wrappers (span/div) are kept so
 * their inline content survives, but their attributes are stripped.
 */
const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'a', 'ul', 'ol', 'li', 'blockquote',
  'pre', 'code', 'em', 'strong', 'b', 'i', 'del', 's', 'ins', 'sub', 'sup',
  'hr', 'br', 'img', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'span', 'div',
];

// Remove these tags *and their contents* entirely (not just the wrapper).
// `title` is included so the <title> text does not leak into the body.
const NON_TEXT_TAGS = ['script', 'style', 'noscript', 'textarea', 'title'];

// A single reusable converter — turndown holds no per-call state.
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '_',
  linkStyle: 'inlined',
});
turndown.use(gfm); // GFM tables, strikethrough, task lists

// Named entities that commonly appear in titles and link text. Not
// exhaustive — an exotic entity degrades to its raw form, which is
// acceptable in extracted text.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#?\w+);/g, (whole, ref: string) =>
    Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, ref) ? NAMED_ENTITIES[ref] : whole,
  );
}

/** Extract the document title from RAW html (sanitize drops <title>). */
export function extractTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return undefined;
  const title = decodeEntities(m[1].replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
  return title ? title.slice(0, MAX_TITLE_CHARS) : undefined;
}

/**
 * Sanitize HTML down to the structural subset above. Scripts, styles, event
 * handlers, and non-http(s) URLs are removed.
 */
export function sanitizePage(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'title'],
      img: ['src', 'alt', 'title'],
    },
    // Keep only http(s) link targets; drop javascript:, mailto:, data:, file:, etc.
    allowedSchemes: ['http', 'https'],
    nonTextTags: NON_TEXT_TAGS,
  });
}

/** Convert an HTML page to Markdown (sanitized first). */
export function htmlToMarkdown(html: string): string {
  return turndown
    .turndown(sanitizePage(html))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Reduce an HTML page to plain text (all tags dropped, whitespace collapsed). */
export function htmlToText(html: string): string {
  const textOnly = sanitizeHtml(html, {
    allowedTags: [],
    allowedAttributes: {},
    nonTextTags: NON_TEXT_TAGS,
  });
  return decodeEntities(textOnly)
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n\n')
    .trim();
}

export interface PageLink {
  text: string;
  href: string;
}

/**
 * Extract the link graph of an HTML page: absolutized against the final URL,
 * http(s) only, deduped by href, capped at MAX_LINKS.
 */
export function extractLinks(html: string, baseUrl: string): PageLink[] {
  // Sanitize down to anchors only, so the regex below never sees script
  // content or event handlers.
  const anchorsOnly = sanitizeHtml(html, {
    allowedTags: ['a'],
    allowedAttributes: { a: ['href'] },
    allowedSchemes: ['http', 'https'],
    nonTextTags: NON_TEXT_TAGS,
  });
  const links: PageLink[] = [];
  const seen = new Set<string>();
  const re = /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (let m = re.exec(anchorsOnly); m !== null; m = re.exec(anchorsOnly)) {
    if (links.length >= MAX_LINKS) break;
    const rawHref = decodeEntities(m[1]).trim();
    if (!rawHref) continue;
    let href: string;
    try {
      const resolved = new URL(rawHref, baseUrl);
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
      href = resolved.toString();
    } catch {
      continue;
    }
    if (seen.has(href)) continue;
    seen.add(href);
    const text = decodeEntities(m[2].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    links.push({ text, href });
  }
  return links;
}
