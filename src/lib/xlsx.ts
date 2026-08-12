/**
 * Minimal XLSX writer (spec B7 — table exports next to CSV). An .xlsx is a ZIP
 * of five XML parts; every text cell is an inline string (`<is><t>`), so there
 * is no sharedStrings table, no styles part and no dependency. Entries are
 * stored (no compression) with real CRC-32s — spreadsheet XML is small and
 * stored entries are valid XLSX. `zip.ts` owns the repo's other ZIP writer,
 * but it streams R2 objects and can't take in-memory parts, so only its
 * exported `crc32` is reused here.
 *
 * Owned by B2 (submissions export); other tracks may import `toXlsx` +
 * `xlsxHeaders` for their own table exports, mirroring `toCsv` + `csvHeaders`.
 */
import { crc32 } from './zip';

export type XlsxValue = string | number | boolean | null | undefined;
export type XlsxRow = Record<string, XlsxValue>;

/* ------------------------------------------------------------------- xml */

/** Escape text for XML and drop control characters Excel refuses to parse. */
function escXml(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** One cell: finite numbers as numeric cells, everything else inline strings. */
function cellXml(value: XlsxValue): string {
  if (value === null || value === undefined || value === '') return '<c/>';
  if (typeof value === 'number' && Number.isFinite(value)) return `<c><v>${value}</v></c>`;
  const s = typeof value === 'string' ? value : String(value);
  const preserve = /^\s|\s$/.test(s) ? ' xml:space="preserve"' : '';
  return `<c t="inlineStr"><is><t${preserve}>${escXml(s)}</t></is></c>`;
}

function sheetXml(rows: XlsxRow[], columns: string[]): string {
  const lines: string[] = [`<row>${columns.map((c) => cellXml(c)).join('')}</row>`];
  for (const row of rows) lines.push(`<row>${columns.map((c) => cellXml(row[c] ?? '')).join('')}</row>`);
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${lines.join('')}</sheetData></worksheet>`
  );
}

/** Sheet names may not contain []:*?/\ and cap at 31 characters. */
function sheetName(name: string): string {
  const clean = name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31);
  return clean || 'Sheet1';
}

function workbookXml(name: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${escXml(sheetName(name))}" sheetId="1" r:id="rId1"/></sheets></workbook>`
  );
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '</Types>';

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

const WORKBOOK_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '</Relationships>';

/* ------------------------------------------------------------------- zip */

/** UTF-8 name flag (bit 11) — same as zip.ts. */
const FLAG_UTF8 = 0x0800;

/** In-memory store-only ZIP: local headers + data, central directory, EOCD. */
function storedZip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const d = new Date();
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  const date = ((Math.max(1980, d.getUTCFullYear()) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();

  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, FLAG_UTF8, true);
    lv.setUint16(8, 0, true); // method: store
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true); // compressed
    lv.setUint32(22, f.data.length, true); // uncompressed
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true); // extra
    local.set(name, 30);

    const cen = new Uint8Array(46 + name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, FLAG_UTF8, true);
    cv.setUint16(10, 0, true); // method: store
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    // extra/comment lengths, disk, internal/external attrs all stay 0
    cv.setUint32(42, offset, true);
    cen.set(name, 46);

    chunks.push(local, f.data);
    central.push(cen);
    offset += local.length + f.data.length;
  }

  let centralSize = 0;
  for (const rec of central) centralSize += rec.length;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + eocd.length);
  let pos = 0;
  for (const chunk of [...chunks, ...central, eocd]) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}

/* ---------------------------------------------------------------- public */

/**
 * Header row + one worksheet row per record. Columns default to the union of
 * the row keys in first-seen order, mirroring `toCsv`.
 */
export function toXlsx(rows: XlsxRow[], columns?: string[], name = 'Sheet1'): Uint8Array {
  const cols = columns ?? uniqueKeys(rows);
  const enc = new TextEncoder();
  return storedZip([
    { name: '[Content_Types].xml', data: enc.encode(CONTENT_TYPES) },
    { name: '_rels/.rels', data: enc.encode(ROOT_RELS) },
    { name: 'xl/workbook.xml', data: enc.encode(workbookXml(name)) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(WORKBOOK_RELS) },
    { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheetXml(rows, cols)) },
  ]);
}

function uniqueKeys(rows: XlsxRow[]): string[] {
  const seen: string[] = [];
  for (const row of rows) for (const k of Object.keys(row)) if (!seen.includes(k)) seen.push(k);
  return seen;
}

/** Download headers for an XLSX response. */
export function xlsxHeaders(filename: string): Record<string, string> {
  return {
    'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'content-disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
  };
}
