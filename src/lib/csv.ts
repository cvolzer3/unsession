/**
 * CSV in and out (spec B2 §8/§9). Every admin table exports through `toCsv`,
 * and the submissions importer parses uploaded files with `parseCsv` — a real
 * RFC-4180 reader, because "split on comma" eats every abstract with a comma
 * in it.
 *
 * Owned by B2; other tracks import it for their own table exports.
 */

export type CsvValue = string | number | boolean | null | undefined;
export type CsvRow = Record<string, CsvValue>;

/** One field, always quoted — unambiguous for Excel, Sheets and `parseCsv`. */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '""';
  const s = typeof value === 'string' ? value : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

export function csvLine(cells: CsvValue[]): string {
  return cells.map(csvCell).join(',');
}

/**
 * Header row + quoted values. Columns default to the union of the row keys in
 * first-seen order, so callers can just hand over objects.
 */
export function toCsv(rows: CsvRow[], columns?: string[]): string {
  const cols = columns ?? uniqueKeys(rows);
  const out = [csvLine(cols)];
  for (const row of rows) out.push(csvLine(cols.map((c) => row[c] ?? '')));
  return out.join('\r\n') + '\r\n';
}

function uniqueKeys(rows: CsvRow[]): string[] {
  const seen: string[] = [];
  for (const row of rows) for (const k of Object.keys(row)) if (!seen.includes(k)) seen.push(k);
  return seen;
}

/**
 * RFC-4180 parser: quoted fields may contain commas, newlines and doubled
 * quotes. Handles CRLF/LF/CR line endings and a leading BOM. Returns raw rows
 * (the header, if any, is row 0) with trailing empty lines dropped.
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i++;
      continue;
    }
    if (ch === ',') {
      endField();
      i++;
      continue;
    }
    if (ch === '\r') {
      endRow();
      if (src[i + 1] === '\n') i++;
      i++;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length || row.length) endRow();

  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop();
  return rows;
}

/** Parsed sheet split into its header row and the data rows below it. */
export function parseCsvTable(text: string): { headers: string[]; rows: string[][] } {
  const all = parseCsv(text);
  if (!all.length) return { headers: [], rows: [] };
  const headers = all[0].map((h) => h.trim());
  return { headers, rows: all.slice(1).filter((r) => r.some((c) => c.trim() !== '')) };
}

/** Download headers for a CSV response. */
export function csvHeaders(filename: string): Record<string, string> {
  return {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
  };
}
