/**
 * Minimal PDF writer, used only by the sandbox seed (`lib/seed.ts`): a couple
 * of the demo event's submissions arrive with an "extended abstract" attached,
 * and those files have to be real bytes in R2 — the organizer's drawer, the
 * evaluator's card and the speaker's own form all offer them for download.
 *
 * Scope is exactly what a fake abstract needs: A4 pages, the two base-14
 * Helvetica faces (no embedding), one text-showing operator per line, no
 * images and no compression. Text is folded to ASCII (`ascii`) so WinAnsi
 * covers every glyph and one character is always one byte — which is what lets
 * the xref offsets below be plain string lengths.
 *
 * `sizes` here are points; the page origin is bottom-left, so layout counts
 * `y` *down* from the top margin.
 */

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN = 62;
const TEXT_W = PAGE_W - MARGIN * 2;
const INK = '0.12 0.12 0.16 rg';
const GRAY = '0.45 0.46 0.52 rg';

type BlockKind = 'kicker' | 'title' | 'meta' | 'heading' | 'body' | 'bullet';

type Block = { kind: BlockKind; text: string } | { kind: 'rule' } | { kind: 'gap' };

type Style = {
  size: number;
  bold?: boolean;
  gray?: boolean;
  /** Extra character spacing (the `Tc` operator) — the kicker's letterspacing. */
  track?: number;
  /** Baseline-to-baseline distance within a wrapped block. */
  lead: number;
  /** Space above the block. */
  before: number;
  indent?: number;
};

const STYLES: Record<BlockKind, Style> = {
  kicker: { size: 8.5, bold: true, gray: true, track: 1.1, lead: 12, before: 0 },
  title: { size: 17, bold: true, lead: 21, before: 16 },
  meta: { size: 9.5, gray: true, lead: 13, before: 10 },
  heading: { size: 10.5, bold: true, lead: 14, before: 20 },
  body: { size: 10.5, lead: 15, before: 8 },
  bullet: { size: 10.5, lead: 15, before: 6, indent: 14 },
};

/**
 * Average glyph width as a fraction of the font size. Helvetica's real widths
 * vary per character; these are deliberately a shade generous so a wrapped
 * line never overruns the right margin.
 */
const WIDTH_FACTOR = { regular: 0.52, bold: 0.56 };

/* ------------------------------------------------------------------ text */

/**
 * Fold text into WinAnsi's single-byte range: decompose the accents the
 * encoding cannot carry (Kovač → Kovac, while ø and ß survive as themselves),
 * map the typographic punctuation the seed actually uses onto its CP1252
 * slots, and drop whatever is left. One character out is one byte out.
 */
function ascii(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u201b]/g, '\x91')
    .replace(/\u2019/g, '\x92')
    .replace(/\u201c/g, '\x93')
    .replace(/\u201d/g, '\x94')
    .replace(/\u2013/g, '\x96')
    .replace(/\u2014/g, '\x97')
    .replace(/\u2022/g, '\x95')
    .replace(/\u00b7/g, '\xb7')
    .replace(/\u2026/g, '\x85')
    .replace(/[^\x20-\x7e\x85\x91-\x97\xa0-\xff]/g, '');
}

/** PDF string literal escaping — backslash and both parens. */
function esc(s: string): string {
  return s.replace(/([\\()])/g, '\\$1');
}

function wrap(text: string, style: Style): string[] {
  const width = TEXT_W - (style.indent ?? 0);
  const per = style.size * (style.bold ? WIDTH_FACTOR.bold : WIDTH_FACTOR.regular);
  const max = Math.max(12, Math.floor(width / per));
  const out: string[] = [];
  let line = '';
  for (const word of ascii(text).split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > max && line) {
      out.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/* ---------------------------------------------------------------- layout */

/** Blocks → one content stream per page. */
function paginate(blocks: Block[]): string[] {
  const pages: string[] = [];
  let ops: string[] = [];
  let y = PAGE_H - MARGIN;

  const breakPage = () => {
    pages.push(ops.join('\n'));
    ops = [];
    y = PAGE_H - MARGIN;
  };

  for (const block of blocks) {
    if (block.kind === 'gap') {
      y -= 10;
      continue;
    }
    if (block.kind === 'rule') {
      y -= 9;
      ops.push(`0.84 0.84 0.87 RG 0.6 w ${MARGIN} ${y.toFixed(2)} m ${(PAGE_W - MARGIN).toFixed(2)} ${y.toFixed(2)} l S`);
      y -= 13;
      continue;
    }
    const style = STYLES[block.kind];
    const indent = style.indent ?? 0;
    y -= style.before;
    wrap(block.text, style).forEach((line, i) => {
      if (y - style.lead < MARGIN) breakPage();
      y -= style.lead;
      // Bullets carry a WinAnsi bullet (octal 225) on their first line only.
      const marker = block.kind === 'bullet' && i === 0;
      ops.push(
        [
          'BT',
          `/${style.bold ? 'F2' : 'F1'} ${style.size} Tf`,
          `${(style.track ?? 0).toFixed(2)} Tc`,
          style.gray ? GRAY : INK,
          `${MARGIN + indent} ${y.toFixed(2)} Td`,
          `(${esc(line)}) Tj`,
          'ET',
        ].join(' ') + (marker ? `\nBT /F1 ${style.size} Tf 0 Tc ${INK} ${MARGIN} ${y.toFixed(2)} Td (\\225) Tj ET` : '')
      );
    });
  }
  pages.push(ops.join('\n'));
  return pages;
}

/* ------------------------------------------------------------- assembly */

function bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** `2026-07-28` → the PDF date string `D:20260728090000Z`. */
function pdfDate(iso: string): string {
  const d = ascii(iso).replace(/[^0-9]/g, '').slice(0, 8);
  return `D:${d.padEnd(8, '0')}090000Z`;
}

function build(pageStreams: string[], title: string, created: string): Uint8Array {
  // 1 catalog · 2 pages · 3 regular font · 4 bold font · 5 info, then a page
  // object + its content stream for each page.
  const objs: string[] = [];
  const pageIds = pageStreams.map((_, i) => 6 + i * 2);
  objs[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[1] = `<< /Type /Pages /Kids [${pageIds.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  objs[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objs[4] =
    `<< /Title (${esc(ascii(title))}) /Producer (Unsession sandbox) /Creator (Unsession) ` +
    `/CreationDate (${pdfDate(created)}) >>`;
  pageStreams.forEach((stream, i) => {
    const id = pageIds[i];
    objs[id - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${id + 1} 0 R >>`;
    objs[id] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  // The binary comment on line 2 is what marks the file as non-text to tools
  // that sniff it; every byte below stays < 256 so string length == byte count.
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets[i] = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const startXref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((o) => {
    out += `${String(o).padStart(10, '0')} 00000 n \n`;
  });
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;
  return bytes(out);
}

/* ------------------------------------------------------------- documents */

/** Minute ranges for a session of `minutes`, as a speaker would sketch them. */
function outline(minutes: number): string[] {
  const parts: [string, number][] = [
    ['Framing: why this is harder than it looks', 0.18],
    ['What we tried first, and how it broke', 0.28],
    ['The approach that stuck — with numbers', 0.34],
    ['Trade-offs, failure modes, and questions', 0.2],
  ];
  let at = 0;
  return parts.map(([label, share], i) => {
    const end = i === parts.length - 1 ? minutes : Math.round(at + share * minutes);
    const line = `${at}–${end} min — ${label}`;
    at = end;
    return line;
  });
}

export type AbstractDoc = {
  /** Event name, printed in the kicker. */
  event: string;
  title: string;
  /** Speaker line, e.g. `Amara Diallo - amara@fastly.dev`. */
  byline: string;
  /** Track · format · level. */
  meta: string;
  /** The proposal's abstract, then whatever extra paragraphs the seed adds. */
  summary: string[];
  takeaways: string[];
  /** Session length, which the outline's minute markers are derived from. */
  minutes: number;
  /** `YYYY-MM-DD` — printed in the footer and used as the PDF creation date. */
  submitted: string;
};

/** The sandbox's fake extended abstract: one submission, one short paper. */
export function abstractPdf(doc: AbstractDoc): Uint8Array {
  const blocks: Block[] = [
    { kind: 'kicker', text: `${doc.event} - Extended abstract`.toUpperCase() },
    { kind: 'rule' },
    { kind: 'title', text: doc.title },
    { kind: 'meta', text: doc.byline },
    { kind: 'meta', text: doc.meta },
    { kind: 'heading', text: 'Summary' },
    ...doc.summary.map((text): Block => ({ kind: 'body', text })),
    { kind: 'heading', text: 'What the audience leaves with' },
    ...doc.takeaways.map((text): Block => ({ kind: 'bullet', text })),
    { kind: 'heading', text: `Outline (${doc.minutes} minutes)` },
    ...outline(doc.minutes).map((text): Block => ({ kind: 'bullet', text })),
    { kind: 'gap' },
    { kind: 'rule' },
    { kind: 'meta', text: `Submitted to the ${doc.event} call for speakers on ${doc.submitted}.` },
  ];
  return build(paginate(blocks), doc.title, doc.submitted);
}
