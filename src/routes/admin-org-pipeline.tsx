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
 * The card page shows the stage as a dropdown that submits on change; a
 * noscript Move button keeps the same stage change working without JavaScript.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { raw } from 'hono/html';
import type { FC, PropsWithChildren } from 'hono/jsx';
import type { Ctx } from '../types';
import { AdminLayout, MONO, initials, initialsGradient } from '../views/layout';
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

/**
 * Page CSS (SPECS/M-mobile.md). The desktop half of every rule below is
 * byte-for-byte what used to sit inline; the `@media (max-width:768px)` half is
 * the phone shape. Inline styles beat media queries, so anything that has to
 * change width leaves the `style` attribute.
 *
 * The board is the real decision. On desktop it is six 210px lanes inside a
 * 1300px sideways-scrolling strip, moved by dragging. On a phone that shape
 * fails twice: less than two lanes fit at 390px, so a drag from Researching to
 * Confirmed would have to pan the strip mid-gesture — and HTML5 drag events do
 * not fire on a touch screen at all. So below 768px the lanes **stack**: one
 * full-width stage after another, scrolled the way a phone already scrolls, and
 * every card grows its own controls — a stage dropdown that submits on change,
 * plus ↑/↓ to order the card inside its stage. Both are ordinary form posts, so
 * they work with no JavaScript as well. Desktop keeps the drag untouched.
 */
const PAGE_CSS = `
  .pl-page{padding:24px 28px;}
  .pl-board{overflow-x:auto;padding-bottom:8px;}
  .pl-lanes{display:grid;grid-template-columns:repeat(6,minmax(210px,1fr));gap:12px;min-width:1300px;align-items:start;}
  .pl-drop{padding:10px;display:grid;gap:8px;align-content:start;min-height:150px;flex:1;}
  .pl-move{display:none;}
  .pl-empty-tap{display:none;}
  .pl-x{padding:0;}
  .pl-cardmail{font-size:11px;}
  .pl-cardpage{padding:24px 28px;max-width:1160px;display:grid;gap:16px;}
  .pl-stageform{margin:0;margin-left:auto;display:flex;align-items:center;gap:8px;}
  .pl-stagesel{width:170px;}
  .pl-cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:start;}
  .pl-hist{display:grid;grid-template-columns:1fr auto;gap:6px 12px;padding:12px 16px;}
  .pl-histdate{font-family:${MONO};font-size:10px;color:#9a9da6;text-align:right;white-space:nowrap;}
  @media (max-width:768px){
    .pl-page{padding:14px 14px 28px;}
    .pl-board{overflow-x:visible;padding-bottom:0;}
    .pl-lanes{grid-template-columns:minmax(0,1fr);min-width:0;gap:10px;}
    .pl-drop{min-height:0;}
    /* The address is body copy on a stacked card — 12.5px floor. */
    .pl-cardmail{font-size:12.5px;}
    .pl-move{display:flex;gap:6px;align-items:center;margin-top:2px;}
    .pl-move-stage{flex:1 1 auto;min-width:0;padding:8px 8px;border:1px solid #e2e3e8;background:#fff;color:#16171d;}
    .pl-move button{flex:none;padding:12px 13px;background:#fff;border:1px solid #e2e3e8;font-size:14px;line-height:1;color:#16171d;cursor:pointer;}
    .pl-empty-drag{display:none;}
    .pl-empty-tap{display:inline;}
    /* A bare ✕ is a 14px target — pad it out without moving the header. */
    .pl-x{padding:10px;margin:-10px -10px -10px auto;}
    .pl-cardpage{padding:14px 14px 28px;gap:12px;}
    .pl-stageform{margin-left:0;flex:1 0 100%;}
    .pl-stagesel{width:auto;flex:1 1 auto;min-width:0;}
    .pl-cols{grid-template-columns:minmax(0,1fr);gap:12px;}
    .pl-hist{grid-template-columns:minmax(0,1fr);gap:3px 0;}
    /* Stacked, the date is what separates one transition from the next. */
    .pl-histdate{text-align:left;white-space:normal;padding-bottom:9px;margin-bottom:6px;border-bottom:1px solid #f2f3f5;}
    .pl-hist > .pl-histdate:last-child{padding-bottom:0;margin-bottom:0;border-bottom:none;}
  }
`;

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
  headshot_file_id: string | null;
};

type ContactOption = { id: string; name: string; email: string };
type EventOption = { id: string; name: string };

/** One card with its contact, scoped to the org. Null when it is not theirs. */
function loadCard(db: D1Database, orgId: string, id: string) {
  return one<CardRow>(
    db,
    `SELECT p.id, p.contact_id, p.stage, p.score, p.rationale, p.updated_at,
            c.name, c.email, c.company, c.headshot_file_id
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

/**
 * Change stage and log the transition — the card lands at the end of the
 * target column. The board's drag drop posts an explicit position instead.
 */
async function moveCard(db: D1Database, orgId: string, card: CardRow, stage: Stage, actor: string): Promise<void> {
  const stamp = now();
  await batch(db, [
    [
      `UPDATE pipeline_cards
          SET stage = ?, updated_at = ?,
              sort_order = (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM pipeline_cards WHERE org_id = ? AND stage = ?)
        WHERE id = ?`,
      [stage, stamp, orgId, stage, card.id],
    ],
    [
      `INSERT INTO pipeline_history (id, card_id, from_stage, to_stage, actor, created_at) VALUES (?,?,?,?,?,?)`,
      [newId('pph'), card.id, card.stage, stage, actor, stamp],
    ],
  ]);
}

/**
 * Swap a card with its neighbour inside its own stage — what the board's ↑/↓
 * buttons do, and the touch equivalent of dragging a card up a lane. Returns
 * false when the card is already at that end of the column.
 */
async function nudgeCard(
  db: D1Database,
  orgId: string,
  card: CardRow,
  dir: 'up' | 'down'
): Promise<boolean> {
  const column = await all<{ id: string }>(
    db,
    `SELECT id FROM pipeline_cards WHERE org_id = ? AND stage = ? ORDER BY sort_order, updated_at DESC`,
    orgId,
    card.stage
  );
  const ids = column.map((r) => r.id);
  const at = ids.indexOf(card.id);
  const to = dir === 'up' ? at - 1 : at + 1;
  if (at < 0 || to < 0 || to >= ids.length) return false;
  [ids[at], ids[to]] = [ids[to], ids[at]];
  // Rewriting the whole column keeps positions dense; columns are small.
  await batch(
    db,
    ids.map((id, i) => [`UPDATE pipeline_cards SET sort_order = ? WHERE id = ?`, [i, id]] as [string, unknown[]])
  );
  return true;
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

const Avatar: FC<{ card: CardRow }> = ({ card }) =>
  card.headshot_file_id ? (
    <div
      style={`width:26px;height:26px;border-radius:50%;flex:none;background:url(/files/${card.headshot_file_id}) center/cover;`}
    ></div>
  ) : (
    <div
      style={`width:26px;height:26px;border-radius:50%;flex:none;background:${initialsGradient(
        card.name || card.email
      )};color:#fff;display:grid;place-items:center;font-family:${MONO};font-size:9.5px;font-weight:600;`}
    >
      {initials(card.name || card.email)}
    </div>
  );

const BoardCard: FC<{ card: CardRow }> = ({ card }) => (
  <article
    draggable="true"
    data-card-id={card.id}
    data-href={cardPath(card.id)}
    style={`${CARD}padding:9px 11px;cursor:grab;display:grid;gap:6px;`}
  >
    <div style="display:flex;align-items:center;gap:8px;min-width:0;">
      <Avatar card={card} />
      <div style="min-width:0;">
        <a
          href={`/app/org/contact/${card.contact_id}`}
          draggable="false"
          style="display:block;font-size:13px;font-weight:600;letter-spacing:-0.01em;color:#16171d;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
        >
          {card.name}
        </a>
        <div class="pl-cardmail" style="color:#9a9da6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          {card.email}
        </div>
      </div>
    </div>
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
    {/* Phone-only (`.pl-move` is display:none above 768px): the touch path for
        what desktop does by dragging. Plain form posts, so no-JS works too. */}
    <form method="post" action={`/app/org/pipeline/${card.id}/move`} class="pl-move">
      <input type="hidden" name="back" value="board" />
      <select
        name="stage"
        class="pl-move-stage"
        onchange="this.form.submit()"
        aria-label={`Stage for ${card.name}`}
      >
        {STAGES.map((s) => (
          <option value={s} selected={s === card.stage}>
            {STAGE_LABEL[s]}
          </option>
        ))}
      </select>
      <noscript>
        <button type="submit">Move</button>
      </noscript>
      <button type="submit" name="nudge" value="up" title="Move up in this stage" aria-label={`Move ${card.name} up in this stage`}>
        ↑
      </button>
      <button
        type="submit"
        name="nudge"
        value="down"
        title="Move down in this stage"
        aria-label={`Move ${card.name} down in this stage`}
      >
        ↓
      </button>
    </form>
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
      <div data-drop={stage} class="pl-drop">
        {cards.map((card) => (
          <BoardCard card={card} />
        ))}
        <div data-empty hidden={cards.length > 0} style="font-size:11.5px;color:#c2c4cb;text-align:center;padding:10px 0;">
          {/* Nothing is dropped on a phone — the cards carry a stage dropdown. */}
          <span class="pl-empty-drag">Drop here</span>
          <span class="pl-empty-tap">Nobody here yet</span>
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
            class="pl-x" style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;"
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
  if (!c.var.event) return c.redirect('/app/events/new');
  const orgId = orgIdForRequest(c)!;

  const [props, cards, candidates] = await Promise.all([
    adminProps(c, 'Pipeline', { headerTitle: 'Pipeline' }),
    all<CardRow>(
      c.env.DB,
      `SELECT p.id, p.contact_id, p.stage, p.score, p.rationale, p.updated_at,
              c.name, c.email, c.company, c.headshot_file_id
         FROM pipeline_cards p JOIN org_contacts c ON c.id = p.contact_id
        WHERE p.org_id = ?
        ORDER BY p.sort_order, p.updated_at DESC`,
      orgId
    ),
    loadCandidates(c.env.DB, orgId),
  ]);

  // ?enroll=<contactId> opens the dialog with that contact chosen. Someone who
  // already has a card goes straight to it instead.
  let preselect = c.req.query('enroll') ?? null;
  if (preselect) {
    const [existing, owned] = await Promise.all([
      one<{ id: string }>(
        c.env.DB,
        `SELECT id FROM pipeline_cards WHERE org_id = ? AND contact_id = ?`,
        orgId,
        preselect
      ),
      one<{ id: string }>(
        c.env.DB,
        `SELECT id FROM org_contacts WHERE id = ? AND org_id = ?`,
        preselect,
        orgId
      ),
    ]);
    if (existing) return c.redirect(backToCard(existing.id, 'Already in the pipeline'));
    if (!owned) preselect = null;
  }

  const headerActions = (
    <button type="button" data-dialog-open="#enroll-dialog" style={PRIMARY_BTN}>
      ＋ Add to pipeline
    </button>
  );

  return c.html(
    <AdminLayout {...props} headerActions={headerActions} scripts={['/js/org-pipeline.js']}>
      {raw(`<style>${PAGE_CSS}</style>`)}
      <div class="pl-page">
        {cards.length ? (
          <div id="pipeline-board" class="pl-board">
            <div class="pl-lanes">
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
      `INSERT INTO pipeline_cards (id, org_id, contact_id, stage, score, rationale, sort_order, created_at, updated_at)
       VALUES (?,?,?,?,?,?,(SELECT COALESCE(MAX(sort_order) + 1, 0) FROM pipeline_cards WHERE org_id = ? AND stage = ?),?,?)`,
      [id, orgId, contactId, stage, score, rationale, orgId, stage, stamp, stamp],
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

  const body = await c.req.json<{ id?: string; stage?: string; index?: number }>();
  const stage = String(body.stage ?? '');
  if (!isStage(stage)) return c.json({ ok: false, error: 'Unknown stage' }, 400);

  const card = await loadCard(c.env.DB, orgId, String(body.id ?? ''));
  if (!card) return c.json({ ok: false, error: 'That card is no longer in your pipeline' }, 404);

  // The target column in its current order, the card spliced in where it was
  // dropped. Rewriting every position keeps them dense; columns are small.
  const column = await all<{ id: string }>(
    c.env.DB,
    `SELECT id FROM pipeline_cards WHERE org_id = ? AND stage = ? AND id != ? ORDER BY sort_order, updated_at DESC`,
    orgId,
    stage,
    card.id
  );
  const ids = column.map((r) => r.id);
  const raw = Number(body.index);
  const at = Number.isFinite(raw) ? Math.max(0, Math.min(ids.length, Math.trunc(raw))) : ids.length;
  ids.splice(at, 0, card.id);

  const stamp = now();
  const writes: Array<[string, unknown[]]> = ids.map((id, i) => [
    `UPDATE pipeline_cards SET sort_order = ? WHERE id = ?`,
    [i, id],
  ]);
  if (card.stage !== stage) {
    writes.push(
      [`UPDATE pipeline_cards SET stage = ?, updated_at = ? WHERE id = ?`, [stage, stamp, card.id]],
      [
        `INSERT INTO pipeline_history (id, card_id, from_stage, to_stage, actor, created_at) VALUES (?,?,?,?,?,?)`,
        [newId('pph'), card.id, card.stage, stage, actorOf(c), stamp],
      ]
    );
  }
  await batch(c.env.DB, writes);
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

  const stage = (isStage(card.stage) ? card.stage : 'identified') as Stage;
  const canRemove = c.var.role === 'owner' || c.var.role === 'admin';

  const [props, notes, history, events] = await Promise.all([
    adminProps(c, 'Pipeline', { headerTitle: card.name }),
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
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;">
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
      {raw(`<style>${PAGE_CSS}</style>`)}
      <div class="pl-cardpage">
        {/* ------------------------------------------------------- summary */}
        <div style={`${CARD}padding:18px 20px;display:grid;gap:14px;`}>
          <div style="display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;">
            {card.headshot_file_id ? (
              <img
                src={`/files/${card.headshot_file_id}`}
                alt={card.name}
                style="width:56px;height:56px;border-radius:50%;object-fit:cover;flex:none;"
              />
            ) : (
              <div
                style={`width:56px;height:56px;border-radius:50%;flex:none;background:${initialsGradient(
                  card.name || card.email
                )};color:#fff;display:grid;place-items:center;font-family:${MONO};font-size:18px;font-weight:600;`}
              >
                {initials(card.name || card.email)}
              </div>
            )}
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
            {/* The stage lives here as a dropdown — picking a stage moves the card. */}
            <form method="post" action={`/app/org/pipeline/${card.id}/move`} class="pl-stageform">
              {dot ? <span style={`width:8px;height:8px;border-radius:50%;flex:none;background:${dot};`}></span> : null}
              {/* INPUT minus its width: the width lives in .pl-stagesel so the
                  phone can let the dropdown fill the row. */}
              <select
                name="stage"
                onchange="this.form.submit()"
                title="Move to a different stage"
                class="pl-stagesel"
                style={`padding:8px 10px;border:1px solid #e2e3e8;font-size:13.5px;outline-color:#4c5fd5;background:#fff;font-weight:700;color:${
                  dot ?? '#16171d'
                };`}
              >
                {STAGES.map((s) => (
                  <option value={s} selected={s === stage}>
                    {STAGE_LABEL[s]}
                  </option>
                ))}
              </select>
              <noscript>
                <button type="submit" style={PRIMARY_BTN}>
                  Move
                </button>
              </noscript>
            </form>
          </div>

          <div style="border-top:1px solid #f2f3f5;padding-top:14px;display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap;">
            <div>
              <div style={FIELD_LABEL}>Score</div>
              {/* The badge sits in the same 13px/1.55 line box as the rationale text so their first lines align. */}
              <div style="font-size:13px;line-height:1.55;color:#9a9da6;">
                {card.score === null ? '—' : <ScoreBadge score={card.score} />}
              </div>
            </div>
            <div style="flex:1;min-width:220px;">
              <div style={FIELD_LABEL}>Rationale</div>
              <div style="font-size:13px;color:#33343c;line-height:1.55;white-space:pre-wrap;">
                {card.rationale || '—'}
              </div>
            </div>
            <button
              type="button"
              data-dialog-open="#score-dialog"
              style="display:inline-flex;align-items:center;gap:7px;padding:8px 13px;background:#fff;border:1px solid #cfd3dc;font-size:13px;font-weight:600;color:#16171d;cursor:pointer;box-shadow:0 1px 2px rgba(22,23,29,0.06);align-self:flex-start;white-space:nowrap;"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              </svg>
              Edit score &amp; rationale
            </button>
          </div>
        </div>

        <div class="pl-cols">
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
            <div class="pl-hist">
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
                  <div class="pl-histdate">{fmtDateTime(h.created_at)}</div>
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
                class="pl-x" style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;"
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
                class="pl-x" style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;"
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
                  class="pl-x" style="margin-left:auto;background:none;border:none;font-size:18px;color:#9a9da6;cursor:pointer;"
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
  // The board's phone controls post back=board so the organizer stays on the
  // list they were reading; the card page posts nothing and stays on the card.
  const toBoard = String(body.back ?? '') === 'board';
  const done = (message: string) =>
    c.redirect(toBoard ? `/app/org/pipeline?ok=${encodeURIComponent(message)}` : backToCard(card.id, message));

  // ↑/↓ reorder inside the stage the card is already in.
  const nudge = String(body.nudge ?? '');
  if (nudge === 'up' || nudge === 'down') {
    const moved = await nudgeCard(c.env.DB, orgId, card, nudge);
    if (!moved) return done(nudge === 'up' ? 'Already first in this stage' : 'Already last in this stage');
    return done(`${card.name} moved ${nudge}`);
  }

  const stage = String(body.stage ?? '');
  if (!isStage(stage)) return done('Unknown stage');
  if (stage === card.stage) return c.redirect(toBoard ? '/app/org/pipeline' : cardPath(card.id));

  await moveCard(c.env.DB, orgId, card, stage, actorOf(c));
  return done(`Moved to ${STAGE_LABEL[stage]}`);
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
