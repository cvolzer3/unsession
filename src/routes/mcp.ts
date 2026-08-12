/**
 * MCP server — `POST /api/mcp` (spec C).
 *
 * Stateless Streamable HTTP: JSON-RPC 2.0 over POST, no sessions, no SSE.
 * Same Bearer auth as the REST API; every tool dispatches to the core
 * functions exported by `routes/api.tsx`, so REST and MCP cannot drift.
 *
 * - `initialize` → protocol-version negotiation (2025-03-26 / 2025-06-18),
 *   `capabilities: { tools: {} }`, serverInfo `unsession/<version>`.
 * - `notifications/initialized` (any notification) → 202, empty body.
 * - `tools/list` → write tools are omitted for read-only tokens.
 * - `tools/call` → results as `content: [{ type: 'text', text: JSON }]`;
 *   tool failures are `isError: true` results — JSON-RPC errors are reserved
 *   for protocol problems. Batch requests are not supported.
 * - GET/DELETE on the endpoint → 405.
 */
import { Hono } from 'hono';
import type { Bindings } from '../types';
import { apiTokenAuth, canWrite, type ApiAuth, type ApiCtx } from '../lib/api-tokens';
import * as api from './api';

const SERVER_INFO = { name: 'unsession', version: '0.1.0' };
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'];
const LATEST_PROTOCOL = '2025-06-18';

/* ------------------------------------------------------------------- tools */

type ToolArgs = Record<string, unknown>;

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** True = omitted from tools/list for read-only tokens. */
  write?: boolean;
  run: (env: Bindings, auth: ApiAuth, args: ToolArgs) => Promise<unknown>;
};

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

const EVENT_PROP = { type: 'string', description: 'Event slug or id (see list_events).' };

export const TOOLS: Tool[] = [
  {
    name: 'list_events',
    description: 'List the events this token can see (id, name, slug, dates, timezone, venue, published). Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (env, auth) => api.listEvents(env, auth),
  },
  {
    name: 'get_event',
    description: 'Get one event with its rooms and taxonomies (Track/Format/Level options, incl. option ids used elsewhere). Read-only.',
    inputSchema: { type: 'object', properties: { event: EVENT_PROP }, required: ['event'], additionalProperties: false },
    run: (env, auth, a) => api.getEvent(env, auth, str(a.event)),
  },
  {
    name: 'list_forms',
    description: 'List an event’s submission forms (id, name, slug, status, opens/closes, public URL). Read-only.',
    inputSchema: { type: 'object', properties: { event: EVENT_PROP }, required: ['event'], additionalProperties: false },
    run: (env, auth, a) => api.listForms(env, auth, str(a.event)),
  },
  {
    name: 'list_submissions',
    description:
      'List an event’s submissions with answers, speakers, status and resolved track/format/level. Cursor-paginated: pass the returned nextCursor to fetch the next page. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        event: EVENT_PROP,
        status: {
          type: 'string',
          enum: ['draft', 'in_review', 'accepted', 'waitlisted', 'declined', 'withdrawn'],
          description:
            'Filter by status. Speaker confirmation is not a submission status — it lives on the session (get_sessions → status pending|confirmed).',
        },
        form: { type: 'string', description: 'Filter by form id or slug.' },
        track: { type: 'string', description: 'Filter by track option id or name.' },
        q: { type: 'string', description: 'Search in title and speaker names/emails.' },
        limit: { type: 'integer', description: 'Page size, default 100, max 500.' },
        cursor: { type: 'string', description: 'Opaque nextCursor from the previous page.' },
      },
      required: ['event'],
      additionalProperties: false,
    },
    run: (env, auth, a) =>
      api.listSubmissions(env, auth, str(a.event), {
        status: a.status === undefined ? undefined : str(a.status),
        form: a.form === undefined ? undefined : str(a.form),
        track: a.track === undefined ? undefined : str(a.track),
        q: a.q === undefined ? undefined : str(a.q),
        limit: a.limit as number | undefined,
        cursor: a.cursor === undefined ? undefined : str(a.cursor),
      }),
  },
  {
    name: 'get_submission',
    description: 'Get one submission in full: answers, speakers, status, evaluation score summary, recent activity. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Submission id (sub_…).' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: (env, auth, a) => api.getSubmission(env, auth, str(a.id)),
  },
  {
    name: 'list_sessions',
    description: 'List an event’s sessions incl. schedule (day/start/end/room), type, status and publish flag. Read-only.',
    inputSchema: { type: 'object', properties: { event: EVENT_PROP }, required: ['event'], additionalProperties: false },
    run: (env, auth, a) => api.listSessions(env, auth, str(a.event)),
  },
  {
    name: 'get_session',
    description: 'Get one session (schedule, speakers, track/format, publish flag). Read-only.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Session id (ses_…).' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: (env, auth, a) => api.getSession(env, auth, str(a.id)),
  },
  {
    name: 'list_speakers',
    description:
      'List an event’s speaker profiles (name, email, bio, job title, company, pronouns, links, headshot URL) with task progress counts. Read-only.',
    inputSchema: { type: 'object', properties: { event: EVENT_PROP }, required: ['event'], additionalProperties: false },
    run: (env, auth, a) => api.listSpeakers(env, auth, str(a.event)),
  },
  {
    name: 'get_agenda',
    description: 'Get the published public agenda (same shape as /{slug}/agenda.json). Fails while the agenda is unpublished. Read-only.',
    inputSchema: { type: 'object', properties: { event: EVENT_PROP }, required: ['event'], additionalProperties: false },
    run: (env, auth, a) => api.getAgenda(env, auth, str(a.event)),
  },
  {
    name: 'list_tasks',
    description: 'List an event’s speaker/session task instances with status, due date and target. Read-only.',
    inputSchema: { type: 'object', properties: { event: EVENT_PROP }, required: ['event'], additionalProperties: false },
    run: (env, auth, a) => api.listTasks(env, auth, str(a.event)),
  },

  /* --------------------------------------------------------------- writes */

  {
    name: 'create_submission',
    description:
      'CREATE a submission on a form, on a speaker’s behalf (organizer import semantics). Writes a submission row, its speakers and an activity entry. Sends no email. Answer keys may be form field ids or field labels; unmatched keys are reported back, not stored.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        event: EVENT_PROP,
        formId: { type: 'string', description: 'Form id or slug on this event.' },
        title: { type: 'string', description: 'Session title (required).' },
        abstract: { type: 'string' },
        speakers: {
          type: 'array',
          description: 'Speakers in order; each needs a name or an email.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              email: { type: 'string' },
              bio: { type: 'string' },
              jobTitle: { type: 'string' },
              company: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        answers: { type: 'object', description: 'Form answers keyed by field id or field label.' },
        status: {
          type: 'string',
          enum: ['draft', 'in_review', 'accepted', 'waitlisted', 'declined', 'withdrawn'],
          description:
            'Initial status, default in_review. Setting accepted here does NOT run the decision engine — use decide_submission for that.',
        },
      },
      required: ['event', 'formId', 'title'],
      additionalProperties: false,
    },
    run: (env, auth, a) => api.createSubmission(env, auth, str(a.event), a as api.CreateSubmissionInput),
  },
  {
    name: 'update_submission',
    description:
      'UPDATE a submission’s title, abstract and/or answers (answers merge; null removes a key). Activity-logged. Never touches the session copy created on accept.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Submission id (sub_…).' },
        title: { type: 'string' },
        abstract: { type: 'string' },
        answers: { type: 'object', description: 'Keys are field ids or labels; null values remove the answer.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: (env, auth, a) => api.updateSubmission(env, auth, str(a.id), a as api.UpdateSubmissionInput),
  },
  {
    name: 'decide_submission',
    description:
      'DECIDE a submission: accept, decline or waitlist. Runs the real decision engine — flips the status, on accept creates the public Session copy and mints a 7-day confirmation link, and SENDS the decision email to the speaker unless sendEmail=false. Waitlist promotion = call again with accept.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Submission id (sub_…).' },
        decision: { type: 'string', enum: ['accept', 'decline', 'waitlist'] },
        sendEmail: {
          type: 'boolean',
          description: 'Default true. False suppresses the email but still flips status / creates the session / mints the confirmation link (returned so you can deliver it yourself).',
        },
        templateId: { type: 'string', description: 'Optional email_templates row id on this event to use instead of the default template.' },
        feedback: { type: 'string', description: 'Individual feedback merged into {{individual_feedback}} in the email.' },
      },
      required: ['id', 'decision'],
      additionalProperties: false,
    },
    run: (env, auth, a) => api.decideSubmission(env, auth, str(a.id), a as api.DecideSubmissionInput),
  },
  {
    name: 'create_session',
    description:
      'CREATE a sponsor or service session (talk sessions only ever arrive by accepting a submission). Starts confirmed and published; optionally scheduled when day+startMin are given. Activity-logged. Sends no email.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        event: EVENT_PROP,
        kind: { type: 'string', enum: ['sponsor', 'service'], description: 'Default sponsor.' },
        title: { type: 'string' },
        sponsorName: { type: 'string', description: 'Sponsor company (sponsor sessions).' },
        sponsorBadge: { type: 'boolean', description: 'SPONSORED badge on public pages (sponsor sessions); default true.' },
        abstract: { type: 'string' },
        trackId: { type: 'string', description: 'Track option id (sponsor sessions, see get_event).' },
        formatId: { type: 'string', description: 'Format option id (sponsor sessions).' },
        duration: { type: 'integer', description: 'Minutes; default 30 (sponsor) / 60 (service).' },
        allRooms: { type: 'boolean', description: 'Service blocks span all rooms by default.' },
        day: { type: 'integer', description: 'Day index (0-based); with startMin, schedules the session.' },
        startMin: { type: 'integer', description: 'Minutes from 08:00, snapped to 15.' },
        speaker: {
          type: 'object',
          description: 'Optional sponsor speaker; a speaker profile is created/linked when name+email given.',
          properties: { name: { type: 'string' }, email: { type: 'string' }, bio: { type: 'string' } },
          additionalProperties: false,
        },
      },
      required: ['event', 'title'],
      additionalProperties: false,
    },
    run: (env, auth, a) => api.createSession(env, auth, str(a.event), a as api.CreateSessionInput),
  },
  {
    name: 'update_session',
    description:
      'UPDATE a session: title, abstract, track/format/level, duration, room, published flag, sponsored badge, and/or its slot (day+startMin schedule; nulls unschedule). Activity-logged. A slot/room change on a confirmed session EMAILS its speakers a schedule notice and bumps the calendar-file sequence.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session id (ses_…).' },
        title: { type: 'string' },
        abstract: { type: 'string' },
        trackId: { type: ['string', 'null'], description: 'Track option id, null clears.' },
        formatId: { type: ['string', 'null'], description: 'Format option id, null clears.' },
        level: { type: ['string', 'null'] },
        duration: { type: 'integer', description: 'Minutes 5–600; moves the end of a scheduled session.' },
        roomId: { type: ['string', 'null'], description: 'Room id, "ALL" for all rooms, null unassigns.' },
        allRooms: { type: 'boolean' },
        published: { type: 'boolean', description: 'Toggles visibility on the public agenda.' },
        sponsorBadge: { type: 'boolean', description: 'Toggles the SPONSORED badge on public pages (sponsor sessions).' },
        day: { type: ['integer', 'null'], description: 'Day index; null unschedules.' },
        startMin: { type: ['integer', 'null'], description: 'Minutes from 08:00 (snapped to 15); null unschedules.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: (env, auth, a) => api.updateSession(env, auth, str(a.id), a as api.UpdateSessionInput),
  },
  {
    name: 'schedule_session',
    description:
      'SCHEDULE a session into a slot (day, startMin, optional roomId) or unschedule it (day=null, startMin=null). Same engine as update_session: activity-logged, and a move of a confirmed session EMAILS its speakers a schedule notice.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session id (ses_…).' },
        day: { type: ['integer', 'null'], description: 'Day index (0-based); null unschedules.' },
        startMin: { type: ['integer', 'null'], description: 'Minutes from 08:00, snapped to 15; null unschedules.' },
        roomId: { type: ['string', 'null'], description: 'Room id, "ALL" for all rooms, null unassigns.' },
      },
      required: ['id', 'day', 'startMin'],
      additionalProperties: false,
    },
    run: (env, auth, a) =>
      api.updateSession(env, auth, str(a.id), {
        day: a.day as number | null,
        startMin: a.startMin as number | null,
        ...(a.roomId !== undefined ? { roomId: a.roomId as string | null } : {}),
      }),
  },
  {
    name: 'update_speaker',
    description:
      'UPDATE a speaker profile: name, bio, job title, company, pronouns and/or links ({linkedin, x, website, other}; links merge, null removes). Activity-logged; may auto-complete an open “complete profile” task. Sends no email.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Speaker profile id (spk_…).' },
        name: { type: 'string' },
        bio: { type: 'string' },
        jobTitle: { type: ['string', 'null'] },
        company: { type: ['string', 'null'] },
        pronouns: { type: ['string', 'null'] },
        links: { type: 'object', description: 'Keys linkedin/x/website/other; values are URLs, null removes.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: (env, auth, a) => api.updateSpeaker(env, auth, str(a.id), a as api.UpdateSpeakerInput),
  },
  {
    name: 'assign_task',
    description:
      'ASSIGN a task template to speakers (speakerProfileId or speakerIds) or to a session (sessionId), or a one-off task to one speaker. Honest skip semantics like the admin bulk assign: already-assigned and no-session speakers are skipped and reported. New template assignments EMAIL each speaker an assignment digest. Activity-logged.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        templateId: { type: 'string', description: 'Task template id (see list_tasks / the admin Speakers page).' },
        speakerProfileId: { type: 'string', description: 'Single speaker target.' },
        speakerIds: { type: 'array', items: { type: 'string' }, description: 'Bulk speaker targets.' },
        sessionId: { type: 'string', description: 'Direct session target for session-target templates.' },
        oneOff: {
          type: 'object',
          description: 'One-off (non-template) task for speakerProfileId.',
          properties: {
            name: { type: 'string' },
            type: { type: 'string', enum: ['checkbox', 'file', 'form', 'profile'] },
            due: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    run: (env, auth, a) => api.assignTask(env, auth, a as api.AssignTaskInput),
  },
  {
    name: 'complete_task',
    description:
      'COMPLETE a task instance as an organizer override (marks it done and logs who did it). Idempotent: completing a done task reports alreadyDone. Sends no email.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Task instance id (tsi_…).' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: (env, auth, a) => api.completeTask(env, auth, str(a.id)),
  },
];

/* ---------------------------------------------------------------- JSON-RPC */

type RpcId = string | number | null;

type RpcRequest = {
  jsonrpc?: string;
  id?: RpcId;
  method?: string;
  params?: Record<string, unknown>;
};

function rpcResult(id: RpcId, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result };
}

function rpcError(id: RpcId, code: number, message: string) {
  return { jsonrpc: '2.0' as const, id, error: { code, message } };
}

export async function handleMcpRequest(
  env: Bindings,
  auth: ApiAuth,
  raw: unknown
): Promise<{ status: number; body: unknown | null }> {
  if (raw === null || typeof raw !== 'object') {
    return { status: 400, body: rpcError(null, -32700, 'Parse error: body must be a JSON-RPC 2.0 request object') };
  }
  if (Array.isArray(raw)) {
    return { status: 400, body: rpcError(null, -32600, 'Batch requests are not supported') };
  }
  const req = raw as RpcRequest;
  const id: RpcId = req.id ?? null;
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return { status: 400, body: rpcError(id, -32600, 'Invalid Request: jsonrpc must be "2.0" and method a string') };
  }

  // Notifications (no id) get 202 + empty body — incl. notifications/initialized.
  if (!('id' in req) || req.id === undefined) {
    return { status: 202, body: null };
  }

  const params = (req.params ?? {}) as Record<string, unknown>;

  switch (req.method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL;
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        }),
      };
    }

    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };

    case 'tools/list': {
      const tools = TOOLS.filter((t) => !t.write || canWrite(auth)).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      return { status: 200, body: rpcResult(id, { tools }) };
    }

    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${name || '(missing name)'}`) };
      const args =
        params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as ToolArgs)
          : {};
      if (tool.write && !canWrite(auth)) {
        return {
          status: 200,
          body: rpcResult(id, {
            content: [
              {
                type: 'text',
                text: `Error: this API token is read-only (scope 'read') — ${name} needs a token with the read,write scope.`,
              },
            ],
            isError: true,
          }),
        };
      }
      try {
        const data = await tool.run(env, auth, args);
        return {
          status: 200,
          body: rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }),
        };
      } catch (err) {
        const message = err instanceof api.ApiError ? err.message : 'Something went wrong';
        if (!(err instanceof api.ApiError)) console.error('[mcp]', err);
        return {
          status: 200,
          body: rpcResult(id, { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }),
        };
      }
    }

    default:
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${req.method}`) };
  }
}

/* ------------------------------------------------------------------ router */

const app = new Hono<ApiCtx>();

app.post('/api/mcp', apiTokenAuth, async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(rpcError(null, -32700, 'Parse error: body is not valid JSON'), 400);
  }
  const { status, body } = await handleMcpRequest(c.env, c.var.apiAuth, raw);
  if (body === null) return c.body(null, 202);
  return c.json(body, status as 200 | 400);
});

// No SSE stream, no server-initiated messages, no sessions to delete.
app.all('/api/mcp', (c) =>
  c.json({ ok: false, error: 'Method not allowed — the MCP endpoint is stateless JSON-RPC 2.0 over POST' }, 405)
);

// Anything else under /api (registered after the REST routes) → JSON 404.
app.all('/api/*', (c) => c.json({ ok: false, error: 'No such API route' }, 404));

export default app;
