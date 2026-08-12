/**
 * Rich-lite (DECISIONS C3/R3): the app's bounded rich-text subset. WYSIWYG is
 * the editing UX (public/js/rich-editor.js), rich-lite is the allowed output.
 *
 * Allowed: <strong>/<b>, <em>/<i>, <a href> (https/http/mailto only),
 * <ul>/<ol>/<li>, <h2>/<h3>, <p>, <br>. No attributes besides a[href] — no
 * styles, no classes, no images. `sanitizeRich` is the server-side gate; the
 * editor island mirrors the same whitelist for paste handling, but the server
 * output is what ships.
 */

const ALLOWED = new Set(['strong', 'b', 'em', 'i', 'a', 'ul', 'ol', 'li', 'h2', 'h3', 'p', 'br']);

/** Tags whose entire content is dropped, not just the tags themselves. */
const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'head',
  'title',
  'iframe',
  'noscript',
  'object',
  'embed',
  'svg',
  'math',
  'template',
  'select',
  'textarea',
]);

/** True when a body contains rich-lite markup (vs. legacy plain text). */
export function looksRich(s: string): boolean {
  return /<(p|ul|ol|h2|h3|a|strong|em|b|i|br|li)[\s>/]/i.test(s || '');
}

/** Escape text content, leaving already-encoded entities alone. */
function escapeText(s: string): string {
  return s
    .replace(/&(?![a-zA-Z][a-zA-Z0-9]{1,15};|#\d{1,7};|#x[0-9a-fA-F]{1,6};)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;');
}

/** Pull a safe href out of a raw attribute string; null unless https/http/mailto. */
function safeHref(attrs: string): string | null {
  const m = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  if (!m) return null;
  const href = (m[1] ?? m[2] ?? m[3] ?? '').trim();
  return /^(https?:\/\/|mailto:)/i.test(href) ? href : null;
}

/** Comments/CDATA/doctype/PI, tags, text runs, stray `<`. */
const TOKEN = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<\/?[a-zA-Z][^>]*>|<[!?][^>]*>|[^<]+|<+/g;
const TAG = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)([\s\S]*?)>$/;

/**
 * Strip everything outside the rich-lite subset. Disallowed tags are removed
 * but keep their text; script/style-class tags are dropped with their content;
 * attributes are stripped except a valid a[href]. Output is balanced.
 */
export function sanitizeRich(html: string): string {
  let out = '';
  const stack: string[] = [];
  let dropTag: string | null = null;
  let dropDepth = 0;

  for (const token of String(html ?? '').match(TOKEN) ?? []) {
    const tagMatch = token[0] === '<' ? TAG.exec(token) : null;
    if (!tagMatch) {
      if (token[0] === '<') continue; // comment/CDATA/doctype/PI/stray <
      if (!dropTag) out += escapeText(token);
      continue;
    }

    // Note: a trailing `/` on a non-void tag is ignored, as browsers do.
    const closing = tagMatch[1] === '/';
    const tag = tagMatch[2].toLowerCase();
    const attrs = tagMatch[3];

    if (dropTag) {
      if (tag === dropTag) {
        if (closing) dropDepth--;
        else dropDepth++;
        if (dropDepth <= 0) dropTag = null;
      }
      continue;
    }
    if (DROP_WITH_CONTENT.has(tag)) {
      if (!closing) {
        dropTag = tag;
        dropDepth = 1;
      }
      continue;
    }
    if (!ALLOWED.has(tag)) continue; // strip tag, keep content

    if (tag === 'br') {
      if (!closing) out += '<br>';
      continue;
    }
    if (closing) {
      const at = stack.lastIndexOf(tag);
      if (at === -1) continue; // stray close
      while (stack.length > at) out += `</${stack.pop()}>`;
      continue;
    }
    if (tag === 'a') {
      const href = safeHref(attrs);
      if (!href) continue; // no safe target — strip the tag, keep the label
      out += `<a href="${escapeAttr(href)}">`;
      stack.push('a');
      continue;
    }
    out += `<${tag}>`;
    stack.push(tag);
  }

  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/**
 * Readable plain text from a rich-lite body — the text/plain MIME part and
 * log display. Links become "label (url)", list items "- item" (numbered for
 * <ol>), paragraphs/headings blank-line breaks.
 */
export function richToText(html: string): string {
  const clean = sanitizeRich(html);
  let out = '';
  const lists: { type: 'ul' | 'ol'; n: number }[] = [];
  let linkHref: string | null = null;
  let linkLabel = '';

  const emit = (s: string) => {
    if (linkHref === null) out += s;
    else linkLabel += s;
  };

  for (const token of clean.match(TOKEN) ?? []) {
    const tagMatch = token[0] === '<' ? TAG.exec(token) : null;
    if (!tagMatch) {
      emit(decodeEntities(token));
      continue;
    }
    const closing = tagMatch[1] === '/';
    const tag = tagMatch[2].toLowerCase();
    switch (tag) {
      case 'br':
        emit('\n');
        break;
      case 'p':
      case 'h2':
      case 'h3':
        if (closing) out += '\n\n';
        break;
      case 'ul':
      case 'ol':
        if (closing) {
          lists.pop();
          if (!lists.length) out += '\n';
        } else lists.push({ type: tag, n: 0 });
        break;
      case 'li': {
        if (closing) {
          out += '\n';
          break;
        }
        const list = lists[lists.length - 1];
        const indent = '  '.repeat(Math.max(0, lists.length - 1));
        out += list?.type === 'ol' ? `${indent}${++list.n}. ` : `${indent}- `;
        break;
      }
      case 'a': {
        if (!closing) {
          const m = /href="([^"]*)"/.exec(tagMatch[3]);
          linkHref = decodeEntities(m?.[1] ?? '');
          linkLabel = '';
        } else if (linkHref !== null) {
          const label = linkLabel.trim();
          out += !label || label === linkHref ? linkHref : `${label} (${linkHref})`;
          linkHref = null;
          linkLabel = '';
        }
        break;
      }
      default:
        break; // strong/em/b/i carry no plain-text markers
    }
  }
  if (linkHref !== null) out += linkLabel; // unterminated link (shouldn't happen post-sanitize)

  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
