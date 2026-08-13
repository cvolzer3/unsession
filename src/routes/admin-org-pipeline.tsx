/**
 * `/app/org/pipeline` — the speaker pipeline board (Speaker CRM).
 *
 * One card per contact, moving through the fixed stages: researching,
 * identified, contacted, interested, confirmed, declined. Confirmed and
 * declined are terminal.
 *
 * The board is server-rendered; only drag-and-drop lives in
 * `public/js/org-pipeline.js`, which POSTs each drop to
 * `/app/api/org/pipeline/move` and reverts the card when the server says no.
 * The card page carries a plain `Move to` form so the same stage change works
 * without JavaScript.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { FC, PropsWithChildren } from 'hono/jsx';
import type { Ctx } from '../types';
import { AdminLayout, MONO } from '../views/layout';
import { adminProps } from '../views/chrome';
import { all, batch, now, one, run } from '../lib/db';
import { newId } from '../lib/ids';
import { requireOrgRole } from '../lib/auth';
import { addContactToEvent, orgIdForRequest } from '../lib/org-contacts';
import { fmtDateTime } from '../lib/file-comments';

const app = new Hono<Ctx>();

/* ------------------------------------------------------------------ stages */

const STAGES = ['researching', 'identified', 'contacted', 'interested', 'confirmed', 'declined'] as const;
type Stage = (typeof STAGES)[number];

const STAGE_LABEL: Record<Stage, string> = {
  researching: 'Researching',
  identified: 'Identified',
  contacted: 'Contacted',
  interested: 'Interested',
  confirmed: 'Confirmed',
  declined: 'Declined',
};

/** Stages an enrollment may start in — the terminal two are reached by moving. */
const OPEN_STAGES: Stage[] = ['researching', 'identified', 'contacted', 'interested'];

/** Terminal stages get a status dot, same colours as STATUS_COLORS. */
const STAGE_DOT: Partial<Record<Stage, string>> = { confirmed: '#2b8a3e', declined: '#c92a2a' };

const isStage = (v: string): v is Stage => (STAGES as readonly string[]).includes(v);

/* ------------------------------------------------------------------ styles */

const MICRO = `font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;`;
const CARD = 'background:#fff;border:1px solid #e2e3e8;';
const INPUT = 'width:100%;padding:8px 10px;border:1px solid #e2e3e8;font-size:13.5px;outline-color:#4c5fd5;background:#fff;';
const FIELD_LABEL = 'font-size:12px;color:#686b74;margin-bottom:4px;';
const PRIMARY_BTN = 'padding:8px 16px;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;';
const PLAIN_BTN = 'padding:8px 14px;background:#fff;border:1px solid #e2e3e8;font-size:13px;cursor:pointer;';
const DANGER_BTN = 'padding:8px 14px;background:#fff;border:1px solid #f0c4c4;color:#c92a2a;font-size:13px;cursor:pointer;';
const DIALOG_WRAP = 'position:fixed;inset:0;background:rgba(22,23,29,0.45);z-index:90;display:grid;place-items:center;';
const DIALOG_CARD = 'background:#fff;width:440px;max-width:calc(100vw - 48px);box-shadow:0 16px 48px rgba(22,23,29,0.25);';
const DIALOG_HEAD = 'padding:16px 20px;border-bottom:1px solid #e2e3e8;display:flex;align-items:center;gap:10px;';
const DIALOG_BODY = 'padding:18px 20px;display:grid;gap:12px;';
const DIALOG_FOOT = 'padding:14px 20px;border-top:1px solid #f2f3f5;display:flex;gap:8px;align-items:center;justify-content:flex-end;';

/* -------------------------------------------------------------------- data */

type CardRow = {
  id: string;
  contact_id: string;
  stage: string;
  score: number | null;
  rationale: string;
  updated_at: string;
  name: string;
  email: string;
  company: string;
};

type ContactOption = { id: string; name: string; email: string };
type EventOption = { id: string; name: string };

/** One card with its contact, scoped to the org. Null when it is not theirs. */
function loadCard(db: D1Database, orgId: string, id: string) {
  return one<CardRow>(
    db,
    `SELECT p.id, p.contact_id, p.stage, p.score, p.rationale, p.updated_at,
            c.name, c.email, c.company
       FROM pipeline_cards p JOIN org_contacts c ON c.id = p.contact_id
      WHERE p.id = ? AND p.org_id = ?`,
    id,
    orgId
  );
}

/** Org contacts with no card yet — the only ones that can be enrolled. */
function loadCandidates(db: D1Database, orgId: string) {
  return all<ContactOption>(
    db,
    `SELECT c.id, c.name, c.email
       FROM org_contacts c
      WHERE c.org_id = ?
        AND NOT EXISTS (SELECT 1 FROM pipeline_cards p WHERE p.org_id = c.org_id AND p.contact_id = c.id)
      ORDER BY c.name COLLATE NOCASE`,
    orgId
  );
}

/** Whose name the history row carries. */
const actorOf = (c: Context<Ctx>) => c.var.user?.name || c.var.user?.email || 'System';

/** Change stage and log the transition. Same write for drag, form and API. */
async function moveCard(db: D1Database, card: CardRow, stage: Stage, actor: string): Promise<void> {
  const stamp = now();
  await batch(db, [
    [`UPDATE pipeline_cards SET stage = ?, updated_at = ? WHERE id = ?`, [stage, stamp, card.id]],
    [
      `INSERT INTO pipeline_history (id, card_id, from_stage, to_stage, actor, created_at) VALUES (?,?,?,?,?,?)`,
      [newId('pph'), card.id, card.stage, stage, actor, stamp],
    ],
  ]);
}

const cardPath = (id: string) => `/app/org/pipeline/${id}`;

function backToCard(id: string, message: string) {
  return `${cardPath(id)}?ok=${encodeURIComponent(message)}`;
}

/* ------------------------------------------------------------------- board */

const ScoreBadge: FC<{ score: number }> = ({ score }) => (
  <span
    style={`font-family:${MONO};font-size:9.5px;letter-spacing:0.08em;font-weight:600;padding:2px 6px;color:#4c5fd5;background:#eef0fb;`}
  >
    {`SCORE ${score}`}
  </span>
);

const BoardCard: FC<{ card: CardRow }> = ({ card }) => (
  <article
    draggable="true"
    data-card-id={card.id}
    data-href={cardPath(card.id)}
    style={`${CARD}padding:9px 11px;cursor:grab;display:grid;gap:5px;`}
  >
    <a
      href={`/app/org/contact/${card.contact_id}`}
      draggable="false"
      style="font-size:13px;font-weight:600;letter-spacing:-0.01em;color:#16171d;text-decoration:none;"
    >
      {card.name}
    </a>
    {/* The body is the link to the card page — a bare card still needs one. */}
    <a href={cardPath(card.id)} draggable="false" style="display:grid;gap:5px;color:inherit;text-decoration:none;">
      {card.company ? <span style="font-size:11.5px;color:#686b74;">{card.company}</span> : null}
      {card.score === null ? null : (
        <span>
          <ScoreBadge score={card.score} />
        </span>
      )}
      {!card.company && card.score === null ? (
        <span style="font-size:11.5px;color:#9a9da6;">Open card →</span>
      ) : null}
    </a>
  </article>
);

const Column: FC<{ stage: Stage; cards: CardRow[] }> = ({ stage, cards }) => {
  const dot = STAGE_DOT[stage];
  return (
    <section style={`${CARD}display:flex;flex-direction:column;min-width:0;`}>
      <div style="padding:10px 12px;border-bottom:1px solid #e2e3e8;display:flex;align-items:center;gap:7px;">
        {dot ? <span style={`width:8px;height:8px;border-radius:50%;background:${dot};`}></span> : null}
        <span style={`font-size:12.5px;font-weight:700;color:${dot ?? '#16171d'};`}>{STAGE_LABEL[stage]}</span>
        <span style={`margin-left:auto;font-family:${MONO};font-size:10px;color:#9a9da6;`} data-count={stage}>
          {cards.length}
        </span>
      </div>
      <div data-drop={stage} style="padding:10px;display:grid;gap:8px;align-content:start;min-height:150px;flex:1;">
        {cards.map((card) => (
          <BoardCard card={card} />
        ))}
        <div data-empty hidden={cards.length > 0} style="font-size:11.5px;color:#c2c4cb;text-align:center;padding:10px 0;">
          Drop here
        </div>
      </div>
    </section>
  );
};

const EnrollDialog: FC<{ candidates: ContactOption[]; preselect: string | null }> = ({ candidates, preselect }) => (
  <div id="enroll-dialog" data-dialog hidden={!preselect} style={DIALOG_WRAP}>
    <div style={DIALOG_CARD}>
      <form method="post" action="/app/org/pipeline/enroll" style="margin:0;">
        <div style={DIALOG_HEAD}>
          <div style="font-size:15px;font-weight:700;">Add contact to pipeline</div>
          <button
            type="button"
            data-dialog-close="#enroll-dialog"
            style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;padding:0;"
          >
            ×
          </button>
        </div>
        <div style={DIALOG_BODY}>
          {candidates.length ? (
            <>
              <label style="display:block;">
                <div style={FIELD_LABEL}>Contact</div>
                <select name="contact_id" required style={INPUT}>
                  {candidates.map((k) => (
                    <option value={k.id} selected={k.id === preselect}>
                      {`${k.name} — ${k.email}`}
                    </option>
                  ))}
                </select>
              </label>
              <label style="display:block;">
                <div style={FIELD_LABEL}>Starting stage</div>
                <select name="stage" style={INPUT}>
                  {OPEN_STAGES.map((s) => (
                    <option value={s} selected={s === 'identified'}>
                      {STAGE_LABEL[s]}
                    </option>
                  ))}
                </select>
              </label>
              <label style="display:block;">
                <div style={FIELD_LABEL}>Score (0–100, optional)</div>
                <input type="number" name="score" min="0" max="100" style={INPUT} />
              </label>
              <label style="display:block;">
                <div style={FIELD_LABEL}>Rationale (optional)</div>
                <textarea name="rationale" rows={3} style={`${INPUT}resize:vertical;`}></textarea>
              </label>
            </>
          ) : (
            <div style="font-size:13px;color:#686b74;line-height:1.55;">
              Every contact is already in the pipeline. Add someone new in the{' '}
              <a href="/app/org/contacts">Speaker Directory</a>.
            </div>
          )}
        </div>
        <div style={DIALOG_FOOT}>
          <button type="button" data-dialog-close="#enroll-dialog" style={PLAIN_BTN}>
            Cancel
          </button>
          {candidates.length ? (
            <button type="submit" style={PRIMARY_BTN}>
              Add to pipeline
            </button>
          ) : null}
        </div>
      </form>
    </div>
  </div>
);

app.get('/app/org/pipeline', async (c) => {
  const props = await adminProps(c, 'Pipeline', { headerTitle: 'Pipeline' });
  if (!c.var.event) return c.redirect('/app/events/new');
  const orgId = orgIdForRequest(c)!;

  const cards = await all<CardRow>(
    c.env.DB,
    `SELECT p.id, p.contact_id, p.stage, p.score, p.rationale, p.updated_at,
            c.name, c.email, c.company
       FROM pipeline_cards p JOIN org_contacts c ON c.id = p.contact_id
      WHERE p.org_id = ?
      ORDER BY p.updated_at DESC`,
    orgId
  );

  // ?enroll=<contactId> opens the dialog with that contact chosen. Someone who
  // already has a card goes straight to it instead.
  let preselect = c.req.query('enroll') ?? null;
  if (preselect) {
    const existing = await one<{ id: string }>(
      c.env.DB,
      `SELECT id FROM pipeline_cards WHERE org_id = ? AND contact_id = ?`,
      orgId,
      preselect
    );
    if (existing) return c.redirect(backToCard(existing.id, 'Already in the pipeline'));
    const owned = await one<{ id: string }>(
      c.env.DB,
      `SELECT id FROM org_contacts WHERE id = ? AND org_id = ?`,
      preselect,
      orgId
    );
    if (!owned) preselect = null;
  }
  const candidates = await loadCandidates(c.env.DB, orgId);

  const headerActions = (
    <button type="button" data-dialog-open="#enroll-dialog" style={PRIMARY_BTN}>
      ＋ Add to pipeline
    </button>
  );

  return c.html(
    <AdminLayout {...props} headerActions={headerActions} scripts={['/js/org-pipeline.js']}>
      <div style="padding:24px 28px;">
        {cards.length ? (
          <div id="pipeline-board" style="overflow-x:auto;padding-bottom:8px;">
            <div style="display:grid;grid-template-columns:repeat(6,minmax(210px,1fr));gap:12px;min-width:1300px;align-items:start;">
              {STAGES.map((stage) => (
                <Column stage={stage} cards={cards.filter((k) => k.stage === stage)} />
              ))}
            </div>
          </div>
        ) : (
          <div style={`${CARD}padding:40px 28px;text-align:center;`}>
            <div style={`${MICRO}margin-bottom:8px;`}>NOBODY IN THE PIPELINE</div>
            <div style="font-size:13px;color:#686b74;margin-bottom:16px;">
              Add a contact to track them from first idea to a confirmed slot.
            </div>
            <button type="button" data-dialog-open="#enroll-dialog" style={PRIMARY_BTN}>
              ＋ Add to pipeline
            </button>
          </div>
        )}
      </div>
      <EnrollDialog candidates={candidates} preselect={preselect} />
    </AdminLayout>
  );
});

app.post('/app/org/pipeline/enroll', requireOrgRole('collaborator'), async (c) => {
  if (!c.var.event) return c.redirect('/app/events/new');
  const orgId = orgIdForRequest(c)!;
  const body = await c.req.parseBody();

  const contactId = String(body.contact_id ?? '');
  // The contact page's "Add to pipeline" dialog sends back=contact so the
  // organizer stays on the record they were reading instead of landing here.
  const backToContact = String(body.back ?? '') === 'contact';
  const stageRaw = String(body.stage ?? 'identified');
  const stage: Stage = isStage(stageRaw) && OPEN_STAGES.includes(stageRaw) ? stageRaw : 'identified';
  const scoreRaw = String(body.score ?? '').trim();
  const score = scoreRaw === '' ? null : Math.max(0, Math.min(100, Math.round(Number(scoreRaw) || 0)));
  const rationale = String(body.rationale ?? '').trim();

  const contact = await one<{ name: string }>(
    c.env.DB,
    `SELECT name FROM org_contacts WHERE id = ? AND org_id = ?`,
    contactId,
    orgId
  );
  if (!contact) return c.redirect('/app/org/pipeline?ok=' + encodeURIComponent('That contact is not in this organization'));

  const existing = await one<{ id: string }>(
    c.env.DB,
    `SELECT id FROM pipeline_cards WHERE org_id = ? AND contact_id = ?`,
    orgId,
    contactId
  );
  if (existing) {
    if (backToContact) return c.redirect(`/app/org/contact/${contactId}?ok=${encodeURIComponent('Already in the pipeline')}`);
    return c.redirect(backToCard(existing.id, 'Already in the pipeline'));
  }

  const id = newId('pcd');
  const stamp = now();
  await batch(c.env.DB, [
    [
      `INSERT INTO pipeline_cards (id, org_id, contact_id, stage, score, rationale, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, orgId, contactId, stage, score, rationale, stamp, stamp],
    ],
    [
      `INSERT INTO pipeline_history (id, card_id, from_stage, to_stage, actor, created_at) VALUES (?,?,?,?,?,?)`,
      [newId('pph'), id, null, stage, actorOf(c), stamp],
    ],
  ]);

  const okMsg = encodeURIComponent(`${contact.name} added to pipeline — ${STAGE_LABEL[stage]}`);
  if (backToContact) return c.redirect(`/app/org/contact/${contactId}?ok=${okMsg}`);
  return c.redirect(`/app/org/pipeline?ok=${okMsg}`);
});

/* --------------------------------------------------------------- move (API) */

app.post('/app/api/org/pipeline/move', requireOrgRole('collaborator'), async (c) => {
  const orgId = orgIdForRequest(c);
  if (!orgId) return c.json({ ok: false, error: 'No event selected' }, 400);

  const body = await c.req.json<{ id?: string; stage?: string }>();
  const stage = String(body.stage ?? '');
  if (!isStage(stage)) return c.json({ ok: false, error: 'Unknown stage' }, 400);

  const card = await loadCard(c.env.DB, orgId, String(body.id ?? ''));
  if (!card) return c.json({ ok: false, error: 'That card is no longer in your pipeline' }, 404);

  if (card.stage !== stage) await moveCard(c.env.DB, card, stage, actorOf(c));
  return c.json({ ok: true });
});

/* --------------------------------------------------------------- card page */

const Section: FC<PropsWithChildren<{ label: string }>> = ({ label, children }) => (
  <div style={CARD}>
    <div style={`padding:12px 16px;border-bottom:1px solid #e2e3e8;${MICRO}`}>{label}</div>
    {children}
  </div>
);

app.get('/app/org/pipeline/:id', async (c) => {
  if (!c.var.event) return c.redirect('/app/events/new');
  const orgId = orgIdForRequest(c)!;
  const card = await loadCard(c.env.DB, orgId, c.req.param('id'));
  if (!card) return c.notFound();

  const props = await adminProps(c, 'Pipeline', { headerTitle: card.name });
  const stage = (isStage(card.stage) ? card.stage : 'identified') as Stage;
  const canRemove = c.var.role === 'owner' || c.var.role === 'admin';

  const [notes, history, events] = await Promise.all([
    all<{ id: string; body: string; created_at: string; author: string | null; email: string | null }>(
      c.env.DB,
      `SELECT n.id, n.body, n.created_at, u.name AS author, u.email
         FROM pipeline_notes n LEFT JOIN users u ON u.id = n.author_user_id
        WHERE n.card_id = ?
        ORDER BY n.created_at DESC, n.rowid DESC`,
      card.id
    ),
    all<{ from_stage: string | null; to_stage: string; actor: string; created_at: string }>(
      c.env.DB,
      `SELECT from_stage, to_stage, actor, created_at FROM pipeline_history
        WHERE card_id = ? ORDER BY created_at DESC, rowid DESC`,
      card.id
    ),
    all<EventOption>(c.env.DB, `SELECT id, name FROM events WHERE org_id = ? ORDER BY start_date DESC`, orgId),
  ]);

  const headerActions = (
    <div style="display:flex;align-items:center;gap:8px;">
      <a href="/app/org/pipeline" style={`${PLAIN_BTN}text-decoration:none;color:#16171d;`}>
        ← Board
      </a>
      <button type="button" data-dialog-open="#assign-dialog" style={PLAIN_BTN}>
        Assign to event
      </button>
      {canRemove ? (
        <button type="button" data-dialog-open="#remove-dialog" style={DANGER_BTN}>
          Remove from pipeline
        </button>
      ) : null}
    </div>
  );

  const dot = STAGE_DOT[stage];

  return c.html(
    <AdminLayout {...props} headerActions={headerActions}>
      <div style="padding:24px 28px;max-width:1160px;display:grid;gap:16px;">
        {/* ------------------------------------------------------- summary */}
        <div style={`${CARD}padding:18px 20px;display:grid;gap:14px;`}>
          <div style="display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;">
            <div style="min-width:0;">
              <a
                href={`/app/org/contact/${card.contact_id}`}
                style="font-size:18px;font-weight:700;letter-spacing:-0.01em;color:#16171d;text-decoration:none;"
              >
                {card.name}
              </a>
              <div style={`font-family:${MONO};font-size:11.5px;color:#686b74;margin-top:4px;`}>{card.email}</div>
              {card.company ? <div style="font-size:12.5px;color:#686b74;margin-top:2px;">{card.company}</div> : null}
            </div>
            <div style="margin-left:auto;display:flex;align-items:center;gap:10px;">
              {card.score === null ? null : <ScoreBadge score={card.score} />}
              <span style="display:flex;align-items:center;gap:7px;">
                {dot ? <span style={`width:8px;height:8px;border-radius:50%;background:${dot};`}></span> : null}
                <span style={`font-size:13px;font-weight:700;color:${dot ?? '#16171d'};`}>{STAGE_LABEL[stage]}</span>
              </span>
            </div>
          </div>

          <div style="border-top:1px solid #f2f3f5;padding-top:14px;display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap;">
            <form
              method="post"
              action={`/app/org/pipeline/${card.id}/move`}
              style="margin:0;display:flex;align-items:flex-end;gap:8px;"
            >
              <label style="display:block;">
                <div style={FIELD_LABEL}>Move to</div>
                <select name="stage" style={`${INPUT}width:190px;`}>
                  {STAGES.map((s) => (
                    <option value={s} selected={s === stage}>
                      {STAGE_LABEL[s]}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" style={PRIMARY_BTN}>
                Move
              </button>
            </form>
            <div style="flex:1;min-width:220px;">
              <div style={FIELD_LABEL}>Rationale</div>
              <div style="font-size:13px;color:#33343c;line-height:1.55;white-space:pre-wrap;">
                {card.rationale || '—'}
              </div>
              <button type="button" data-dialog-open="#score-dialog" style="margin-top:8px;background:none;border:none;padding:0;font-size:12px;color:#4c5fd5;cursor:pointer;">
                Edit score & rationale
              </button>
            </div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:start;">
          {/* --------------------------------------------------------- notes */}
          <Section label="NOTES">
            <form method="post" action={`/app/org/pipeline/${card.id}/note`} style="margin:0;padding:14px 16px;border-bottom:1px solid #f2f3f5;display:grid;gap:8px;">
              <textarea name="body" rows={3} required placeholder="Add a note…" style={`${INPUT}resize:vertical;`}></textarea>
              <div>
                <button type="submit" style={PRIMARY_BTN}>
                  Add note
                </button>
              </div>
            </form>
            {notes.length ? (
              notes.map((n) => (
                <div style="padding:12px 16px;border-bottom:1px solid #f2f3f5;">
                  <div style={`font-family:${MONO};font-size:10px;color:#9a9da6;margin-bottom:4px;`}>
                    {`${n.author || n.email || 'System'} · ${fmtDateTime(n.created_at)}`}
                  </div>
                  <div style="font-size:13px;color:#33343c;line-height:1.55;white-space:pre-wrap;">{n.body}</div>
                </div>
              ))
            ) : (
              <div style="padding:20px 16px;font-size:12.5px;color:#9a9da6;">No notes yet.</div>
            )}
          </Section>

          {/* ------------------------------------------------------- history */}
          <Section label="STAGE HISTORY">
            <div style="display:grid;grid-template-columns:1fr auto;gap:6px 12px;padding:12px 16px;">
              {history.map((h) => (
                <>
                  <div style="font-size:12.5px;color:#33343c;">
                    {h.from_stage
                      ? `${STAGE_LABEL[h.from_stage as Stage] ?? h.from_stage} → ${
                          STAGE_LABEL[h.to_stage as Stage] ?? h.to_stage
                        }`
                      : `Added → ${STAGE_LABEL[h.to_stage as Stage] ?? h.to_stage}`}
                    <div style="font-size:11.5px;color:#686b74;">{h.actor}</div>
                  </div>
                  <div style={`font-family:${MONO};font-size:10px;color:#9a9da6;text-align:right;white-space:nowrap;`}>
                    {fmtDateTime(h.created_at)}
                  </div>
                </>
              ))}
            </div>
          </Section>
        </div>
      </div>

      {/* ------------------------------------------------------- dialogs */}
      <div id="score-dialog" data-dialog hidden style={DIALOG_WRAP}>
        <div style={DIALOG_CARD}>
          <form method="post" action={`/app/org/pipeline/${card.id}/score`} style="margin:0;">
            <div style={DIALOG_HEAD}>
              <div style="font-size:15px;font-weight:700;">Score & rationale</div>
              <button
                type="button"
                data-dialog-close="#score-dialog"
                style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;padding:0;"
              >
                ×
              </button>
            </div>
            <div style={DIALOG_BODY}>
              <label style="display:block;">
                <div style={FIELD_LABEL}>Score (0–100, optional)</div>
                <input type="number" name="score" min="0" max="100" value={card.score === null ? '' : String(card.score)} style={INPUT} />
              </label>
              <label style="display:block;">
                <div style={FIELD_LABEL}>Rationale</div>
                <textarea name="rationale" rows={4} style={`${INPUT}resize:vertical;`}>
                  {card.rationale}
                </textarea>
              </label>
            </div>
            <div style={DIALOG_FOOT}>
              <button type="button" data-dialog-close="#score-dialog" style={PLAIN_BTN}>
                Cancel
              </button>
              <button type="submit" style={PRIMARY_BTN}>
                Save
              </button>
            </div>
          </form>
        </div>
      </div>

      <div id="assign-dialog" data-dialog hidden style={DIALOG_WRAP}>
        <div style={DIALOG_CARD}>
          <form method="post" action={`/app/org/pipeline/${card.id}/assign`} style="margin:0;">
            <div style={DIALOG_HEAD}>
              <div style="font-size:15px;font-weight:700;">Assign to event</div>
              <button
                type="button"
                data-dialog-close="#assign-dialog"
                style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;padding:0;"
              >
                ×
              </button>
            </div>
            <div style={DIALOG_BODY}>
              <div style="font-size:12.5px;color:#686b74;line-height:1.55;">
                Adds {card.name} to that event as a speaker. The stage stays as it is.
              </div>
              <label style="display:block;">
                <div style={FIELD_LABEL}>Event</div>
                <select name="event_id" required style={INPUT}>
                  {events.map((e) => (
                    <option value={e.id} selected={e.id === c.var.event?.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div style={DIALOG_FOOT}>
              <button type="button" data-dialog-close="#assign-dialog" style={PLAIN_BTN}>
                Cancel
              </button>
              <button type="submit" style={PRIMARY_BTN}>
                Add speaker
              </button>
            </div>
          </form>
        </div>
      </div>

      {canRemove ? (
        <div id="remove-dialog" data-dialog hidden style={DIALOG_WRAP}>
          <div style={DIALOG_CARD}>
            <form method="post" action={`/app/org/pipeline/${card.id}/remove`} style="margin:0;">
              <div style={DIALOG_HEAD}>
                <div style="font-size:15px;font-weight:700;">Remove from pipeline</div>
                <button
                  type="button"
                  data-dialog-close="#remove-dialog"
                  style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;padding:0;"
                >
                  ×
                </button>
              </div>
              <div style={DIALOG_BODY}>
                <div style="font-size:13px;color:#33343c;line-height:1.55;">
                  This deletes the card, its notes and its stage history. {card.name} stays in the Speaker Directory.
                </div>
              </div>
              <div style={DIALOG_FOOT}>
                <button type="button" data-dialog-close="#remove-dialog" style={PLAIN_BTN}>
                  Cancel
                </button>
                <button type="submit" style="padding:8px 16px;background:#c92a2a;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;">
                  Remove
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </AdminLayout>
  );
});

/* ------------------------------------------------------------ card writes */

/** Every card write: same guard, same org check, same 404. */
const guard = requireOrgRole('collaborator');

app.post('/app/org/pipeline/:id/move', guard, async (c) => {
  if (!c.var.event) return c.redirect('/app/events/new');
  const orgId = orgIdForRequest(c)!;
  const card = await loadCard(c.env.DB, orgId, c.req.param('id'));
  if (!card) return c.notFound();

  const body = await c.req.parseBody();
  const stage = String(body.stage ?? '');
  if (!isStage(stage)) return c.redirect(backToCard(card.id, 'Unknown stage'));
  if (stage === card.stage) return c.redirect(cardPath(card.id));

  await moveCard(c.env.DB, card, stage, actorOf(c));
  return c.redirect(backToCard(card.id, `Moved to ${STAGE_LABEL[stage]}`));
});

app.post('/app/org/pipeline/:id/note', guard, async (c) => {
  if (!c.var.event) return c.redirect('/app/events/new');
  const orgId = orgIdForRequest(c)!;
  const card = await loadCard(c.env.DB, orgId, c.req.param('id'));
  if (!card) return c.notFound();

  const body = await c.req.parseBody();
  const text = String(body.body ?? '').trim();
  if (!text) return c.redirect(cardPath(card.id));

  await run(
    c.env.DB,
    `INSERT INTO pipeline_notes (id, card_id, author_user_id, body, created_at) VALUES (?,?,?,?,?)`,
    newId('pno'),
    card.id,
    c.var.user?.id ?? null,
    text,
    now()
  );
  return c.redirect(backToCard(card.id, 'Note added'));
});

app.post('/app/org/pipeline/:id/score', guard, async (c) => {
  if (!c.var.event) return c.redirect('/app/events/new');
  const orgId = orgIdForRequest(c)!;
  const card = await loadCard(c.env.DB, orgId, c.req.param('id'));
  if (!card) return c.notFound();

  const body = await c.req.parseBody();
  const scoreRaw = String(body.score ?? '').trim();
  const score = scoreRaw === '' ? null : Math.max(0, Math.min(100, Math.round(Number(scoreRaw) || 0)));
  const rationale = String(body.rationale ?? '').trim();

  await run(
    c.env.DB,
    `UPDATE pipeline_cards SET score = ?, rationale = ?, updated_at = ? WHERE id = ?`,
    score,
    rationale,
    now(),
    card.id
  );
  return c.redirect(backToCard(card.id, 'Saved'));
});

app.post('/app/org/pipeline/:id/assign', guard, async (c) => {
  if (!c.var.event) return c.redirect('/app/events/new');
  const orgId = orgIdForRequest(c)!;
  const card = await loadCard(c.env.DB, orgId, c.req.param('id'));
  if (!card) return c.notFound();

  const body = await c.req.parseBody();
  const event = await one<{ id: string; name: string }>(
    c.env.DB,
    `SELECT id, name FROM events WHERE id = ? AND org_id = ?`,
    String(body.event_id ?? ''),
    orgId
  );
  if (!event) return c.redirect(backToCard(card.id, 'That event is not in this organization'));

  const res = await addContactToEvent(c.env.DB, card.contact_id, event.id);
  if (!res) return c.redirect(backToCard(card.id, 'That contact no longer exists'));
  if (!res.created) return c.redirect(backToCard(card.id, `Already a speaker at ${event.name}`));

  // The assignment is a fact about the card, not a stage change — it lands as
  // a note so the history table keeps meaning transitions only.
  await run(
    c.env.DB,
    `INSERT INTO pipeline_notes (id, card_id, author_user_id, body, created_at) VALUES (?,?,?,?,?)`,
    newId('pno'),
    card.id,
    c.var.user?.id ?? null,
    `Assigned to event ${event.name}.`,
    now()
  );
  return c.redirect(backToCard(card.id, `Added to ${event.name}`));
});

app.post('/app/org/pipeline/:id/remove', requireOrgRole('admin'), async (c) => {
  if (!c.var.event) return c.redirect('/app/events/new');
  const orgId = orgIdForRequest(c)!;
  const card = await loadCard(c.env.DB, orgId, c.req.param('id'));
  if (!card) return c.notFound();

  await batch(c.env.DB, [
    [`DELETE FROM pipeline_notes WHERE card_id = ?`, [card.id]],
    [`DELETE FROM pipeline_history WHERE card_id = ?`, [card.id]],
    [`DELETE FROM pipeline_cards WHERE id = ? AND org_id = ?`, [card.id, orgId]],
  ]);
  return c.redirect('/app/org/pipeline?ok=' + encodeURIComponent(`${card.name} removed from the pipeline`));
});

export default app;
