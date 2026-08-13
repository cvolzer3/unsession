/**
 * `/app/org/contact/:id` — one contact's record (Speaker CRM).
 *
 * Singular path on purpose: the record is its own page, not a child of the
 * `/app/org/contacts` directory listing.
 *
 * The page is plain server-rendered HTML. Every write is a real form POST that
 * redirects back, so notes, tags and field values survive a reload without an
 * island. Modals are the shared `data-dialog` overlays from `public/js/ui.js`
 * wrapping ordinary forms.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { FC } from 'hono/jsx';
import type { Ctx } from '../types';
import { AdminLayout, MONO, StatusChip, fmtDate, fmtDateRange, initials, initialsGradient } from '../views/layout';
import { adminProps } from '../views/chrome';
import { all, batch, jsonParse, now, one, run } from '../lib/db';
import { newId } from '../lib/ids';
import { requireOrgRole } from '../lib/auth';
import { fmtDateTime } from '../lib/file-comments';
import { LINK_FIELDS, type SpeakerLinks } from '../lib/speaker-links';
import { addContactToEvent, orgIdForRequest } from '../lib/org-contacts';

const app = new Hono<Ctx>();

/* --------------------------------------------------------------- styles */

const LABEL = `font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;`;
const INPUT = 'width:100%;padding:8px 10px;border:1px solid #e2e3e8;font-size:13px;background:#fff;';
const BTN = 'padding:8px 14px;background:#fff;border:1px solid #e2e3e8;font-size:13px;cursor:pointer;';
const PRIMARY = 'padding:9px 16px;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;';
const DIALOG = 'position:fixed;inset:0;background:rgba(22,23,29,0.45);z-index:90;display:grid;place-items:center;padding:20px;';
const CARD = 'background:#fff;border:1px solid #e2e3e8;padding:18px 20px;';
const CHIP = `font-family:${MONO};font-size:9px;letter-spacing:0.08em;padding:2px 6px;font-weight:600;color:#686b74;background:#f1f3f5;text-transform:uppercase;`;

/* ----------------------------------------------------------- page data */

type ContactRow = {
  id: string;
  org_id: string;
  email: string;
  name: string;
  company: string;
  job_title: string;
  bio: string;
  tagline: string | null;
  pronouns: string | null;
  links_json: string | null;
  headshot_file_id: string | null;
  tags_json: string;
  custom_json: string;
  source: string;
  created_at: string;
  updated_at: string;
};

type FieldRow = { id: string; name: string; type: string; options_json: string | null };
type NoteRow = { id: string; body: string; created_at: string; author_name: string | null; author_email: string | null };
type ConnRow = { event_id: string; event_name: string; start_date: string; end_date: string; session_title: string | null };
type EmailRow = { subject: string; status: string; created_at: string };
type DupRow = { id: string; name: string; email: string };
type CardRow = { id: string; stage: string };
type EventRow = { id: string; name: string; start_date: string; end_date: string };

/** Fixed pipeline stages (migration 0024). */
const STAGE_LABEL: Record<string, string> = {
  researching: 'Researching',
  identified: 'Identified',
  contacted: 'Contacted',
  interested: 'Interested',
  confirmed: 'Confirmed',
  declined: 'Declined',
};

const SOURCE_LABEL: Record<string, string> = {
  manual: 'Added by hand',
  import: 'Imported',
  event: 'From an event',
};

function clean(value: unknown): string {
  return String(value ?? '').trim();
}

/** tags_json is a JSON string array — trimmed, deduped, order kept. */
function tagsOf(row: { tags_json: string | null }): string[] {
  const raw = jsonParse<unknown>(row.tags_json, []);
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const t of raw) {
    const tag = clean(t);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** custom_json maps org_fields.id → value. */
function customOf(row: { custom_json: string | null }): Record<string, string> {
  const raw = jsonParse<Record<string, unknown>>(row.custom_json, {});
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) out[k] = clean(v);
  return out;
}

/** The part before the @ — two contacts sharing it are probably the same person. */
function localPart(email: string): string {
  const at = email.indexOf('@');
  return at < 0 ? email : email.slice(0, at);
}

/** The contact, only if it belongs to the request's org. Null means 404. */
async function loadContact(c: Context<Ctx>, id: string): Promise<ContactRow | null> {
  const orgId = orgIdForRequest(c);
  if (!orgId) return null;
  return one<ContactRow>(c.env.DB, `SELECT * FROM org_contacts WHERE id = ? AND org_id = ?`, id, orgId);
}

function back(id: string, message?: string, error?: string): string {
  const q = message ? `?ok=${encodeURIComponent(message)}` : error ? `?err=${encodeURIComponent(error)}` : '';
  return `/app/org/contact/${id}${q}`;
}

/** Swap or drop a contact id inside every curated segment's member list. */
async function rewriteSegments(db: D1Database, orgId: string, fromId: string, toId: string | null) {
  const rows = await all<{ id: string; member_ids_json: string | null }>(
    db,
    `SELECT id, member_ids_json FROM org_segments WHERE org_id = ? AND kind = 'curated'`,
    orgId
  );
  const writes: Array<[string, unknown[]]> = [];
  for (const seg of rows) {
    const ids = jsonParse<unknown>(seg.member_ids_json, []);
    if (!Array.isArray(ids) || !ids.some((x) => clean(x) === fromId)) continue;
    const next: string[] = [];
    for (const raw of ids) {
      const id = clean(raw) === fromId ? toId : clean(raw);
      if (!id || next.includes(id)) continue;
      next.push(id);
    }
    writes.push([`UPDATE org_segments SET member_ids_json = ? WHERE id = ?`, [JSON.stringify(next), seg.id]]);
  }
  await batch(db, writes);
}

/* ------------------------------------------------------------- fragments */

const Avatar: FC<{ contact: ContactRow; size: number }> = ({ contact, size }) => {
  const who = contact.name || contact.email;
  if (contact.headshot_file_id) {
    return (
      <img
        src={`/files/${contact.headshot_file_id}`}
        alt={who}
        style={`width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;flex:none;`}
      />
    );
  }
  return (
    <div
      style={`width:${size}px;height:${size}px;border-radius:50%;flex:none;background:${initialsGradient(
        who
      )};color:#fff;display:grid;place-items:center;font-family:${MONO};font-size:${Math.round(
        size / 3.2
      )}px;font-weight:600;`}
    >
      {initials(who)}
    </div>
  );
};

const Meta: FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <div style={`${LABEL}margin-bottom:3px;`}>{label}</div>
    <div style="font-size:13px;color:#16171d;">{value || '—'}</div>
  </div>
);

const SectionTitle: FC<{ text: string; children?: unknown }> = ({ text, children }) => (
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
    <div style={LABEL}>{text}</div>
    <div style="margin-left:auto;display:flex;gap:8px;align-items:center;">{children as never}</div>
  </div>
);

/* ------------------------------------------------------------- the page */

app.get('/app/org/contact/:id', async (c) => {
  if (!c.var.event) return c.redirect('/app/events/new');
  const contact = await loadContact(c, c.req.param('id'));
  if (!contact) return c.notFound();
  const db = c.env.DB;
  const orgId = contact.org_id;
  const props = await adminProps(c, contact.name, { headerTitle: contact.name });

  const [fields, notes, conns, mails, card, dups, events] = await Promise.all([
    all<FieldRow>(db, `SELECT id, name, type, options_json FROM org_fields WHERE org_id = ? ORDER BY created_at, name`, orgId),
    all<NoteRow>(
      db,
      `SELECT n.id, n.body, n.created_at, u.name AS author_name, u.email AS author_email
         FROM contact_notes n LEFT JOIN users u ON u.id = n.author_user_id
        WHERE n.contact_id = ? ORDER BY n.created_at DESC, n.id DESC`,
      contact.id
    ),
    // speaker_profiles.email is COLLATE NOCASE, so this matches across casings.
    all<ConnRow>(
      db,
      `SELECT e.id AS event_id, e.name AS event_name, e.start_date, e.end_date, s.title AS session_title
         FROM speaker_profiles p
         JOIN events e ON e.id = p.event_id
    LEFT JOIN session_speakers ss ON ss.speaker_profile_id = p.id
    LEFT JOIN sessions s ON s.id = ss.session_id
        WHERE e.org_id = ? AND p.email = ?
        ORDER BY e.start_date DESC, s.title`,
      orgId,
      contact.email
    ),
    all<EmailRow>(
      db,
      `SELECT subject, status, created_at FROM emails
        WHERE lower(to_email) = lower(?)
          AND (org_id = ? OR event_id IN (SELECT id FROM events WHERE org_id = ?))
        ORDER BY created_at DESC LIMIT 50`,
      contact.email,
      orgId,
      orgId
    ),
    one<CardRow>(db, `SELECT id, stage FROM pipeline_cards WHERE org_id = ? AND contact_id = ?`, orgId, contact.id),
    all<DupRow>(
      db,
      `SELECT id, name, email FROM org_contacts
        WHERE org_id = ? AND id != ?
          AND (lower(name) = lower(?) OR lower(substr(email, 1, instr(email, '@') - 1)) = lower(?))
        ORDER BY name LIMIT 5`,
      orgId,
      contact.id,
      contact.name,
      localPart(contact.email)
    ),
    all<EventRow>(db, `SELECT id, name, start_date, end_date FROM events WHERE org_id = ? ORDER BY start_date DESC`, orgId),
  ]);

  const tags = tagsOf(contact);
  const custom = customOf(contact);
  const links = jsonParse<SpeakerLinks>(contact.links_json, {});
  const err = c.req.query('err');

  // Connections: one block per event, session titles collected under it.
  const byEvent: Array<{ id: string; name: string; dates: string; sessions: string[] }> = [];
  for (const row of conns) {
    let block = byEvent.find((b) => b.id === row.event_id);
    if (!block) {
      block = { id: row.event_id, name: row.event_name, dates: fmtDateRange(row.start_date, row.end_date), sessions: [] };
      byEvent.push(block);
    }
    if (row.session_title && !block.sessions.includes(row.session_title)) block.sessions.push(row.session_title);
  }

  // Activity: notes + emails + the creation entry, newest first.
  type Act = { at: string; kind: string; title: string; meta: string; status?: string };
  const activity: Act[] = [
    ...notes.map((n) => ({
      at: n.created_at,
      kind: 'Note',
      title: n.body.length > 140 ? `${n.body.slice(0, 140)}…` : n.body,
      meta: n.author_name || n.author_email || 'Someone',
    })),
    ...mails.map((m) => ({ at: m.created_at, kind: 'Email', title: m.subject, meta: '', status: m.status })),
    {
      at: contact.created_at,
      kind: 'Contact created',
      title: SOURCE_LABEL[contact.source] ?? contact.source,
      meta: '',
    },
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  return c.html(
    <AdminLayout {...props}>
      <div style="padding:24px 28px;max-width:1160px;display:grid;gap:18px;">
        <div style="display:flex;align-items:center;gap:12px;">
          <a href="/app/org/contacts" style="font-size:12.5px;color:#4c5fd5;">
            ← Speaker Directory
          </a>
          <div style="margin-left:auto;display:flex;gap:8px;align-items:center;">
            <button type="button" data-dialog-open="#dlg-event" style={BTN}>
              Add to event
            </button>
            {card ? (
              <a href={`/app/org/pipeline/${card.id}`} style={`${BTN}text-decoration:none;color:#16171d;display:inline-block;`}>
                {`In pipeline — ${STAGE_LABEL[card.stage] ?? card.stage}`}
              </a>
            ) : (
              <a
                href={`/app/org/pipeline?enroll=${encodeURIComponent(contact.id)}`}
                style={`${BTN}text-decoration:none;color:#16171d;display:inline-block;`}
              >
                Enroll in pipeline
              </a>
            )}
            <button type="button" data-dialog-open="#dlg-delete" style={`${BTN}color:#c92a2a;`}>
              Delete contact
            </button>
          </div>
        </div>

        {err ? (
          <div style="border:1px solid #e03131;background:#fbe9e9;color:#c92a2a;padding:9px 11px;font-size:12.5px;">{err}</div>
        ) : null}

        {dups.length ? (
          <div style="border:1px solid #e8d79a;background:#fdf5dc;padding:11px 13px;display:grid;gap:6px;">
            {dups.map((d) => (
              <div style="display:flex;align-items:center;gap:10px;font-size:12.5px;color:#8a6d1a;">
                <span>
                  {`Possible duplicate: ${d.name} `}
                  <span style={`font-family:${MONO};`}>{d.email}</span>
                </span>
                <a
                  href={`/app/org/contact/${contact.id}/merge?with=${encodeURIComponent(d.id)}`}
                  style="margin-left:auto;font-size:12.5px;color:#4c5fd5;"
                >
                  Review &amp; merge →
                </a>
              </div>
            ))}
          </div>
        ) : null}

        <div style="display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:18px;align-items:start;">
          <div style="display:grid;gap:18px;min-width:0;">
            {/* ---------------------------------------------------- identity */}
            <div style={CARD}>
              <div style="display:flex;gap:16px;align-items:flex-start;">
                <Avatar contact={contact} size={72} />
                <div style="min-width:0;flex:1;">
                  <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap;">
                    <div style="font-size:20px;font-weight:700;letter-spacing:-0.01em;">{contact.name}</div>
                    <span style={CHIP}>{contact.source}</span>
                  </div>
                  {contact.tagline ? (
                    <div style="font-size:13px;color:#686b74;margin-top:4px;">{contact.tagline}</div>
                  ) : null}
                  <div style={`font-family:${MONO};font-size:11.5px;color:#9a9da6;margin-top:6px;`}>{contact.email}</div>
                </div>
                <button type="button" data-dialog-open="#dlg-edit" style={BTN}>
                  Edit
                </button>
              </div>

              <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-top:18px;padding-top:16px;border-top:1px solid #eceded;">
                <Meta label="COMPANY" value={contact.company} />
                <Meta label="JOB TITLE" value={contact.job_title} />
                <Meta label="PRONOUNS" value={contact.pronouns ?? ''} />
                <Meta label="ADDED" value={fmtDate(contact.created_at, true)} />
              </div>

              {LINK_FIELDS.some(([k]) => links[k]) ? (
                <div style="margin-top:14px;padding-top:14px;border-top:1px solid #eceded;display:flex;gap:14px;flex-wrap:wrap;">
                  {LINK_FIELDS.filter(([k]) => links[k]).map(([k, label]) => (
                    <a href={links[k]} target="_blank" rel="noreferrer" style="font-size:12.5px;">
                      {`${label} ↗`}
                    </a>
                  ))}
                </div>
              ) : null}

              <div style="margin-top:14px;padding-top:14px;border-top:1px solid #eceded;">
                <div style={`${LABEL}margin-bottom:6px;`}>BIO</div>
                <div style="font-size:13px;color:#33343c;line-height:1.6;white-space:pre-wrap;">
                  {contact.bio || 'No bio yet.'}
                </div>
              </div>
            </div>

            {/* -------------------------------------------------------- tags */}
            <div style={CARD}>
              <SectionTitle text="TAGS" />
              <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
                {tags.length === 0 ? <span style="font-size:12.5px;color:#9a9da6;">No tags yet.</span> : null}
                {tags.map((tag) => (
                  <span style="display:inline-flex;align-items:center;gap:6px;background:#f1f3f5;border:1px solid #e2e3e8;padding:3px 4px 3px 9px;font-size:12.5px;">
                    {tag}
                    <form method="post" action={`/app/org/contact/${contact.id}/tag/remove`} style="margin:0;display:flex;">
                      <input type="hidden" name="tag" value={tag} />
                      <button
                        type="submit"
                        title={`Remove ${tag}`}
                        style="background:none;border:none;color:#9a9da6;font-size:13px;line-height:1;cursor:pointer;padding:0 3px;"
                      >
                        ×
                      </button>
                    </form>
                  </span>
                ))}
                <form method="post" action={`/app/org/contact/${contact.id}/tag/add`} style="margin:0;display:flex;gap:6px;">
                  <input name="tag" placeholder="Add tag…" style={`${INPUT}width:150px;padding:5px 8px;font-size:12.5px;`} />
                  <button type="submit" style={`${BTN}padding:5px 11px;font-size:12.5px;`}>
                    Add
                  </button>
                </form>
              </div>
            </div>

            {/* ----------------------------------------------- custom fields */}
            <div style={CARD}>
              <SectionTitle text="CUSTOM FIELDS">
                <button type="button" data-dialog-open="#dlg-field" style={`${BTN}padding:5px 11px;font-size:12.5px;`}>
                  Manage fields
                </button>
              </SectionTitle>
              {fields.length === 0 ? (
                <div style="font-size:12.5px;color:#9a9da6;">
                  No custom fields yet. A field you add here shows on every contact in the organization.
                </div>
              ) : (
                <form method="post" action={`/app/org/contact/${contact.id}/fields`} style="display:grid;gap:12px;">
                  <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;">
                    {fields.map((f) => (
                      <div>
                        <div style={`${LABEL}margin-bottom:5px;`}>{f.name.toUpperCase()}</div>
                        {f.type === 'dropdown' ? (
                          <select name={`cf_${f.id}`} style={INPUT}>
                            <option value="" selected={!custom[f.id]}>
                              —
                            </option>
                            {jsonParse<string[]>(f.options_json, []).map((opt) => (
                              <option value={opt} selected={custom[f.id] === opt}>
                                {opt}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input name={`cf_${f.id}`} value={custom[f.id] ?? ''} style={INPUT} />
                        )}
                      </div>
                    ))}
                  </div>
                  <button type="submit" style={`${PRIMARY}justify-self:start;`}>
                    Save fields
                  </button>
                </form>
              )}
            </div>

            {/* ------------------------------------------------------- notes */}
            <div style={CARD}>
              <SectionTitle text="NOTES" />
              <form method="post" action={`/app/org/contact/${contact.id}/note`} style="display:grid;gap:8px;margin-bottom:16px;">
                <textarea
                  name="body"
                  rows={3}
                  required
                  placeholder="What should the team know about this speaker?"
                  style={`${INPUT}resize:vertical;line-height:1.5;display:block;`}
                ></textarea>
                <button type="submit" style={`${PRIMARY}justify-self:start;`}>
                  Save note
                </button>
              </form>
              {notes.length === 0 ? (
                <div style="font-size:12.5px;color:#9a9da6;">No notes yet.</div>
              ) : (
                <div style="display:grid;">
                  {notes.map((n) => (
                    <div style="padding:12px 0;border-top:1px solid #eceded;">
                      <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;">
                        <div style="font-size:12.5px;font-weight:600;">{n.author_name || n.author_email || 'Someone'}</div>
                        <div style={`font-family:${MONO};font-size:10.5px;color:#9a9da6;margin-left:auto;`}>
                          {fmtDateTime(n.created_at)}
                        </div>
                      </div>
                      <div style="font-size:13px;color:#33343c;line-height:1.55;white-space:pre-wrap;">{n.body}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div style="display:grid;gap:18px;min-width:0;">
            {/* ------------------------------------------------- connections */}
            <div style={CARD}>
              <SectionTitle text="CONNECTIONS" />
              {byEvent.length === 0 ? (
                <div style="font-size:12.5px;color:#9a9da6;">Has not spoken at one of your events yet.</div>
              ) : (
                <div style="display:grid;gap:12px;">
                  {byEvent.map((b) => (
                    <div>
                      <div style="font-size:13px;font-weight:600;">{b.name}</div>
                      <div style={`font-family:${MONO};font-size:10.5px;color:#9a9da6;margin-top:2px;`}>{b.dates}</div>
                      {b.sessions.length ? (
                        <div style="margin-top:6px;display:grid;gap:3px;">
                          {b.sessions.map((title) => (
                            <div style="font-size:12.5px;color:#686b74;line-height:1.4;">{`· ${title}`}</div>
                          ))}
                        </div>
                      ) : (
                        <div style="font-size:12px;color:#9a9da6;margin-top:5px;">No session yet</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ---------------------------------------------------- activity */}
            <div style={CARD}>
              <SectionTitle text="ACTIVITY" />
              <div style="display:grid;">
                {activity.map((a) => (
                  <div style="padding:10px 0;border-top:1px solid #eceded;">
                    <div style="display:flex;align-items:center;gap:8px;">
                      <span style={CHIP}>{a.kind}</span>
                      {a.status ? <StatusChip status={a.status} /> : null}
                      <span style={`font-family:${MONO};font-size:10px;color:#9a9da6;margin-left:auto;`}>
                        {fmtDateTime(a.at)}
                      </span>
                    </div>
                    <div style="font-size:12.5px;color:#33343c;line-height:1.5;margin-top:5px;">{a.title}</div>
                    {a.meta ? <div style="font-size:11.5px;color:#9a9da6;margin-top:2px;">{a.meta}</div> : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------- dialogs */}

      <div id="dlg-edit" data-dialog hidden style={DIALOG}>
        <div style="background:#fff;width:560px;max-width:100%;max-height:88vh;display:flex;flex-direction:column;">
          <div style="padding:18px 24px;border-bottom:1px solid #e2e3e8;display:flex;align-items:center;">
            <div style="font-size:16px;font-weight:700;">Edit contact</div>
            <button
              type="button"
              data-dialog-close="#dlg-edit"
              style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;padding:0;"
            >
              ×
            </button>
          </div>
          <form method="post" action={`/app/org/contact/${contact.id}/edit`} style="display:contents;">
            <div style="padding:20px 24px;display:grid;gap:14px;overflow-y:auto;">
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
                <div>
                  <div style={`${LABEL}margin-bottom:5px;`}>NAME</div>
                  <input name="name" value={contact.name} required style={INPUT} />
                </div>
                <div>
                  <div style={`${LABEL}margin-bottom:5px;`}>EMAIL</div>
                  <input name="email" type="email" value={contact.email} required style={INPUT} />
                </div>
                <div>
                  <div style={`${LABEL}margin-bottom:5px;`}>COMPANY</div>
                  <input name="company" value={contact.company} style={INPUT} />
                </div>
                <div>
                  <div style={`${LABEL}margin-bottom:5px;`}>JOB TITLE</div>
                  <input name="job_title" value={contact.job_title} style={INPUT} />
                </div>
                <div>
                  <div style={`${LABEL}margin-bottom:5px;`}>TAGLINE</div>
                  <input name="tagline" value={contact.tagline ?? ''} style={INPUT} />
                </div>
                <div>
                  <div style={`${LABEL}margin-bottom:5px;`}>PRONOUNS</div>
                  <input name="pronouns" value={contact.pronouns ?? ''} style={INPUT} />
                </div>
              </div>
              <div>
                <div style={`${LABEL}margin-bottom:5px;`}>BIO</div>
                <textarea name="bio" rows={6} style={`${INPUT}resize:vertical;line-height:1.5;display:block;`}>
                  {contact.bio}
                </textarea>
              </div>
            </div>
            <div style="padding:14px 24px;border-top:1px solid #e2e3e8;display:flex;gap:8px;justify-content:flex-end;">
              <button type="button" data-dialog-close="#dlg-edit" style={BTN}>
                Cancel
              </button>
              <button type="submit" style={PRIMARY}>
                Save contact
              </button>
            </div>
          </form>
        </div>
      </div>

      <div id="dlg-field" data-dialog hidden style={DIALOG}>
        <div style="background:#fff;width:460px;max-width:100%;padding:24px;">
          <div style="font-size:16px;font-weight:700;margin-bottom:6px;">Add a custom field</div>
          <div style="font-size:12.5px;color:#686b74;line-height:1.55;margin-bottom:16px;">
            The field appears on every contact in this organization.
          </div>
          <form method="post" action={`/app/org/contact/${contact.id}/fields/new`} style="display:grid;gap:12px;">
            <div>
              <div style={`${LABEL}margin-bottom:5px;`}>NAME</div>
              <input name="name" required placeholder="e.g. Fee band" style={INPUT} />
            </div>
            <div>
              <div style={`${LABEL}margin-bottom:5px;`}>TYPE</div>
              <select name="type" style={INPUT}>
                <option value="text">Text</option>
                <option value="dropdown">Dropdown</option>
              </select>
            </div>
            <div>
              <div style={`${LABEL}margin-bottom:5px;`}>OPTIONS</div>
              <input name="options" placeholder="Comma-separated. Dropdown only." style={INPUT} />
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px;">
              <button type="button" data-dialog-close="#dlg-field" style={BTN}>
                Cancel
              </button>
              <button type="submit" style={PRIMARY}>
                Add field
              </button>
            </div>
          </form>
          {fields.length ? (
            <div style="margin-top:18px;padding-top:14px;border-top:1px solid #eceded;">
              <div style={`${LABEL}margin-bottom:8px;`}>EXISTING FIELDS</div>
              <div style="display:grid;gap:5px;">
                {fields.map((f) => (
                  <div style="font-size:12.5px;color:#686b74;">
                    {`${f.name} · ${f.type}`}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div id="dlg-event" data-dialog hidden style={DIALOG}>
        <div style="background:#fff;width:440px;max-width:100%;padding:24px;">
          <div style="font-size:16px;font-weight:700;margin-bottom:6px;">Add to event</div>
          <div style="font-size:12.5px;color:#686b74;line-height:1.55;margin-bottom:16px;">
            Creates a speaker profile on that event. Nothing changes if one already exists.
          </div>
          <form method="post" action={`/app/org/contact/${contact.id}/add-to-event`} style="display:grid;gap:12px;">
            <select name="event_id" style={INPUT}>
              {events.map((e) => (
                <option value={e.id} selected={e.id === c.var.event?.id}>
                  {`${e.name} · ${fmtDateRange(e.start_date, e.end_date)}`}
                </option>
              ))}
            </select>
            <div style="display:flex;gap:8px;justify-content:flex-end;">
              <button type="button" data-dialog-close="#dlg-event" style={BTN}>
                Cancel
              </button>
              <button type="submit" style={PRIMARY}>
                Add speaker
              </button>
            </div>
          </form>
        </div>
      </div>

      <div id="dlg-delete" data-dialog hidden style={DIALOG}>
        <div style="background:#fff;width:440px;max-width:100%;padding:24px;">
          <div style="font-size:16px;font-weight:700;margin-bottom:6px;">Delete this contact?</div>
          <div style="font-size:12.5px;color:#686b74;line-height:1.55;margin-bottom:16px;">
            Notes, the pipeline card and segment memberships go with it. Speaker profiles on your events stay. This
            cannot be undone.
          </div>
          <form method="post" action={`/app/org/contact/${contact.id}/delete`} style="display:flex;gap:8px;justify-content:flex-end;">
            <button type="button" data-dialog-close="#dlg-delete" style={BTN}>
              Cancel
            </button>
            <button type="submit" style={`${PRIMARY}background:#c92a2a;`}>
              Delete contact
            </button>
          </form>
        </div>
      </div>
    </AdminLayout>
  );
});

/* -------------------------------------------------------------- writes */

const write = requireOrgRole('collaborator');
const manage = requireOrgRole('admin');

app.post('/app/org/contact/:id/edit', write, async (c) => {
  if (!c.var.event) return c.redirect('/app/events/new');
  const contact = await loadContact(c, c.req.param('id'));
  if (!contact) return c.notFound();
  const body = await c.req.parseBody();

  const email = clean(body.email);
  const name = clean(body.name) || contact.name;
  if (!email.includes('@')) return c.redirect(back(contact.id, undefined, 'Enter a valid email address.'));

  // UNIQUE (org_id, email) — check first so the organizer gets a sentence, not a 500.
  if (email.toLowerCase() !== contact.email.toLowerCase()) {
    const taken = await one(
      c.env.DB,
      `SELECT 1 FROM org_contacts WHERE org_id = ? AND email = ? AND id != ?`,
      contact.org_id,
      email,
      contact.id
    );
    if (taken) return c.redirect(back(contact.id, undefined, 'A contact with that email already exists.'));
  }

  await run(
    c.env.DB,
    `UPDATE org_contacts
        SET name = ?, email = ?, company = ?, job_title = ?, tagline = ?, pronouns = ?, bio = ?, updated_at = ?
      WHERE id = ?`,
    name,
    email,
    clean(body.company),
    clean(body.job_title),
    clean(body.tagline) || null,
    clean(body.pronouns) || null,
    clean(body.bio),
    now(),
    contact.id
  );
  return c.redirect(back(contact.id, 'Contact saved'));
});

app.post('/app/org/contact/:id/tag/add', write, async (c) => {
  if (!c.var.event) return c.redirect('/app/events/new');
  const contact = await loadContact(c, c.req.param('id'));
  if (!contact) return c.notFound();
  const body = await c.req.parseBody();
  const tag = clean(body.tag);
  if (!tag) return c.redirect(back(contact.id));

  const tags = tagsOf(contact);
  if (tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return c.redirect(back(contact.id));
  tags.push(tag);
  await run(c.env.DB, `UPDATE org_contacts SET tags_json = ?, updated_at = ? WHERE id = ?`, JSON.stringify(tags), now(), contact.id);
  return c.redirect(back(contact.id, `Tagged “${tag}”`));
});

app.post('/app/org/contact/:id/tag/remove', write, async (c) => {
  if (!c.var.event) return c.redirect('/app/events/new');
  const contact = await loadContact(c, c.req.param('id'));
  if (!contact) return c.notFound();
  const body = await c.req.parseBody();
  const tag = clean(body.tag);
  const tags = tagsOf(contact).filter((t) => t !== tag);
  await run(c.env.DB, `UPDATE org_contacts SET tags_json = ?, updated_at = ? WHERE id = ?`, JSON.stringify(tags), now(), contact.id);
  return c.redirect(back(contact.id, 'Tag removed'));
});

app.post('/app/org/contact/:id/fields', write, async (c) => {
  if (!c.var.event) return c.redirect('/app/events/new');
  const contact = await loadContact(c, c.req.param('id'));
  if (!contact) return c.notFound();
  const body = await c.req.parseBody();
  const fields = await all<FieldRow>(c.env.DB, `SELECT id, name, type, options_json FROM org_fields WHERE org_id = ?`, contact.org_id);

  const custom = customOf(contact);
  for (const f of fields) {
    const value = clean(body[`cf_${f.id}`]);
    if (value) custom[f.id] = value;
    else delete custom[f.id];
  }
  await run(
    c.env.DB,
    `UPDATE org_contacts SET custom_json = ?, updated_at = ? WHERE id = ?`,
    JSON.stringify(custom),
    now(),
    contact.id
  );
  return c.redirect(back(contact.id, 'Fields saved'));
});

app.post('/app/org/contact/:id/fields/new', manage, async (c) => {
  if (!c.var.event) return c.redirect('/app/events/new');
  const contact = await loadContact(c, c.req.param('id'));
  if (!contact) return c.notFound();
  const body = await c.req.parseBody();

  const name = clean(body.name);
  const type = clean(body.type) === 'dropdown' ? 'dropdown' : 'text';
  if (!name) return c.redirect(back(contact.id, undefined, 'Give the field a name.'));

  const options = clean(body.options)
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (type === 'dropdown' && !options.length) {
    return c.redirect(back(contact.id, undefined, 'A dropdown needs at least one option.'));
  }

  await run(
    c.env.DB,
    `INSERT INTO org_fields (id, org_id, name, type, options_json, created_at) VALUES (?,?,?,?,?,?)`,
    newId('cfd'),
    contact.org_id,
    name,
    type,
    type === 'dropdown' ? JSON.stringify(options) : null,
    now()
  );
  return c.redirect(back(contact.id, `Field “${name}” added to every contact`));
});

app.post('/app/org/contact/:id/note', write, async (c) => {
  if (!c.var.event) return c.redirect('/app/events/new');
  const contact = await loadContact(c, c.req.param('id'));
  if (!contact) return c.notFound();
  const body = await c.req.parseBody();
  const text = clean(body.body);
  if (!text) return c.redirect(back(contact.id));

  await run(
    c.env.DB,
    `INSERT INTO contact_notes (id, contact_id, author_user_id, body, created_at) VALUES (?,?,?,?,?)`,
    newId('cno'),
    contact.id,
    c.var.user?.id ?? null,
    text,
    now()
  );
  return c.redirect(back(contact.id, 'Note saved'));
});

app.post('/app/org/contact/:id/add-to-event', write, async (c) => {
  if (!c.var.event) return c.redirect('/app/events/new');
  const contact = await loadContact(c, c.req.param('id'));
  if (!contact) return c.notFound();
  const body = await c.req.parseBody();
  const eventId = clean(body.event_id);

  const target = await one<{ id: string; name: string }>(
    c.env.DB,
    `SELECT id, name FROM events WHERE id = ? AND org_id = ?`,
    eventId,
    contact.org_id
  );
  if (!target) return c.redirect(back(contact.id, undefined, 'That event is not in this organization.'));

  const res = await addContactToEvent(c.env.DB, contact.id, target.id);
  if (!res) return c.redirect(back(contact.id, undefined, 'Could not add the contact.'));
  return c.redirect(
    back(contact.id, res.created ? `Added to ${target.name}` : `Already a speaker on ${target.name}`)
  );
});

app.post('/app/org/contact/:id/delete', manage, async (c) => {
  if (!c.var.event) return c.redirect('/app/events/new');
  const contact = await loadContact(c, c.req.param('id'));
  if (!contact) return c.notFound();
  const db = c.env.DB;

  const card = await one<{ id: string }>(db, `SELECT id FROM pipeline_cards WHERE contact_id = ?`, contact.id);
  const writes: Array<[string, unknown[]]> = [[`DELETE FROM contact_notes WHERE contact_id = ?`, [contact.id]]];
  if (card) {
    writes.push([`DELETE FROM pipeline_notes WHERE card_id = ?`, [card.id]]);
    writes.push([`DELETE FROM pipeline_history WHERE card_id = ?`, [card.id]]);
    writes.push([`DELETE FROM pipeline_cards WHERE id = ?`, [card.id]]);
  }
  await batch(db, writes);
  await rewriteSegments(db, contact.org_id, contact.id, null);
  await run(db, `DELETE FROM org_contacts WHERE id = ?`, contact.id);

  return c.redirect('/app/org/contacts?ok=' + encodeURIComponent(`${contact.name} deleted`));
});

/* --------------------------------------------------------------- merge */

/**
 * The fields the comparison table picks between. Tags are not here: they are
 * always merged as a union, so there is nothing to choose.
 */
const MERGE_FIELDS = [
  ['name', 'Name'],
  ['email', 'Email'],
  ['company', 'Company'],
  ['job_title', 'Job title'],
  ['tagline', 'Tagline'],
  ['pronouns', 'Pronouns'],
  ['bio', 'Bio'],
  ['headshot_file_id', 'Headshot'],
] as const;

type MergeKey = (typeof MERGE_FIELDS)[number][0];

/** The non-empty value wins; the primary record wins a tie. */
function defaultSide(a: ContactRow, b: ContactRow, key: MergeKey): 'a' | 'b' {
  if (clean(a[key])) return 'a';
  if (clean(b[key])) return 'b';
  return 'a';
}

function mergeCell(row: ContactRow, key: MergeKey): string {
  const value = clean(row[key]);
  if (!value) return '—';
  if (key === 'headshot_file_id') return 'Uploaded';
  return value;
}

app.get('/app/org/contact/:id/merge', async (c) => {
  if (!c.var.event) return c.redirect('/app/events/new');
  const a = await loadContact(c, c.req.param('id'));
  if (!a) return c.notFound();
  const b = await loadContact(c, clean(c.req.query('with')));
  if (!b || b.id === a.id) return c.notFound();

  const props = await adminProps(c, 'Merge contacts', { headerTitle: 'Merge contacts' });
  const union: string[] = [];
  for (const tag of [...tagsOf(a), ...tagsOf(b)]) if (!union.includes(tag)) union.push(tag);

  const head = (row: ContactRow, side: 'a' | 'b') => (
    <th style="text-align:left;padding:12px 14px;border-bottom:1px solid #e2e3e8;vertical-align:top;">
      <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;">
        <input type="radio" name="primary" value={side} checked={side === 'a'} style="margin-top:3px;" />
        <span>
          <span style="display:block;font-size:13.5px;font-weight:700;">{row.name}</span>
          <span style={`display:block;font-family:${MONO};font-size:10.5px;color:#9a9da6;margin-top:3px;`}>
            {row.email}
          </span>
          <span style="display:block;font-size:11.5px;color:#686b74;margin-top:4px;">
            {`Keep as the record · added ${fmtDate(row.created_at, true)}`}
          </span>
        </span>
      </label>
    </th>
  );

  const cell = (row: ContactRow, side: 'a' | 'b', key: MergeKey) => (
    <td style="padding:9px 14px;border-bottom:1px solid #eceded;vertical-align:top;">
      <label style="display:flex;gap:9px;align-items:flex-start;cursor:pointer;">
        <input type="radio" name={`f_${key}`} value={side} checked={defaultSide(a, b, key) === side} style="margin-top:3px;" />
        <span style="font-size:12.5px;color:#33343c;line-height:1.5;word-break:break-word;">{mergeCell(row, key)}</span>
      </label>
    </td>
  );

  return c.html(
    <AdminLayout {...props}>
      <div style="padding:24px 28px;max-width:900px;display:grid;gap:18px;">
        <a href={`/app/org/contact/${a.id}`} style="font-size:12.5px;color:#4c5fd5;">
          ← Back to {a.name}
        </a>
        <form method="post" action={`/app/org/contact/${a.id}/merge`} style={`${CARD}display:grid;gap:16px;padding:0;`}>
          <input type="hidden" name="with" value={b.id} />
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr>
                <th style={`text-align:left;padding:12px 14px;border-bottom:1px solid #e2e3e8;width:120px;${LABEL}`}>
                  FIELD
                </th>
                {head(a, 'a')}
                {head(b, 'b')}
              </tr>
            </thead>
            <tbody>
              {MERGE_FIELDS.map(([key, label]) => (
                <tr>
                  <td style={`padding:9px 14px;border-bottom:1px solid #eceded;vertical-align:top;${LABEL}`}>
                    {label.toUpperCase()}
                  </td>
                  {cell(a, 'a', key)}
                  {cell(b, 'b', key)}
                </tr>
              ))}
              <tr>
                <td style={`padding:9px 14px;border-bottom:1px solid #eceded;vertical-align:top;${LABEL}`}>TAGS</td>
                <td colspan={2} style="padding:9px 14px;border-bottom:1px solid #eceded;">
                  <div style="font-size:12.5px;color:#33343c;line-height:1.5;">
                    {union.length ? union.join(', ') : '—'}
                  </div>
                  <div style="font-size:11.5px;color:#9a9da6;margin-top:3px;">Both sets are kept.</div>
                </td>
              </tr>
            </tbody>
          </table>
          <div style="padding:0 14px 16px;display:flex;gap:10px;align-items:center;">
            <div style="font-size:12.5px;color:#c92a2a;">Merging cannot be undone.</div>
            <a href={`/app/org/contact/${a.id}`} style={`${BTN}margin-left:auto;text-decoration:none;color:#16171d;`}>
              Cancel
            </a>
            <button type="submit" style={PRIMARY}>
              Merge contacts
            </button>
          </div>
        </form>
      </div>
    </AdminLayout>
  );
});

app.post('/app/org/contact/:id/merge', manage, async (c) => {
  if (!c.var.event) return c.redirect('/app/events/new');
  const a = await loadContact(c, c.req.param('id'));
  if (!a) return c.notFound();
  const body = await c.req.parseBody();
  const b = await loadContact(c, clean(body.with));
  if (!b || b.id === a.id) return c.notFound();

  const db = c.env.DB;
  const primary = clean(body.primary) === 'b' ? b : a;
  const loser = primary.id === a.id ? b : a;

  // Chosen values, then the union of both tag sets.
  const values: Record<string, string | null> = {};
  for (const [key] of MERGE_FIELDS) {
    const side = clean(body[`f_${key}`]) === 'b' ? b : clean(body[`f_${key}`]) === 'a' ? a : defaultSide(a, b, key) === 'b' ? b : a;
    values[key] = clean(side[key]) || null;
  }
  const tags: string[] = [];
  for (const tag of [...tagsOf(primary), ...tagsOf(loser)]) if (!tags.includes(tag)) tags.push(tag);

  // Custom values: the primary's win, the loser fills the gaps.
  const custom = customOf(loser);
  for (const [k, v] of Object.entries(customOf(primary))) if (v) custom[k] = v;

  const primaryCard = await one<{ id: string }>(db, `SELECT id FROM pipeline_cards WHERE contact_id = ?`, primary.id);
  const loserCard = await one<{ id: string }>(db, `SELECT id FROM pipeline_cards WHERE contact_id = ?`, loser.id);

  const stamp = now();
  const writes: Array<[string, unknown[]]> = [
    [`UPDATE contact_notes SET contact_id = ? WHERE contact_id = ?`, [primary.id, loser.id]],
  ];
  if (loserCard && !primaryCard) {
    writes.push([`UPDATE pipeline_cards SET contact_id = ?, updated_at = ? WHERE id = ?`, [primary.id, stamp, loserCard.id]]);
  } else if (loserCard) {
    writes.push([`DELETE FROM pipeline_notes WHERE card_id = ?`, [loserCard.id]]);
    writes.push([`DELETE FROM pipeline_history WHERE card_id = ?`, [loserCard.id]]);
    writes.push([`DELETE FROM pipeline_cards WHERE id = ?`, [loserCard.id]]);
  }
  await batch(db, writes);
  await rewriteSegments(db, primary.org_id, loser.id, primary.id);

  // Delete first: the survivor may be taking the loser's email, and
  // UNIQUE (org_id, email) would reject it while both rows exist.
  await run(db, `DELETE FROM org_contacts WHERE id = ?`, loser.id);
  await run(
    db,
    `UPDATE org_contacts
        SET name = ?, email = ?, company = ?, job_title = ?, tagline = ?, pronouns = ?, bio = ?,
            headshot_file_id = ?, tags_json = ?, custom_json = ?, updated_at = ?
      WHERE id = ?`,
    values.name || primary.name,
    values.email || primary.email,
    values.company ?? '',
    values.job_title ?? '',
    values.tagline,
    values.pronouns,
    values.bio ?? '',
    values.headshot_file_id,
    JSON.stringify(tags),
    JSON.stringify(custom),
    stamp,
    primary.id
  );

  return c.redirect(back(primary.id, 'Merged — 1 contact remains.'));
});

export default app;
