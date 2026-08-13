/**
 * `/app/org/contacts` — the org's Speaker Directory (Speaker CRM).
 *
 * Lists every contact the org has worked with, across all its events. Three
 * sub-tabs: Contacts (search, filters, bulk actions, import), Segments (saved
 * searches) and Overview (org-level KPIs).
 *
 * Search, filters, tabs and segments are plain GET. Creation, import and sends
 * are real form POSTs. `public/js/org-directory.js` only adds the bulk-select
 * bar and small modal conveniences.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { FC } from 'hono/jsx';
import type { Ctx, Event } from '../types';
import { AdminLayout, MONO, StatusChip, initials, initialsGradient } from '../views/layout';
import { adminProps, redirectWithToast } from '../views/chrome';
import { all, jsonParse, now, one, run } from '../lib/db';
import { newId } from '../lib/ids';
import { requireOrgRole } from '../lib/auth';
import { addContactToEvent, orgIdForRequest, upsertOrgContact } from '../lib/org-contacts';
import { csvHeaders, parseCsvTable, toCsv } from '../lib/csv';
import { renderTemplate, sendEmail } from '../lib/email';

const app = new Hono<Ctx>();

/* ------------------------------------------------------------------ style */

const MICRO = `font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;`;
const INPUT = 'width:100%;padding:8px 12px;border:1px solid #e2e3e8;font-size:13px;outline-color:#4c5fd5;';
const SELECT = 'padding:7px 10px;border:1px solid #e2e3e8;background:#fff;font-size:13px;color:#16171d;';
const BTN = 'padding:7px 14px;background:#fff;border:1px solid #e2e3e8;font-size:13px;cursor:pointer;';
const PRIMARY = 'padding:9px 16px;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;';
const DIALOG = 'position:fixed;inset:0;background:rgba(22,23,29,0.45);z-index:90;display:grid;place-items:center;padding:20px;';
const PANEL = 'background:#fff;width:560px;max-width:100%;max-height:88vh;display:flex;flex-direction:column;';
const TEXTAREA =
  'width:100%;padding:10px 12px;border:1px solid #e2e3e8;font-size:13px;line-height:1.5;resize:vertical;outline-color:#4c5fd5;font-family:inherit;';
const GRID = 'grid-template-columns:34px 34px minmax(150px,1.3fr) minmax(160px,1.2fr) 150px 140px 130px 36px;';
const PG_ON = 'padding:6px 12px;font-size:12px;border:1px solid #e2e3e8;background:#fff;color:#33343c;cursor:pointer;text-decoration:none;';
const PG_OFF = 'padding:6px 12px;font-size:12px;border:1px solid #e2e3e8;background:#fff;color:#c9cbd2;cursor:default;';

/** Underlined page-level tab, matching `/app/emails`. */
const subTab = (on: boolean) =>
  `padding:0 2px 10px;border-bottom:2px solid ${on ? '#4c5fd5' : 'transparent'};margin-bottom:-1px;font-size:13.5px;font-weight:600;color:${
    on ? '#16171d' : '#686b74'
  };text-decoration:none;display:inline-block;`;

/* ------------------------------------------------------------------ types */

type Row = {
  id: string;
  email: string;
  name: string;
  company: string;
  job_title: string;
  tags_json: string;
  headshot_file_id: string | null;
  source: string;
};

type Filters = { q: string; company: string; job_title: string; tag: string };

type SegmentRow = {
  id: string;
  name: string;
  kind: string;
  query: string;
  member_ids_json: string | null;
  created_at: string;
};

const EMPTY: Filters = { q: '', company: '', job_title: '', tag: '' };

/**
 * Rows per page of the contacts table. Bulk actions act on the checked rows of
 * the page you are looking at, so this stays well under `SEND_MAX`.
 */
const PAGE_SIZE = 50;
/** Rows accepted per CSV import — keeps one request inside its subrequest budget. */
const IMPORT_MAX_ROWS = 200;
/** Recipients per Communicate send, for the same reason. */
const SEND_MAX = 100;

/* ---------------------------------------------------------------- helpers */

function readFilters(params: URLSearchParams): Filters {
  return {
    q: (params.get('q') ?? '').trim(),
    company: (params.get('company') ?? '').trim(),
    job_title: (params.get('job_title') ?? '').trim(),
    tag: (params.get('tag') ?? '').trim(),
  };
}

function hasFilters(f: Filters): boolean {
  return !!(f.q || f.company || f.job_title || f.tag);
}

/** A directory URL carrying these filters. Overrides win; empty values drop. */
function contactsHref(f: Filters, overrides: Partial<Filters> = {}): string {
  const merged = { ...f, ...overrides };
  const p = new URLSearchParams();
  if (merged.q) p.set('q', merged.q);
  if (merged.company) p.set('company', merged.company);
  if (merged.job_title) p.set('job_title', merged.job_title);
  if (merged.tag) p.set('tag', merged.tag);
  const s = p.toString();
  return '/app/org/contacts' + (s ? `?${s}` : '');
}

/** The querystring a dynamic segment stores. */
function filterQuery(f: Filters): string {
  return contactsHref(f).split('?')[1] ?? '';
}

/**
 * WHERE fragment for the contacts list. `memberIds` scopes to a curated
 * segment; an empty list matches nothing.
 */
function buildWhere(orgId: string, f: Filters, memberIds: string[] | null): { sql: string; params: unknown[] } {
  const where = ['org_id = ?'];
  const params: unknown[] = [orgId];
  if (f.q) {
    const like = `%${f.q}%`;
    where.push('(name LIKE ? OR email LIKE ? OR company LIKE ?)');
    params.push(like, like, like);
  }
  if (f.company) {
    where.push('company = ?');
    params.push(f.company);
  }
  if (f.job_title) {
    where.push('job_title = ?');
    params.push(f.job_title);
  }
  if (f.tag) {
    where.push('EXISTS (SELECT 1 FROM json_each(org_contacts.tags_json) WHERE value = ?)');
    params.push(f.tag);
  }
  if (memberIds) {
    if (!memberIds.length) where.push('0');
    else {
      // One bound parameter whatever the list length — D1 allows 100 per
      // statement, and a curated segment can hold more members than that.
      where.push('id IN (SELECT value FROM json_each(?))');
      params.push(JSON.stringify(memberIds));
    }
  }
  return { sql: where.join(' AND '), params };
}

/**
 * Ids posted from a bulk bar (one comma-separated field) or from a checkbox
 * list (the same field repeated — read with `parseBody({ all: true })`).
 */
function idList(value: unknown): string[] {
  const parts = Array.isArray(value) ? value.map((v) => String(v)) : String(value ?? '').split(',');
  return parts
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 500);
}

/** Deliberately permissive — organizer sheets carry odd but real addresses. */
function validEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email);
}

/** Merge-tag values for one contact. */
function contactVars(row: { name: string; email: string; company: string }): Record<string, string> {
  const name = row.name || row.email;
  return {
    name,
    first_name: name.split(/[\s@]/)[0] || name,
    company: row.company || '',
    email: row.email,
  };
}

const Avatar: FC<{ row: Row }> = ({ row }) =>
  row.headshot_file_id ? (
    <div
      style={`width:26px;height:26px;border-radius:50%;background:url(/files/${row.headshot_file_id}) center/cover;`}
    ></div>
  ) : (
    <div
      style={`width:26px;height:26px;border-radius:50%;background:${initialsGradient(
        row.name || row.email
      )};color:#fff;display:grid;place-items:center;font-family:${MONO};font-size:9.5px;font-weight:600;`}
    >
      {initials(row.name || row.email)}
    </div>
  );

/** One removable active-filter chip. */
const FilterChip: FC<{ label: string; value: string; href: string }> = ({ label, value, href }) => (
  <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border:1px solid #4c5fd5;background:#eef0fb;font-size:12px;color:#4c5fd5;">
    <span style={`font-family:${MONO};font-size:9.5px;letter-spacing:0.08em;`}>{label}</span>
    {value}
    <a href={href} title="Remove this filter" style="color:#4c5fd5;text-decoration:none;font-size:13px;line-height:1;">
      ×
    </a>
  </span>
);

/** Bar row used by the Overview widgets — no chart library. */
const BarRow: FC<{ label: string; count: number; max: number; href?: string }> = ({ label, count, max, href }) => {
  const pct = max > 0 ? Math.max(4, Math.round((count / max) * 100)) : 0;
  const body = (
    <>
      <div style="display:flex;align-items:baseline;gap:8px;">
        <div style="font-size:12.5px;color:#16171d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          {label}
        </div>
        <div style={`margin-left:auto;font-family:${MONO};font-size:11px;color:#686b74;`}>{count}</div>
      </div>
      <div style="height:5px;background:#f1f3f5;margin-top:4px;">
        <div style={`height:5px;width:${pct}%;background:#4c5fd5;`}></div>
      </div>
    </>
  );
  return href ? (
    <a href={href} style="display:block;padding:6px 0;text-decoration:none;color:inherit;">
      {body}
    </a>
  ) : (
    <div style="padding:6px 0;">{body}</div>
  );
};

/* ------------------------------------------------------------------- page */

app.get('/app/org/contacts', async (c) => {
  const props = await adminProps(c, 'Speaker Directory', {
    headerTitle: 'Speaker Directory',
    scripts: ['/js/org-directory.js'],
  });
  if (!c.var.event) return c.redirect('/app/events/new');
  const orgId = orgIdForRequest(c)!;
  const canWrite = c.var.role === 'admin' || c.var.role === 'owner';

  const url = new URL(c.req.url);
  const tabParam = url.searchParams.get('tab');
  const tab = tabParam === 'segments' ? 'segments' : tabParam === 'overview' ? 'overview' : 'contacts';

  const tabs = (
    <div style="display:flex;gap:18px;border-bottom:1px solid #e2e3e8;margin-bottom:20px;">
      <a href="/app/org/contacts" style={subTab(tab === 'contacts')}>
        Contacts
      </a>
      <a href="/app/org/contacts?tab=segments" style={subTab(tab === 'segments')}>
        Segments
      </a>
      <a href="/app/org/contacts?tab=overview" style={subTab(tab === 'overview')}>
        Overview
      </a>
    </div>
  );

  /* ------------------------------------------------------------ segments */

  if (tab === 'segments') {
    const segments = await all<SegmentRow>(
      c.env.DB,
      `SELECT id, name, kind, query, member_ids_json, created_at FROM org_segments
        WHERE org_id = ? ORDER BY created_at DESC LIMIT 50`,
      orgId
    );

    // One batch keeps the per-segment counts to a single subrequest.
    const counts = new Map<string, number>();
    if (segments.length) {
      const stmts = segments.map((s) => {
        if (s.kind === 'curated') {
          const ids = jsonParse<string[]>(s.member_ids_json, []);
          const w = buildWhere(orgId, EMPTY, ids);
          return c.env.DB.prepare(`SELECT COUNT(*) AS n FROM org_contacts WHERE ${w.sql}`).bind(...w.params);
        }
        const w = buildWhere(orgId, readFilters(new URLSearchParams(s.query)), null);
        return c.env.DB.prepare(`SELECT COUNT(*) AS n FROM org_contacts WHERE ${w.sql}`).bind(...w.params);
      });
      const res = await c.env.DB.batch<{ n: number }>(stmts);
      segments.forEach((s, i) => counts.set(s.id, res[i]?.results?.[0]?.n ?? 0));
    }

    return c.html(
      <AdminLayout {...props}>
        <div style="padding:24px 28px;">
          {tabs}
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;">
            <h1 style="margin:0;font-size:21px;letter-spacing:-0.02em;">Segments</h1>
            <div style={`font-family:${MONO};font-size:12px;color:#686b74;`}>
              {segments.length === 1 ? '1 segment' : `${segments.length} segments`}
            </div>
            {canWrite ? (
              <a
                href="/app/org/segments/new"
                style={`${PRIMARY}margin-left:auto;text-decoration:none;display:inline-block;`}
              >
                Create segment
              </a>
            ) : null}
          </div>
          <div style="background:#fff;border:1px solid #e2e3e8;">
            <div
              style={`display:grid;grid-template-columns:minmax(180px,1fr) 110px 120px 130px 90px;gap:12px;padding:10px 14px;border-bottom:1px solid #e2e3e8;${MICRO}`}
            >
              <div>SEGMENT</div>
              <div>TYPE</div>
              <div>MEMBERS</div>
              <div>CREATED</div>
              <div></div>
            </div>
            {segments.length ? (
              segments.map((s) => (
                <div style="display:grid;grid-template-columns:minmax(180px,1fr) 110px 120px 130px 90px;gap:12px;padding:11px 14px;border-bottom:1px solid #f2f3f5;align-items:center;">
                  <a
                    href={`/app/org/contacts?segment=${s.id}`}
                    style="font-size:13.5px;font-weight:600;color:#16171d;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
                  >
                    {s.name}
                  </a>
                  <div>
                    <span
                      style={`font-family:${MONO};font-size:9px;letter-spacing:0.08em;padding:2px 6px;font-weight:600;text-transform:uppercase;color:${
                        s.kind === 'dynamic' ? '#1c7ed6' : '#087f5b'
                      };background:${s.kind === 'dynamic' ? '#e7f1fb' : '#dcf2eb'};`}
                    >
                      {s.kind}
                    </span>
                  </div>
                  <div style={`font-family:${MONO};font-size:12px;color:#33343c;`}>
                    {`${counts.get(s.id) ?? 0} contacts`}
                  </div>
                  <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;`}>{s.created_at.slice(0, 10)}</div>
                  {canWrite ? (
                    <form method="post" action={`/app/org/segments/${s.id}/delete`} style="justify-self:end;margin:0;">
                      <button
                        type="submit"
                        data-confirm={`Delete the segment “${s.name}”? Contacts are not touched.`}
                        style="padding:5px 11px;background:#fff;border:1px solid #e2e3e8;font-size:12px;color:#c92a2a;cursor:pointer;"
                      >
                        Delete
                      </button>
                    </form>
                  ) : null}
                </div>
              ))
            ) : (
              <div style="padding:36px 16px;text-align:center;font-size:13px;color:#686b74;">
                No segments yet. Hit Create segment to pick contacts or set criteria.
              </div>
            )}
          </div>
        </div>
      </AdminLayout>
    );
  }

  /* ------------------------------------------------------------ overview */

  if (tab === 'overview') {
    const [totals, eventCount, returning, emailCount] = await Promise.all([
      one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM org_contacts WHERE org_id = ?`, orgId),
      one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM events WHERE org_id = ?`, orgId),
      one<{ n: number }>(
        c.env.DB,
        `SELECT COUNT(*) AS n FROM (
           SELECT c.id FROM speaker_profiles p
             JOIN events e ON e.id = p.event_id
             JOIN org_contacts c ON c.org_id = e.org_id AND c.email = p.email
            WHERE e.org_id = ?
            GROUP BY c.id HAVING COUNT(DISTINCT p.event_id) >= 2
         )`,
        orgId
      ),
      one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM emails WHERE org_id = ?`, orgId),
    ]);

    const [companies, tags, sources, recent] = await Promise.all([
      all<{ company: string; n: number }>(
        c.env.DB,
        `SELECT company, COUNT(*) AS n FROM org_contacts
          WHERE org_id = ? AND company != '' GROUP BY company ORDER BY n DESC, company LIMIT 8`,
        orgId
      ),
      all<{ tag: string; n: number }>(
        c.env.DB,
        `SELECT je.value AS tag, COUNT(*) AS n FROM org_contacts c, json_each(c.tags_json) je
          WHERE c.org_id = ? GROUP BY je.value ORDER BY n DESC, tag LIMIT 8`,
        orgId
      ),
      all<{ source: string; n: number }>(
        c.env.DB,
        `SELECT source, COUNT(*) AS n FROM org_contacts WHERE org_id = ? GROUP BY source ORDER BY n DESC`,
        orgId
      ),
      all<{ subject: string; to_email: string; status: string; sent_at: string | null; created_at: string }>(
        c.env.DB,
        `SELECT subject, to_email, status, sent_at, created_at FROM emails
          WHERE org_id = ? ORDER BY created_at DESC LIMIT 10`,
        orgId
      ),
    ]);

    const kpis = [
      { label: 'TOTAL CONTACTS', value: totals?.n ?? 0 },
      { label: 'EVENTS', value: eventCount?.n ?? 0 },
      { label: 'RETURNING SPEAKERS', value: returning?.n ?? 0 },
      { label: 'EMAILS SENT', value: emailCount?.n ?? 0 },
    ];
    const maxCompany = companies[0]?.n ?? 0;
    const maxTag = tags[0]?.n ?? 0;
    const maxSource = sources[0]?.n ?? 0;

    return c.html(
      <AdminLayout {...props}>
        <div style="padding:24px 28px;">
          {tabs}
          <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px;">
            {kpis.map((k) => (
              <div style="background:#fff;border:1px solid #e2e3e8;padding:16px 18px;">
                <div style={`${MICRO}margin-bottom:8px;`}>{k.label}</div>
                <div style={`font-family:${MONO};font-size:26px;font-weight:600;letter-spacing:-0.02em;`}>
                  {k.value}
                </div>
              </div>
            ))}
          </div>

          <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:16px;">
            <div style="background:#fff;border:1px solid #e2e3e8;padding:16px 18px;">
              <div style={`${MICRO}margin-bottom:8px;`}>TOP COMPANIES</div>
              {companies.length ? (
                companies.map((r) => (
                  <BarRow
                    label={r.company}
                    count={r.n}
                    max={maxCompany}
                    href={contactsHref(EMPTY, { company: r.company })}
                  />
                ))
              ) : (
                <div style="font-size:12.5px;color:#9a9da6;">No companies on file yet.</div>
              )}
            </div>
            <div style="background:#fff;border:1px solid #e2e3e8;padding:16px 18px;">
              <div style={`${MICRO}margin-bottom:8px;`}>AREAS OF FOCUS</div>
              {tags.length ? (
                tags.map((r) => (
                  <BarRow label={r.tag} count={r.n} max={maxTag} href={contactsHref(EMPTY, { tag: r.tag })} />
                ))
              ) : (
                <div style="font-size:12.5px;color:#9a9da6;">No tags yet. Tag contacts on their profile.</div>
              )}
            </div>
            <div style="background:#fff;border:1px solid #e2e3e8;padding:16px 18px;">
              <div style={`${MICRO}margin-bottom:8px;`}>SPEAKER SOURCE</div>
              {sources.length ? (
                sources.map((r) => <BarRow label={r.source} count={r.n} max={maxSource} />)
              ) : (
                <div style="font-size:12.5px;color:#9a9da6;">No contacts yet.</div>
              )}
            </div>
          </div>

          <div style="background:#fff;border:1px solid #e2e3e8;">
            <div style={`padding:12px 16px;border-bottom:1px solid #e2e3e8;${MICRO}`}>RECENT EMAILS</div>
            {recent.length ? (
              recent.map((r) => (
                <div style="display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) 100px 150px;gap:12px;padding:10px 16px;border-bottom:1px solid #f2f3f5;align-items:center;">
                  <div style="font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                    {r.subject}
                  </div>
                  <div style={`font-family:${MONO};font-size:11.5px;color:#686b74;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`}>
                    {r.to_email}
                  </div>
                  <div>
                    <StatusChip status={r.status} />
                  </div>
                  <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;`}>
                    {(r.sent_at ?? r.created_at).slice(0, 16).replace('T', ' ')}
                  </div>
                </div>
              ))
            ) : (
              <div style="padding:28px 16px;text-align:center;font-size:13px;color:#686b74;">
                No org-level emails yet. Select contacts and hit Send Email.
              </div>
            )}
          </div>
        </div>
      </AdminLayout>
    );
  }

  /* ------------------------------------------------------------ contacts */

  const segmentId = (url.searchParams.get('segment') ?? '').trim();
  const segment = segmentId
    ? await one<SegmentRow>(
        c.env.DB,
        `SELECT id, name, kind, query, member_ids_json, created_at FROM org_segments WHERE id = ? AND org_id = ?`,
        segmentId,
        orgId
      )
    : null;

  // A dynamic segment replays its stored query; a curated one scopes to its ids.
  const filters = segment && segment.kind === 'dynamic' ? readFilters(new URLSearchParams(segment.query)) : readFilters(url.searchParams);
  const memberIds = segment && segment.kind === 'curated' ? jsonParse<string[]>(segment.member_ids_json, []) : null;

  const where = buildWhere(orgId, filters, memberIds);
  const [totalRow, companyOpts, titleOpts, tagOpts, events, segmentOpts] = await Promise.all([
    one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM org_contacts WHERE ${where.sql}`, ...where.params),
    all<{ value: string; n: number }>(
      c.env.DB,
      `SELECT company AS value, COUNT(*) AS n FROM org_contacts
        WHERE org_id = ? AND company != '' GROUP BY company ORDER BY n DESC, company LIMIT 60`,
      orgId
    ),
    all<{ value: string; n: number }>(
      c.env.DB,
      `SELECT job_title AS value, COUNT(*) AS n FROM org_contacts
        WHERE org_id = ? AND job_title != '' GROUP BY job_title ORDER BY n DESC, job_title LIMIT 60`,
      orgId
    ),
    all<{ value: string; n: number }>(
      c.env.DB,
      `SELECT je.value AS value, COUNT(*) AS n FROM org_contacts c, json_each(c.tags_json) je
        WHERE c.org_id = ? GROUP BY je.value ORDER BY n DESC, value LIMIT 60`,
      orgId
    ),
    all<Pick<Event, 'id' | 'name'>>(
      c.env.DB,
      `SELECT id, name FROM events WHERE org_id = ? ORDER BY start_date DESC`,
      orgId
    ),
    // Names and kinds only. Member counts cost one COUNT per segment, which is
    // worth it on the Segments tab but not behind a filter dropdown.
    all<{ id: string; name: string; kind: string }>(
      c.env.DB,
      `SELECT id, name, kind FROM org_segments WHERE org_id = ? ORDER BY name COLLATE NOCASE LIMIT 50`,
      orgId
    ),
  ]);

  // The count settles first, so the page number can be clamped before the slice.
  const total = totalRow?.n ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const cur = Math.min(Math.max(0, Number(url.searchParams.get('page') ?? '0') || 0), pages - 1);
  const rows = await all<Row>(
    c.env.DB,
    `SELECT id, email, name, company, job_title, tags_json, headshot_file_id, source
       FROM org_contacts WHERE ${where.sql} ORDER BY name COLLATE NOCASE
      LIMIT ${PAGE_SIZE} OFFSET ${cur * PAGE_SIZE}`,
    ...where.params
  );

  const active = hasFilters(filters);
  const shownIds = rows.map((r) => r.id).join(',');

  /**
   * Chip-removal link: drops one filter and keeps the rest. A curated segment
   * scopes the other filters, so it survives; a dynamic one *is* the filters
   * shown, so removing any of them leaves the segment behind.
   */
  const dropFilter = (overrides: Partial<Filters>) => {
    const href = contactsHref(filters, overrides);
    if (segment?.kind !== 'curated') return href;
    return `${href}${href.includes('?') ? '&' : '?'}segment=${segment.id}`;
  };

  /** Same view, another page. Keeps the search, filters and segment in the URL. */
  const pageLink = (p: number) => {
    const sp = new URLSearchParams(url.searchParams);
    sp.delete('ok');
    // The filter form posts every select, empty ones included. Drop those.
    [...sp.entries()].forEach(([k, v]) => {
      if (!v) sp.delete(k);
    });
    if (p > 0) sp.set('page', String(p));
    else sp.delete('page');
    const s = sp.toString();
    return '/app/org/contacts' + (s ? `?${s}` : '');
  };

  return c.html(
    <AdminLayout {...props}>
      <div style="padding:24px 28px;">
        {tabs}

        {segment ? (
          <div style="background:#eef0fb;border:1px solid #4c5fd5;padding:10px 14px;margin-bottom:12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
            <span style={`font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#4c5fd5;`}>
              {`SEGMENT · ${segment.kind.toUpperCase()}`}
            </span>
            <strong style="font-size:13.5px;">{segment.name}</strong>
            <a href="/app/org/contacts" style="margin-left:auto;font-size:12.5px;">
              Back to all contacts
            </a>
          </div>
        ) : null}

        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;">
          <h1 style="margin:0;font-size:21px;letter-spacing:-0.02em;">Contacts</h1>
          <div style={`font-family:${MONO};font-size:12px;color:#686b74;`}>
            {total === 1 ? '1 contact' : `${total} contacts`}
          </div>
          <div style="margin-left:auto;display:flex;gap:8px;align-items:center;">
            <a href={`/app/org/contacts.csv?${filterQuery(filters)}`} style={`${BTN}text-decoration:none;color:#16171d;`}>
              Export CSV
            </a>
            {canWrite ? (
              <>
                <button type="button" data-dialog-open="#import-modal" style={BTN}>
                  Import
                </button>
                <button type="button" data-dialog-open="#new-contact-modal" style={PRIMARY}>
                  New contact
                </button>
              </>
            ) : null}
          </div>
        </div>

        {/* search + filter panel — plain GET, no island needed */}
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap;">
          <form id="contacts-search" method="get" action="/app/org/contacts" style="display:flex;gap:8px;margin:0;">
            {filters.company ? <input type="hidden" name="company" value={filters.company} /> : null}
            {filters.job_title ? <input type="hidden" name="job_title" value={filters.job_title} /> : null}
            {filters.tag ? <input type="hidden" name="tag" value={filters.tag} /> : null}
            <input
              name="q"
              value={filters.q}
              placeholder="Search name, email or company…"
              style="padding:7px 12px;border:1px solid #e2e3e8;background:#fff;font-size:13px;width:280px;outline-color:#4c5fd5;"
            />
            <button type="submit" style={BTN}>
              Search
            </button>
          </form>
          {/* The panel is positioned against this wrapper, so it drops under the
              button rather than the row — same shape as the header event switcher. */}
          <div style="position:relative;">
            <button type="button" data-toggle="#filter-panel" style={BTN}>
              Filter ▾
            </button>

            <div
              id="filter-panel"
              hidden
              style="position:absolute;top:calc(100% + 8px);left:0;width:340px;background:#fff;border:1px solid #e2e3e8;box-shadow:0 8px 24px rgba(22,23,29,0.12);z-index:50;padding:16px;"
            >
              <form method="get" action="/app/org/contacts" style="display:grid;gap:12px;margin:0;">
                <input type="hidden" name="q" value={filters.q} />
                {segmentOpts.length ? (
                  <div>
                    <div style={`${MICRO}margin-bottom:5px;`}>SEGMENT</div>
                    <select name="segment" style={`${SELECT}width:100%;`}>
                      <option value="">All segments</option>
                      {segmentOpts.map((o) => (
                        <option value={o.id} selected={segment?.id === o.id}>
                          {`${o.name} (${o.kind})`}
                        </option>
                      ))}
                    </select>
                    {segment?.kind === 'dynamic' ? (
                      <div style="font-size:11.5px;color:#9a9da6;line-height:1.45;margin-top:5px;">
                        A dynamic segment brings its own search and filters.
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div>
                  <div style={`${MICRO}margin-bottom:5px;`}>COMPANY</div>
                  <select name="company" style={`${SELECT}width:100%;`}>
                    <option value="">All companies</option>
                    {companyOpts.map((o) => (
                      <option value={o.value} selected={filters.company === o.value}>
                        {`${o.value} (${o.n})`}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <div style={`${MICRO}margin-bottom:5px;`}>JOB TITLE</div>
                  <select name="job_title" style={`${SELECT}width:100%;`}>
                    <option value="">All job titles</option>
                    {titleOpts.map((o) => (
                      <option value={o.value} selected={filters.job_title === o.value}>
                        {`${o.value} (${o.n})`}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <div style={`${MICRO}margin-bottom:5px;`}>TAG</div>
                  <select name="tag" style={`${SELECT}width:100%;`}>
                    <option value="">All tags</option>
                    {tagOpts.map((o) => (
                      <option value={o.value} selected={filters.tag === o.value}>
                        {`${o.value} (${o.n})`}
                      </option>
                    ))}
                  </select>
                </div>
                <div style="display:flex;gap:8px;align-items:center;">
                  <a href="/app/org/contacts" style="font-size:12.5px;margin-right:auto;">
                    Clear filters
                  </a>
                  <button type="submit" style={PRIMARY}>
                    Apply
                  </button>
                </div>
              </form>
            </div>
          </div>

          {active && canWrite ? (
            <button type="button" data-dialog-open="#segment-modal" style={BTN}>
              Save segment
            </button>
          ) : null}
        </div>

        {active || segment ? (
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">
            {segment ? (
              <FilterChip label="SEGMENT" value={segment.name} href={contactsHref(filters)} />
            ) : null}
            {filters.q ? <FilterChip label="SEARCH" value={filters.q} href={dropFilter({ q: '' })} /> : null}
            {filters.company ? (
              <FilterChip label="COMPANY" value={filters.company} href={dropFilter({ company: '' })} />
            ) : null}
            {filters.job_title ? (
              <FilterChip label="TITLE" value={filters.job_title} href={dropFilter({ job_title: '' })} />
            ) : null}
            {filters.tag ? <FilterChip label="TAG" value={filters.tag} href={dropFilter({ tag: '' })} /> : null}
            <a href="/app/org/contacts" style="font-size:12.5px;margin-left:4px;">
              Clear filters
            </a>
          </div>
        ) : null}

        {/* bulk bar — shown by the island once rows are checked */}
        <div
          id="bulk-bar"
          hidden
          style="display:flex;align-items:center;gap:8px;background:#16171d;color:#fff;padding:10px 14px;"
        >
          <span id="bulk-count" style={`font-family:${MONO};font-size:12px;`}>
            0 selected
          </span>
          <div style="width:1px;height:18px;background:#3a3b44;margin:0 4px;"></div>
          <button
            type="button"
            data-bulk-open="#communicate-modal"
            style="padding:6px 12px;background:#4c5fd5;color:#fff;border:none;font-size:12.5px;font-weight:600;cursor:pointer;"
          >
            Send Email
          </button>
          <button
            type="button"
            data-bulk-open="#add-event-modal"
            style="padding:6px 12px;background:transparent;color:#fff;border:1px solid #4a4b55;font-size:12.5px;cursor:pointer;"
          >
            Add to event
          </button>
          {canWrite ? (
            <button
              type="button"
              data-bulk-open="#bulk-segment-modal"
              style="padding:6px 12px;background:transparent;color:#fff;border:1px solid #4a4b55;font-size:12.5px;cursor:pointer;"
            >
              Save segment
            </button>
          ) : null}
          <button
            type="button"
            id="bulk-clear"
            style="margin-left:auto;background:none;border:none;color:#9a9da6;font-size:12.5px;cursor:pointer;"
          >
            Clear selection
          </button>
        </div>

        <div style="background:#fff;border:1px solid #e2e3e8;">
          <div style="overflow-x:auto;">
          <div
            style={`display:grid;${GRID}gap:10px;padding:10px 14px;border-bottom:1px solid #e2e3e8;align-items:center;min-width:1000px;${MICRO}`}
          >
            <div>
              <input type="checkbox" id="select-all" title="Select every row shown" />
            </div>
            <div></div>
            <div>NAME</div>
            <div>EMAIL</div>
            <div>COMPANY</div>
            <div>JOB TITLE</div>
            <div>TAGS</div>
            <div></div>
          </div>
          {rows.length ? (
            rows.map((r) => {
              const tags = jsonParse<string[]>(r.tags_json, []);
              return (
                <div
                  style={`display:grid;${GRID}gap:10px;padding:9px 14px;border-bottom:1px solid #f2f3f5;align-items:center;min-width:1000px;`}
                >
                  <div>
                    <input
                      type="checkbox"
                      data-row-check
                      value={r.id}
                      data-name={r.name || r.email}
                      data-email={r.email}
                    />
                  </div>
                  <Avatar row={r} />
                  <a
                    href={`/app/org/contact/${r.id}`}
                    style="font-size:13.5px;font-weight:600;color:#16171d;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
                  >
                    {r.name || r.email}
                  </a>
                  <div style={`font-family:${MONO};font-size:11.5px;color:#686b74;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`}>
                    {r.email}
                  </div>
                  <div style="font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                    {r.company || '—'}
                  </div>
                  <div style="font-size:12.5px;color:#686b74;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                    {r.job_title || '—'}
                  </div>
                  <div style="display:flex;gap:4px;flex-wrap:wrap;">
                    {tags.length ? (
                      tags.slice(0, 3).map((t) => (
                        <span style={`font-family:${MONO};font-size:9.5px;letter-spacing:0.06em;padding:2px 6px;background:#f1f3f5;color:#686b74;text-transform:uppercase;`}>
                          {t}
                        </span>
                      ))
                    ) : (
                      <span style="font-size:12px;color:#c9cbd2;">—</span>
                    )}
                  </div>
                  <a
                    href={`/app/org/contact/${r.id}`}
                    title="Edit contact"
                    style="justify-self:end;font-size:13px;color:#9a9da6;text-decoration:none;"
                  >
                    ✎
                  </a>
                </div>
              );
            })
          ) : (
            <div style="padding:44px 16px;text-align:center;font-size:13px;color:#686b74;">
              {active || segment
                ? 'No contacts match this view.'
                : 'No contacts yet. Every event speaker lands here — or add one by hand.'}
            </div>
          )}
          </div>
          <div style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-top:1px solid #e2e3e8;">
            <div style={`font-family:${MONO};font-size:11px;color:#686b74;`}>
              {total === 0
                ? 'Showing 0 of 0'
                : `Showing ${cur * PAGE_SIZE + 1}–${cur * PAGE_SIZE + rows.length} of ${total}`}
            </div>
            {pages > 1 ? (
              <div style="margin-left:auto;display:flex;gap:6px;">
                {cur > 0 ? (
                  <a href={pageLink(cur - 1)} style={PG_ON}>
                    ← Prev
                  </a>
                ) : (
                  <span style={PG_OFF}>← Prev</span>
                )}
                {cur < pages - 1 ? (
                  <a href={pageLink(cur + 1)} style={PG_ON}>
                    Next →
                  </a>
                ) : (
                  <span style={PG_OFF}>Next →</span>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------ new contact */}
      {canWrite ? (
        <div id="new-contact-modal" data-dialog hidden style={DIALOG}>
          <div style={PANEL}>
            <form method="post" action="/app/org/contacts/new" style="display:contents;">
              <div style="padding:18px 24px;border-bottom:1px solid #e2e3e8;display:flex;align-items:center;">
                <div style="font-size:16px;font-weight:700;">New contact</div>
                <button
                  type="button"
                  data-dialog-close="#new-contact-modal"
                  style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;"
                >
                  ✕
                </button>
              </div>
              <div style="padding:20px 24px;display:grid;gap:14px;overflow-y:auto;">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                  <div>
                    <div style={`${MICRO}margin-bottom:6px;`}>NAME</div>
                    <input name="name" required style={INPUT} />
                  </div>
                  <div>
                    <div style={`${MICRO}margin-bottom:6px;`}>EMAIL</div>
                    <input name="email" type="email" required style={INPUT} />
                  </div>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                  <div>
                    <div style={`${MICRO}margin-bottom:6px;`}>COMPANY</div>
                    <input name="company" style={INPUT} />
                  </div>
                  <div>
                    <div style={`${MICRO}margin-bottom:6px;`}>JOB TITLE</div>
                    <input name="job_title" style={INPUT} />
                  </div>
                </div>
                <div>
                  <div style={`${MICRO}margin-bottom:6px;`}>BIO</div>
                  <textarea name="bio" rows={5} style={TEXTAREA}></textarea>
                </div>
                <div style="font-size:12.5px;color:#686b74;">
                  Contacts are matched by email. An address already in the directory is filled in, not duplicated.
                </div>
              </div>
              <div style="padding:14px 24px;border-top:1px solid #e2e3e8;display:flex;gap:8px;justify-content:flex-end;">
                <button type="button" data-dialog-close="#new-contact-modal" style={BTN}>
                  Cancel
                </button>
                <button type="submit" style={PRIMARY}>
                  Add contact
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* ----------------------------------------------------------- import */}
      {canWrite ? (
        <div id="import-modal" data-dialog hidden style={DIALOG}>
          <div style={PANEL}>
            <form method="post" action="/app/org/contacts/import" enctype="multipart/form-data" style="display:contents;">
              <div style="padding:18px 24px;border-bottom:1px solid #e2e3e8;display:flex;align-items:center;">
                <div style="font-size:16px;font-weight:700;">Import contacts from CSV</div>
                <button
                  type="button"
                  data-dialog-close="#import-modal"
                  style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;"
                >
                  ✕
                </button>
              </div>
              <div style="padding:20px 24px;display:grid;gap:14px;overflow-y:auto;">
                <div>
                  <div style={`${MICRO}margin-bottom:6px;`}>CSV FILE</div>
                  <input type="file" name="file" id="import-file" accept=".csv,text/csv" required style="font-size:13px;" />
                </div>
                <div style="font-size:12.5px;color:#686b74;line-height:1.55;">
                  First row is the header. Columns are matched by name — you can adjust the mapping on the next step.
                  Contacts are matched by email, so a row for someone already here updates them.
                </div>
              </div>
              <div style="padding:14px 24px;border-top:1px solid #e2e3e8;display:flex;gap:8px;justify-content:flex-end;">
                <button type="button" data-dialog-close="#import-modal" style={BTN}>
                  Cancel
                </button>
                <button type="submit" id="import-next" style={PRIMARY}>
                  Continue
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* ------------------------------------------------------ communicate */}
      {canWrite ? (
        <div id="communicate-modal" data-dialog hidden style={DIALOG}>
          <div style={`${PANEL}width:620px;`}>
            <form method="post" action="/app/org/contacts/communicate" style="display:contents;">
              <input type="hidden" name="ids" data-bulk-ids value="" />
              <div style="padding:18px 24px;border-bottom:1px solid #e2e3e8;display:flex;align-items:center;">
                <div style="font-size:16px;font-weight:700;">Send Email</div>
                <button
                  type="button"
                  data-dialog-close="#communicate-modal"
                  style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;"
                >
                  ✕
                </button>
              </div>
              <div style="padding:20px 24px;display:grid;gap:14px;overflow-y:auto;">
                <div>
                  <div id="comm-recip-label" style={`${MICRO}margin-bottom:6px;`}>
                    RECIPIENTS
                  </div>
                  <div
                    id="comm-recipients"
                    style="border:1px solid #e2e3e8;padding:10px 12px;font-size:12.5px;color:#686b74;max-height:110px;overflow-y:auto;"
                  ></div>
                </div>
                <div>
                  <div style={`${MICRO}margin-bottom:6px;`}>SUBJECT</div>
                  <input name="subject" required style={`${INPUT}font-weight:600;`} />
                </div>
                <div>
                  <div style={`${MICRO}margin-bottom:6px;`}>BODY</div>
                  <textarea name="body" rows={10} required style={TEXTAREA}></textarea>
                  <div style={`font-family:${MONO};font-size:10.5px;color:#9a9da6;margin-top:4px;`}>
                    {'Merge tags resolve per recipient: {{first_name}} {{name}} {{company}} {{email}}'}
                  </div>
                </div>
                <div>
                  <button
                    type="button"
                    id="comm-preview-btn"
                    style="background:none;border:none;padding:0;font-size:12.5px;color:#4c5fd5;cursor:pointer;"
                  >
                    Preview first recipient
                  </button>
                  <div
                    id="comm-preview"
                    hidden
                    style="margin-top:8px;border:1px solid #e2e3e8;background:#f8f8fa;padding:12px 14px;font-size:12.5px;line-height:1.55;color:#33343c;white-space:pre-wrap;"
                  ></div>
                </div>
              </div>
              <div style="padding:14px 24px;border-top:1px solid #e2e3e8;display:flex;gap:8px;justify-content:flex-end;">
                <button type="button" data-dialog-close="#communicate-modal" style={BTN}>
                  Cancel
                </button>
                <button type="submit" style={PRIMARY}>
                  Send
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* ----------------------------------------------------- add to event */}
      {canWrite ? (
        <div id="add-event-modal" data-dialog hidden style={DIALOG}>
          <div style={`${PANEL}width:460px;`}>
            <form method="post" action="/app/org/contacts/add-to-event" style="display:contents;">
              <input type="hidden" name="ids" data-bulk-ids value="" />
              <div style="padding:18px 24px;border-bottom:1px solid #e2e3e8;display:flex;align-items:center;">
                <div style="font-size:16px;font-weight:700;">Add to event</div>
                <button
                  type="button"
                  data-dialog-close="#add-event-modal"
                  style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;"
                >
                  ✕
                </button>
              </div>
              <div style="padding:20px 24px;display:grid;gap:12px;">
                <div id="add-event-summary" style={MICRO}>
                  NO CONTACTS SELECTED
                </div>
                <div>
                  <div style={`${MICRO}margin-bottom:6px;`}>EVENT</div>
                  <select name="event_id" required style={`${SELECT}width:100%;`}>
                    {events.map((e) => (
                      <option value={e.id} selected={e.id === c.var.event?.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div style="font-size:12.5px;color:#686b74;line-height:1.55;">
                  Each contact becomes a speaker on that event. Someone already on it is left alone.
                </div>
              </div>
              <div style="padding:14px 24px;border-top:1px solid #e2e3e8;display:flex;gap:8px;justify-content:flex-end;">
                <button type="button" data-dialog-close="#add-event-modal" style={BTN}>
                  Cancel
                </button>
                <button type="submit" style={PRIMARY}>
                  Add
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* --------------------------------------- save segment (from selection) */}
      {canWrite ? (
        <div id="bulk-segment-modal" data-dialog hidden style={DIALOG}>
          <div style={`${PANEL}width:460px;`}>
            <form method="post" action="/app/org/segments/new" style="display:contents;">
              <input type="hidden" name="kind" value="curated" />
              <input type="hidden" name="ids" data-bulk-ids value="" />
              <div style="padding:18px 24px;border-bottom:1px solid #e2e3e8;display:flex;align-items:center;">
                <div style="font-size:16px;font-weight:700;">Save segment</div>
                <button
                  type="button"
                  data-dialog-close="#bulk-segment-modal"
                  style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;"
                >
                  ✕
                </button>
              </div>
              <div style="padding:20px 24px;display:grid;gap:14px;">
                <div>
                  <div style={`${MICRO}margin-bottom:6px;`}>NAME</div>
                  <input name="name" required placeholder="e.g. Berlin keynotes" style={INPUT} />
                </div>
                <div id="bulk-segment-summary" style="font-size:12.5px;color:#686b74;line-height:1.55;">
                  Curated segment with 0 selected contacts.
                </div>
              </div>
              <div style="padding:14px 24px;border-top:1px solid #e2e3e8;display:flex;gap:8px;justify-content:flex-end;">
                <button type="button" data-dialog-close="#bulk-segment-modal" style={BTN}>
                  Cancel
                </button>
                <button type="submit" style={PRIMARY}>
                  Save segment
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* ------------------------------------------ save segment (from filters) */}
      {canWrite && active ? (
        <div id="segment-modal" data-dialog hidden style={DIALOG}>
          <div style={`${PANEL}width:460px;`}>
            <form method="post" action="/app/org/segments/new" style="display:contents;">
              <input type="hidden" name="query" value={filterQuery(filters)} />
              <input type="hidden" name="ids" value={shownIds} />
              <div style="padding:18px 24px;border-bottom:1px solid #e2e3e8;display:flex;align-items:center;">
                <div style="font-size:16px;font-weight:700;">Save segment</div>
                <button
                  type="button"
                  data-dialog-close="#segment-modal"
                  style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;"
                >
                  ✕
                </button>
              </div>
              <div style="padding:20px 24px;display:grid;gap:14px;">
                <div>
                  <div style={`${MICRO}margin-bottom:6px;`}>NAME</div>
                  <input name="name" required placeholder="e.g. Berlin keynotes" style={INPUT} />
                </div>
                <div>
                  <div style={`${MICRO}margin-bottom:8px;`}>TYPE</div>
                  <label style="display:flex;gap:9px;align-items:flex-start;border:1px solid #e2e3e8;padding:11px 13px;cursor:pointer;margin-bottom:8px;">
                    <input type="radio" name="kind" value="dynamic" checked style="margin-top:2px;" />
                    <span>
                      <span style="display:block;font-size:13px;font-weight:600;">Dynamic</span>
                      <span style="display:block;font-size:11.5px;color:#9a9da6;line-height:1.45;">
                        Stores this search. Members update as contacts change.
                      </span>
                    </span>
                  </label>
                  <label style="display:flex;gap:9px;align-items:flex-start;border:1px solid #e2e3e8;padding:11px 13px;cursor:pointer;">
                    <input type="radio" name="kind" value="curated" style="margin-top:2px;" />
                    <span>
                      <span style="display:block;font-size:13px;font-weight:600;">Curated</span>
                      <span style="display:block;font-size:11.5px;color:#9a9da6;line-height:1.45;">
                        {rows.length === total
                          ? `Freezes the ${rows.length} contacts matching right now.`
                          : `Freezes the ${rows.length} contacts on this page, out of ${total} matching.`}
                      </span>
                    </span>
                  </label>
                </div>
              </div>
              <div style="padding:14px 24px;border-top:1px solid #e2e3e8;display:flex;gap:8px;justify-content:flex-end;">
                <button type="button" data-dialog-close="#segment-modal" style={BTN}>
                  Cancel
                </button>
                <button type="submit" style={PRIMARY}>
                  Save segment
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </AdminLayout>
  );
});

/* ---------------------------------------------------------- create contact */

app.post('/app/org/contacts/new', requireOrgRole('admin'), async (c) => {
  if (!c.var.event) return c.redirect('/app/events/new');
  const orgId = orgIdForRequest(c)!;
  const form = await c.req.parseBody();
  const email = String(form.email ?? '').trim();
  const name = String(form.name ?? '').trim();
  if (!email || !name) return redirectWithToast(c, '/app/org/contacts', 'A contact needs a name and an email');
  if (!validEmail(email)) return redirectWithToast(c, '/app/org/contacts', `“${email}” doesn’t look like an email`);

  const existed = await one<{ id: string }>(
    c.env.DB,
    `SELECT id FROM org_contacts WHERE org_id = ? AND email = ?`,
    orgId,
    email
  );
  const id = await upsertOrgContact(
    c.env.DB,
    orgId,
    {
      email,
      name,
      company: String(form.company ?? ''),
      job_title: String(form.job_title ?? ''),
      bio: String(form.bio ?? ''),
    },
    'manual'
  );
  if (!id) return redirectWithToast(c, '/app/org/contacts', 'Couldn’t save that contact');
  return redirectWithToast(
    c,
    `/app/org/contact/${id}`,
    existed ? `${name} was already in the directory — filled in what was missing` : `${name} added to the directory`
  );
});

/* ----------------------------------------------------------------- import */

/** Column targets an imported CSV can be mapped to. */
const IMPORT_TARGETS: { value: string; label: string }[] = [
  { value: 'ignore', label: 'Ignore' },
  { value: 'name', label: 'Name' },
  { value: 'email', label: 'Email' },
  { value: 'company', label: 'Company' },
  { value: 'job_title', label: 'Job title' },
  { value: 'bio', label: 'Bio' },
];

/** Header text → target, matched case-insensitively with common variants. */
const HEADER_TARGETS: Record<string, string> = {
  name: 'name',
  full_name: 'name',
  fullname: 'name',
  speaker: 'name',
  speaker_name: 'name',
  contact: 'name',
  contact_name: 'name',
  email: 'email',
  e_mail: 'email',
  email_address: 'email',
  mail: 'email',
  company: 'company',
  organisation: 'company',
  organization: 'company',
  org: 'company',
  employer: 'company',
  affiliation: 'company',
  job_title: 'job_title',
  jobtitle: 'job_title',
  title: 'job_title',
  role: 'job_title',
  position: 'job_title',
  bio: 'bio',
  biography: 'bio',
  about: 'bio',
};

function autoTarget(header: string): string {
  const key = header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return HEADER_TARGETS[key] ?? 'ignore';
}

type FlaggedRow = { line: number; email: string; name: string; note: string; skip: boolean };

/**
 * Walk the sheet with a mapping and report what each row will do. Shared by the
 * review step and the run step, so the preview and the write never disagree.
 */
function inspectRows(
  rows: string[][],
  mapping: string[],
  knownEmails: Set<string>
): { flagged: FlaggedRow[]; willCreate: number; willUpdate: number; willSkip: number } {
  const seen = new Set<string>();
  const flagged: FlaggedRow[] = [];
  let willCreate = 0;
  let willUpdate = 0;
  let willSkip = 0;

  rows.forEach((cells, index) => {
    const line = index + 2; // header is line 1
    const pick = (target: string) => {
      const col = mapping.indexOf(target);
      return col === -1 ? '' : (cells[col] ?? '').trim();
    };
    const email = pick('email');
    const name = pick('name');

    if (!email) {
      flagged.push({ line, email: '', name, note: 'no email — skipped', skip: true });
      willSkip++;
      return;
    }
    if (!validEmail(email)) {
      flagged.push({ line, email, name, note: 'invalid email — skipped', skip: true });
      willSkip++;
      return;
    }
    const key = email.toLowerCase();
    if (seen.has(key)) {
      flagged.push({ line, email, name, note: 'duplicate in this file — skipped', skip: true });
      willSkip++;
      return;
    }
    seen.add(key);
    if (knownEmails.has(key)) {
      flagged.push({ line, email, name, note: 'already in the directory — will update', skip: false });
      willUpdate++;
      return;
    }
    willCreate++;
  });

  return { flagged, willCreate, willUpdate, willSkip };
}

/** Step 1 → 2: read the uploaded file, guess the mapping, show what will happen. */
app.post('/app/org/contacts/import', requireOrgRole('admin'), async (c) => {
  const props = await adminProps(c, 'Import contacts', {
    headerTitle: 'Import contacts',
    scripts: ['/js/org-directory.js'],
  });
  if (!c.var.event) return c.redirect('/app/events/new');
  const orgId = orgIdForRequest(c)!;

  const form = await c.req.parseBody();
  const file = form.file;
  const text = file instanceof File ? await file.text() : String(form.csv ?? '');
  if (!text.trim()) return redirectWithToast(c, '/app/org/contacts', 'That file looked empty');

  const table = parseCsvTable(text);
  if (!table.headers.length) return redirectWithToast(c, '/app/org/contacts', 'No header row found');
  if (!table.rows.length) return redirectWithToast(c, '/app/org/contacts', 'No data rows found below the header');
  if (table.rows.length > IMPORT_MAX_ROWS) {
    return redirectWithToast(c, '/app/org/contacts', `Import at most ${IMPORT_MAX_ROWS} rows at a time`);
  }

  // Later columns never steal a target an earlier column already claimed.
  const taken = new Set<string>();
  const mapping = table.headers.map((h) => {
    const t = autoTarget(h);
    if (t === 'ignore' || taken.has(t)) return 'ignore';
    taken.add(t);
    return t;
  });

  const known = await all<{ email: string }>(c.env.DB, `SELECT email FROM org_contacts WHERE org_id = ?`, orgId);
  const knownEmails = new Set(known.map((r) => r.email.toLowerCase()));
  const report = inspectRows(table.rows, mapping, knownEmails);

  return c.html(
    <AdminLayout {...props}>
      <div style="padding:24px 28px;max-width:860px;">
        <a href="/app/org/contacts" style="font-size:12.5px;">
          ← Back to the directory
        </a>
        <form method="post" action="/app/org/contacts/import/run" style="margin-top:12px;">
          <textarea name="csv" hidden>
            {text}
          </textarea>
          <div style="background:#fff;border:1px solid #e2e3e8;">
            <div style="padding:14px 20px;border-bottom:1px solid #e2e3e8;">
              <div style={MICRO}>
                {`STEP 2 OF 2 · ${table.rows.length} ROWS · ${table.headers.length} COLUMNS`}
              </div>
              <div style="font-size:16px;font-weight:700;margin-top:4px;">Check the mapping</div>
            </div>

            <div style="padding:18px 20px;border-bottom:1px solid #e2e3e8;display:grid;gap:8px;">
              {table.headers.map((h, i) => (
                <div style="display:grid;grid-template-columns:minmax(0,1fr) 200px;gap:12px;align-items:center;">
                  <div style="min-width:0;">
                    <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                      {h || `(column ${i + 1})`}
                    </div>
                    <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`}>
                      {(table.rows[0]?.[i] ?? '').slice(0, 60) || '—'}
                    </div>
                  </div>
                  <select name={`map_${i}`} style={`${SELECT}width:100%;`}>
                    {IMPORT_TARGETS.map((t) => (
                      <option value={t.value} selected={mapping[i] === t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <div style="padding:18px 20px;">
              <div style={`${MICRO}margin-bottom:8px;`}>WHAT THIS IMPORT WILL DO</div>
              <div style="display:flex;gap:20px;margin-bottom:14px;">
                {[
                  ['CREATE', report.willCreate],
                  ['UPDATE', report.willUpdate],
                  ['SKIP', report.willSkip],
                ].map(([label, n]) => (
                  <div>
                    <div style={`font-family:${MONO};font-size:20px;font-weight:600;`}>{n as number}</div>
                    <div style={MICRO}>{label as string}</div>
                  </div>
                ))}
              </div>
              {report.flagged.length ? (
                <div style="border:1px solid #e2e3e8;max-height:260px;overflow-y:auto;">
                  {report.flagged.slice(0, 100).map((r) => (
                    <div style="display:grid;grid-template-columns:64px minmax(0,1fr) 220px;gap:10px;padding:7px 12px;border-bottom:1px solid #f2f3f5;align-items:center;">
                      <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;`}>{`LINE ${r.line}`}</div>
                      <div style="font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                        {r.email || r.name || '—'}
                      </div>
                      <div style={`font-size:11.5px;color:${r.skip ? '#c92a2a' : '#b08800'};`}>{r.note}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style="font-size:12.5px;color:#686b74;">Every row is a clean new contact.</div>
              )}
              {mapping.includes('email') ? null : (
                <div style="margin-top:12px;border:1px solid #e03131;background:#fbe9e9;color:#c92a2a;padding:8px 10px;font-size:12.5px;">
                  Map one column to Email — contacts are matched by email address.
                </div>
              )}
            </div>

            <div style="padding:14px 20px;border-top:1px solid #e2e3e8;display:flex;gap:8px;justify-content:flex-end;">
              <a href="/app/org/contacts" style={`${BTN}text-decoration:none;color:#16171d;`}>
                Cancel
              </a>
              <button type="submit" style={PRIMARY}>
                Import contacts
              </button>
            </div>
          </div>
        </form>
      </div>
    </AdminLayout>
  );
});

/** Step 2 → done: re-parse the same text server-side, then write. */
app.post('/app/org/contacts/import/run', requireOrgRole('admin'), async (c) => {
  if (!c.var.event) return c.redirect('/app/events/new');
  const orgId = orgIdForRequest(c)!;
  const form = await c.req.parseBody();
  const text = String(form.csv ?? '');
  if (!text.trim()) return redirectWithToast(c, '/app/org/contacts', 'That file looked empty');

  const table = parseCsvTable(text);
  if (!table.rows.length) return redirectWithToast(c, '/app/org/contacts', 'No data rows found below the header');
  if (table.rows.length > IMPORT_MAX_ROWS) {
    return redirectWithToast(c, '/app/org/contacts', `Import at most ${IMPORT_MAX_ROWS} rows at a time`);
  }

  const mapping = table.headers.map((_, i) => String(form[`map_${i}`] ?? 'ignore'));
  if (!mapping.includes('email')) {
    return redirectWithToast(c, '/app/org/contacts', 'Map one column to Email — contacts are matched by email address');
  }

  const known = await all<{ email: string }>(c.env.DB, `SELECT email FROM org_contacts WHERE org_id = ?`, orgId);
  const knownEmails = new Set(known.map((r) => r.email.toLowerCase()));
  const seen = new Set<string>();
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const cells of table.rows) {
    const pick = (target: string) => {
      const col = mapping.indexOf(target);
      return col === -1 ? '' : (cells[col] ?? '').trim();
    };
    const email = pick('email');
    if (!email || !validEmail(email)) {
      skipped++;
      continue;
    }
    const key = email.toLowerCase();
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    const existed = knownEmails.has(key);
    const id = await upsertOrgContact(
      c.env.DB,
      orgId,
      { email, name: pick('name'), company: pick('company'), job_title: pick('job_title'), bio: pick('bio') },
      'import'
    );
    if (!id) {
      skipped++;
      continue;
    }
    if (existed) updated++;
    else created++;
  }

  return redirectWithToast(
    c,
    '/app/org/contacts',
    `Import done — ${created} created · ${updated} updated · ${skipped} skipped`
  );
});

/* ------------------------------------------------------------ communicate */

app.post('/app/org/contacts/communicate', requireOrgRole('admin'), async (c) => {
  if (!c.var.event) return c.redirect('/app/events/new');
  const orgId = orgIdForRequest(c)!;
  const form = await c.req.parseBody();
  const ids = idList(form.ids);
  const subject = String(form.subject ?? '').trim();
  const body = String(form.body ?? '').trim();
  if (!ids.length) return redirectWithToast(c, '/app/org/contacts', 'Select contacts first');
  if (!subject || !body) return redirectWithToast(c, '/app/org/contacts', 'A message needs a subject and a body');

  const recipients = await all<{ id: string; email: string; name: string; company: string }>(
    c.env.DB,
    `SELECT id, email, name, company FROM org_contacts
      WHERE org_id = ? AND id IN (SELECT value FROM json_each(?))`,
    orgId,
    JSON.stringify(ids)
  );
  if (!recipients.length) return redirectWithToast(c, '/app/org/contacts', 'Those contacts are no longer here');

  const batch = recipients.slice(0, SEND_MAX);
  let sent = 0;
  let simulated = 0;
  let failed = 0;
  for (const r of batch) {
    const vars = contactVars(r);
    const res = await sendEmail(c.env, {
      orgId,
      eventId: null,
      to: r.email,
      toName: r.name,
      subject: renderTemplate(subject, vars),
      text: renderTemplate(body, vars),
      subjectType: 'org_contact',
      subjectId: r.id,
    });
    if (res.status === 'sent') sent++;
    else if (res.status === 'simulated') simulated++;
    else failed++;
  }

  let msg = `Sent to ${sent + simulated} contact${sent + simulated === 1 ? '' : 's'}`;
  if (simulated && !sent) msg = `${simulated} email${simulated === 1 ? '' : 's'} simulated — sending is off for this org`;
  if (failed) msg += ` · ${failed} failed`;
  if (recipients.length > batch.length) msg += ` · ${recipients.length - batch.length} left over — send again`;
  return redirectWithToast(c, '/app/org/contacts', msg);
});

/** Resolve the merge tags for the first recipient, so the composer can preview. */
app.post('/app/api/org/contacts/preview', async (c) => {
  if (!c.var.event) return c.json({ ok: false, error: 'No event selected' }, 400);
  const orgId = orgIdForRequest(c)!;
  const input = await c.req.json<{ id?: string; subject?: string; body?: string }>().catch(() => null);
  if (!input?.id) return c.json({ ok: false, error: 'Pick a recipient first' }, 400);
  const row = await one<{ email: string; name: string; company: string }>(
    c.env.DB,
    `SELECT email, name, company FROM org_contacts WHERE id = ? AND org_id = ?`,
    input.id,
    orgId
  );
  if (!row) return c.json({ ok: false, error: 'That contact is no longer here' }, 400);
  const vars = contactVars(row);
  return c.json({
    ok: true,
    to: row.email,
    subject: renderTemplate(String(input.subject ?? ''), vars),
    body: renderTemplate(String(input.body ?? ''), vars),
  });
});

/* ----------------------------------------------------------- add to event */

app.post('/app/org/contacts/add-to-event', requireOrgRole('admin'), async (c) => {
  if (!c.var.event) return c.redirect('/app/events/new');
  const orgId = orgIdForRequest(c)!;
  const form = await c.req.parseBody();
  const ids = idList(form.ids);
  const eventId = String(form.event_id ?? '');
  if (!ids.length) return redirectWithToast(c, '/app/org/contacts', 'Select contacts first');

  const event = await one<{ id: string; name: string }>(
    c.env.DB,
    `SELECT id, name FROM events WHERE id = ? AND org_id = ?`,
    eventId,
    orgId
  );
  if (!event) return redirectWithToast(c, '/app/org/contacts', 'That event isn’t in this organization');

  const valid = await all<{ id: string }>(
    c.env.DB,
    `SELECT id FROM org_contacts WHERE org_id = ? AND id IN (SELECT value FROM json_each(?))`,
    orgId,
    JSON.stringify(ids)
  );

  let added = 0;
  let already = 0;
  for (const row of valid.slice(0, SEND_MAX)) {
    const res = await addContactToEvent(c.env.DB, row.id, event.id);
    if (!res) continue;
    if (res.created) added++;
    else already++;
  }
  return redirectWithToast(
    c,
    '/app/org/contacts',
    `Added ${added} to ${event.name}${already ? ` (${already} already present)` : ''}`
  );
});

/* --------------------------------------------------------------- segments */

/** Contacts offered in the curated picker. One page, one subrequest. */
const BUILDER_LIMIT = 200;

/** What the builder form holds — used to render it and to fill it back in. */
type Builder = Filters & { name: string; kind: 'curated' | 'dynamic'; ids: string[] };

const NEW_SEGMENT: Builder = { ...EMPTY, name: '', kind: 'curated', ids: [] };

/**
 * The Create segment page. The POST re-renders it on a validation error, so
 * the form comes back the way it was submitted.
 */
async function renderSegmentBuilder(c: Context<Ctx>, form: Builder, error: string | null) {
  const props = await adminProps(c, 'Create segment', {
    headerTitle: 'Create segment',
    scripts: ['/js/org-directory.js'],
  });
  const orgId = orgIdForRequest(c)!;

  const [contacts, totalRow, companyOpts, titleOpts, tagOpts] = await Promise.all([
    all<{ id: string; name: string; email: string; company: string }>(
      c.env.DB,
      `SELECT id, name, email, company FROM org_contacts
        WHERE org_id = ? ORDER BY name COLLATE NOCASE LIMIT ${BUILDER_LIMIT}`,
      orgId
    ),
    one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM org_contacts WHERE org_id = ?`, orgId),
    all<{ value: string; n: number }>(
      c.env.DB,
      `SELECT company AS value, COUNT(*) AS n FROM org_contacts
        WHERE org_id = ? AND company != '' GROUP BY company ORDER BY n DESC, company LIMIT 60`,
      orgId
    ),
    all<{ value: string; n: number }>(
      c.env.DB,
      `SELECT job_title AS value, COUNT(*) AS n FROM org_contacts
        WHERE org_id = ? AND job_title != '' GROUP BY job_title ORDER BY n DESC, job_title LIMIT 60`,
      orgId
    ),
    all<{ value: string; n: number }>(
      c.env.DB,
      `SELECT je.value AS value, COUNT(*) AS n FROM org_contacts c, json_each(c.tags_json) je
        WHERE c.org_id = ? GROUP BY je.value ORDER BY n DESC, value LIMIT 60`,
      orgId
    ),
  ]);

  const total = totalRow?.n ?? 0;
  const checked = new Set(form.ids);

  return c.html(
    <AdminLayout {...props}>
      <div style="padding:24px 28px;max-width:860px;">
        <a href="/app/org/contacts?tab=segments" style="font-size:12.5px;">
          ← Back to segments
        </a>
        <form method="post" action="/app/org/segments/new" style="margin-top:12px;">
          <input type="hidden" name="from" value="builder" />
          <div style="background:#fff;border:1px solid #e2e3e8;">
            <div style="padding:14px 20px;border-bottom:1px solid #e2e3e8;">
              <div style={MICRO}>NEW SEGMENT</div>
              <div style="font-size:16px;font-weight:700;margin-top:4px;">Create segment</div>
            </div>

            {error ? (
              <div style="margin:16px 20px -4px;border:1px solid #e03131;background:#fbe9e9;color:#c92a2a;padding:8px 10px;font-size:12.5px;">
                {error}
              </div>
            ) : null}

            <div style="padding:18px 20px;border-bottom:1px solid #e2e3e8;">
              <div style={`${MICRO}margin-bottom:6px;`}>NAME</div>
              <input name="name" required value={form.name} placeholder="e.g. Berlin keynotes" style={INPUT} />
            </div>

            {/* curated */}
            <div data-seg-section="curated" style="padding:18px 20px;border-bottom:1px solid #e2e3e8;">
              <label style="display:flex;gap:9px;align-items:flex-start;cursor:pointer;">
                <input
                  type="radio"
                  name="kind"
                  value="curated"
                  checked={form.kind === 'curated'}
                  style="margin-top:3px;"
                />
                <span>
                  <span style="display:block;font-size:13px;font-weight:600;">Curated</span>
                  <span style="display:block;font-size:11.5px;color:#9a9da6;line-height:1.45;">
                    Pick contacts by hand. The list stays as you saved it.
                  </span>
                </span>
              </label>

              {contacts.length ? (
                <div style="margin-top:12px;display:grid;gap:10px;">
                  <div style="display:flex;align-items:center;gap:12px;">
                    <input
                      id="seg-q"
                      type="search"
                      placeholder="Filter by name, email or company…"
                      style={`${INPUT}max-width:320px;`}
                    />
                    <div id="seg-count" style={`font-family:${MONO};font-size:11.5px;color:#686b74;`}>
                      {`${checked.size} selected`}
                    </div>
                  </div>
                  <div style="border:1px solid #e2e3e8;max-height:340px;overflow-y:auto;">
                    {contacts.map((r) => (
                      <label
                        data-seg-row
                        data-search={`${r.name} ${r.email} ${r.company}`.toLowerCase()}
                        style="display:grid;grid-template-columns:18px minmax(0,1fr) 150px;gap:10px;align-items:center;padding:8px 12px;border-bottom:1px solid #f2f3f5;cursor:pointer;"
                      >
                        <input
                          type="checkbox"
                          data-seg-check
                          name="ids"
                          value={r.id}
                          checked={checked.has(r.id)}
                          style="cursor:pointer;"
                        />
                        <div style="min-width:0;">
                          <div style="font-size:13px;color:#16171d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                            {r.name || r.email}
                          </div>
                          <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`}>
                            {r.email}
                          </div>
                        </div>
                        <div style="font-size:12px;color:#686b74;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                          {r.company || '—'}
                        </div>
                      </label>
                    ))}
                  </div>
                  <div id="seg-empty" hidden style="font-size:12.5px;color:#9a9da6;">
                    No contact matches that filter.
                  </div>
                  {total > BUILDER_LIMIT ? (
                    <div style="font-size:11.5px;color:#9a9da6;line-height:1.45;">
                      {`Showing the first ${BUILDER_LIMIT} of ${total} contacts. Use a dynamic segment to reach the rest.`}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div style="margin-top:12px;font-size:12.5px;color:#686b74;">
                  No contacts in the directory yet.
                </div>
              )}
            </div>

            {/* dynamic */}
            <div data-seg-section="dynamic" style="padding:18px 20px;">
              <label style="display:flex;gap:9px;align-items:flex-start;cursor:pointer;">
                <input
                  type="radio"
                  name="kind"
                  value="dynamic"
                  checked={form.kind === 'dynamic'}
                  style="margin-top:3px;"
                />
                <span>
                  <span style="display:block;font-size:13px;font-weight:600;">Dynamic</span>
                  <span style="display:block;font-size:11.5px;color:#9a9da6;line-height:1.45;">
                    Stores the criteria below. Members update as contacts change.
                  </span>
                </span>
              </label>
              <div style="margin-top:12px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;">
                <div>
                  <div style={`${MICRO}margin-bottom:5px;`}>COMPANY</div>
                  <select name="company" style={`${SELECT}width:100%;`}>
                    <option value="">All companies</option>
                    {companyOpts.map((o) => (
                      <option value={o.value} selected={form.company === o.value}>
                        {`${o.value} (${o.n})`}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <div style={`${MICRO}margin-bottom:5px;`}>JOB TITLE</div>
                  <select name="job_title" style={`${SELECT}width:100%;`}>
                    <option value="">All job titles</option>
                    {titleOpts.map((o) => (
                      <option value={o.value} selected={form.job_title === o.value}>
                        {`${o.value} (${o.n})`}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <div style={`${MICRO}margin-bottom:5px;`}>TAG</div>
                  <select name="tag" style={`${SELECT}width:100%;`}>
                    <option value="">All tags</option>
                    {tagOpts.map((o) => (
                      <option value={o.value} selected={form.tag === o.value}>
                        {`${o.value} (${o.n})`}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div style="margin-top:12px;">
                <div style={`${MICRO}margin-bottom:5px;`}>SEARCH TEXT</div>
                <input name="q" value={form.q} placeholder="Optional — name, email or company" style={INPUT} />
              </div>
            </div>

            <div style="padding:14px 20px;border-top:1px solid #e2e3e8;display:flex;gap:8px;justify-content:flex-end;">
              <a href="/app/org/contacts?tab=segments" style={`${BTN}text-decoration:none;color:#16171d;`}>
                Cancel
              </a>
              <button type="submit" style={PRIMARY}>
                Create segment
              </button>
            </div>
          </div>
        </form>
      </div>
    </AdminLayout>
  );
}

app.get('/app/org/segments/new', requireOrgRole('admin'), async (c) => {
  if (!c.var.event) return c.redirect('/app/events/new');
  return renderSegmentBuilder(c, NEW_SEGMENT, null);
});

app.post('/app/org/segments/new', requireOrgRole('admin'), async (c) => {
  if (!c.var.event) return c.redirect('/app/events/new');
  const orgId = orgIdForRequest(c)!;
  const form = await c.req.parseBody({ all: true });

  // The builder posts its criteria as fields; the two modals post a ready-made
  // querystring and a list of ids.
  const fromBuilder = String(form.from ?? '') === 'builder';
  const name = String(form.name ?? '').trim();
  const kind = String(form.kind ?? 'dynamic') === 'curated' ? 'curated' : 'dynamic';
  const filters = readFilters(
    new URLSearchParams({
      q: String(form.q ?? ''),
      company: String(form.company ?? ''),
      job_title: String(form.job_title ?? ''),
      tag: String(form.tag ?? ''),
    })
  );
  const query = String(form.query ?? '') || filterQuery(filters);
  const posted = idList(form.ids);

  // Never store an id from another org.
  const ids = posted.length
    ? (
        await all<{ id: string }>(
          c.env.DB,
          `SELECT id FROM org_contacts WHERE org_id = ? AND id IN (SELECT value FROM json_each(?))`,
          orgId,
          JSON.stringify(posted)
        )
      ).map((r) => r.id)
    : [];

  const reject = (message: string) =>
    fromBuilder
      ? renderSegmentBuilder(c, { ...filters, name, kind, ids: posted }, message)
      : redirectWithToast(c, '/app/org/contacts', message);

  if (!name) return reject('A segment needs a name');
  if (kind === 'dynamic' && !query) {
    return reject(fromBuilder ? 'A dynamic segment needs at least one criterion' : 'Search or filter first, then save');
  }
  if (kind === 'curated' && !ids.length) {
    return reject(fromBuilder ? 'Pick at least one contact' : 'No contacts match right now');
  }

  const id = newId('seg');
  await run(
    c.env.DB,
    `INSERT INTO org_segments (id, org_id, name, kind, query, member_ids_json, created_at) VALUES (?,?,?,?,?,?,?)`,
    id,
    orgId,
    name,
    kind,
    kind === 'dynamic' ? query : '',
    kind === 'curated' ? JSON.stringify(ids) : null,
    now()
  );
  return redirectWithToast(c, `/app/org/contacts?segment=${id}`, `Segment “${name}” saved`);
});

app.post('/app/org/segments/:id/delete', requireOrgRole('admin'), async (c) => {
  if (!c.var.event) return c.redirect('/app/events/new');
  const orgId = orgIdForRequest(c)!;
  await run(c.env.DB, `DELETE FROM org_segments WHERE id = ? AND org_id = ?`, c.req.param('id'), orgId);
  return redirectWithToast(c, '/app/org/contacts?tab=segments', 'Segment deleted');
});

/* ----------------------------------------------------------------- export */

app.get('/app/org/contacts.csv', async (c) => {
  if (!c.var.event) return c.redirect('/app/events/new');
  const orgId = orgIdForRequest(c)!;
  const filters = readFilters(new URL(c.req.url).searchParams);
  const where = buildWhere(orgId, filters, null);
  const rows = await all<Row & { bio: string; created_at: string }>(
    c.env.DB,
    `SELECT name, email, company, job_title, tags_json, bio, source, created_at
       FROM org_contacts WHERE ${where.sql} ORDER BY name COLLATE NOCASE LIMIT 5000`,
    ...where.params
  );
  const body = toCsv(
    rows.map((r) => ({
      Name: r.name,
      Email: r.email,
      Company: r.company,
      'Job title': r.job_title,
      Tags: jsonParse<string[]>(r.tags_json, []).join(', '),
      Bio: r.bio,
      Source: r.source,
      Added: r.created_at.slice(0, 10),
    })),
    ['Name', 'Email', 'Company', 'Job title', 'Tags', 'Bio', 'Source', 'Added']
  );
  const stamp = now().slice(0, 10);
  return new Response(body, { headers: csvHeaders(`speaker-directory-${stamp}.csv`) });
});

export default app;
