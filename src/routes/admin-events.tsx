/** `/app/events/new` + the header event switcher target (spec §5.5). */
import { Hono } from 'hono';
import type { Ctx } from '../types';
import { AdminLayout, MONO } from '../views/layout';
import { adminProps } from '../views/chrome';
import { createEvent, ensureOrgForUser, slugTaken } from '../lib/events';
import { EVENT_MODES, TIMEZONES } from '../lib/defaults';
import { setActiveEvent } from '../lib/auth';
import { slugify } from '../lib/slugify';
import { one } from '../lib/db';
import { firstName } from '../views/layout';

const app = new Hono<Ctx>();

const FIELD_LABEL = 'font-size:12px;color:#686b74;margin-bottom:4px;';
const INPUT = 'width:100%;padding:8px 10px;border:1px solid #e2e3e8;font-size:13.5px;outline-color:#4c5fd5;';
const SELECT = 'width:100%;padding:8px 10px;border:1px solid #e2e3e8;font-size:13.5px;background:#fff;';

function defaultDates(): { start: string; end: string } {
  const d = new Date(Date.now() + 180 * 86_400_000);
  const start = d.toISOString().slice(0, 10);
  const e = new Date(d.getTime() + 86_400_000);
  return { start, end: e.toISOString().slice(0, 10) };
}

app.get('/app/events/new', async (c) => {
  const props = await adminProps(c, 'New event', { headerTitle: 'New event' });
  const dates = defaultDates();
  const err = c.req.query('err');
  const host = c.env.APP_ORIGIN.replace(/^https?:\/\//, '') + '/';
  const guessTz = TIMEZONES.includes('Europe/Berlin') ? 'Europe/Berlin' : 'UTC';

  return c.html(
    <AdminLayout {...props} scripts={['/js/setup.js']}>
      <div style="padding:36px 28px;display:flex;justify-content:center;">
        <div style="width:100%;max-width:640px;">
          <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;margin-bottom:6px;`}>
            NEW EVENT · STEP 1 OF 2 · BASICS
          </div>
          <div style="font-weight:700;font-size:22px;letter-spacing:-0.01em;margin-bottom:4px;">Create your event</div>
          <div style="font-size:13px;color:#686b74;margin-bottom:26px;">
            Tracks, formats, levels, a Main Stage and the standard email templates are copied in. Change them anytime
            on Setup &amp; Theming.
          </div>
          {err ? (
            <div style="border:1px solid #e03131;background:#fbe9e9;color:#c92a2a;padding:9px 11px;font-size:12.5px;margin-bottom:16px;">
              {err}
            </div>
          ) : null}
          <form method="post" action="/app/events/new" style="display:grid;gap:20px;">
            <div>
              <div style={FIELD_LABEL}>Event name *</div>
              <input id="event-name" name="name" required placeholder="e.g. DevConf 2027" style={INPUT} />
            </div>
            <div>
              <div style={FIELD_LABEL}>Slug</div>
              <div style="display:flex;border:1px solid #e2e3e8;">
                <span style={`padding:8px 0 8px 10px;font-family:${MONO};font-size:12px;color:#9a9da6;`}>{host}</span>
                <input
                  id="event-slug"
                  name="slug"
                  data-autoslug="1"
                  placeholder="devconf-2027"
                  style={`flex:1;min-width:0;padding:8px 10px 8px 2px;border:none;font-family:${MONO};font-size:12px;outline:none;`}
                />
              </div>
              <div style="font-size:11.5px;color:#9a9da6;margin-top:4px;">
                Public URLs live here — forms, agenda, speaker pages.
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              <div>
                <div style={FIELD_LABEL}>Starts *</div>
                <input type="date" name="start_date" required value={dates.start} style={INPUT} />
              </div>
              <div>
                <div style={FIELD_LABEL}>Ends *</div>
                <input type="date" name="end_date" required value={dates.end} style={INPUT} />
              </div>
            </div>
            <div>
              <div style={FIELD_LABEL}>Timezone *</div>
              <select name="timezone" style={SELECT}>
                {TIMEZONES.map((tz) => (
                  <option value={tz} selected={tz === guessTz}>
                    {tz}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div style={FIELD_LABEL}>Location</div>
              <input name="venue" placeholder="e.g. Station Berlin, Luckenwalder Str. 4–6" style={INPUT} />
            </div>
            <div>
              <div style={FIELD_LABEL}>Mode</div>
              <select name="mode" style={SELECT}>
                {EVENT_MODES.map((m) => (
                  <option value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;border-top:1px solid #eceded;padding-top:18px;">
              <a
                href="/app"
                style="padding:8px 14px;background:#fff;border:1px solid #e2e3e8;font-size:13px;color:#16171d;text-decoration:none;"
              >
                Cancel
              </a>
              <button
                type="submit"
                style="padding:8px 16px;background:#4c5fd5;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;"
              >
                Create event
              </button>
            </div>
          </form>
        </div>
      </div>
    </AdminLayout>
  );
});

app.post('/app/events/new', async (c) => {
  const user = c.var.user!;
  const body = await c.req.parseBody();
  const name = String(body.name ?? '').trim();
  const rawSlug = String(body.slug ?? '').trim();
  const startDate = String(body.start_date ?? '').slice(0, 10);
  const endDate = String(body.end_date ?? '').slice(0, 10) || startDate;
  const timezone = String(body.timezone ?? 'UTC');
  const venue = String(body.venue ?? '').trim() || null;
  const mode = String(body.mode ?? 'in_person');

  const fail = (msg: string) => c.redirect('/app/events/new?err=' + encodeURIComponent(msg));
  if (!name) return fail('Event name is required');
  if (!startDate) return fail('Start date is required');
  if (endDate < startDate) return fail('End date cannot be before the start date');

  const slug = slugify(rawSlug || name);
  if (rawSlug && (await slugTaken(c.env.DB, slug))) {
    return fail(`The slug “${slug}” is already taken — pick another`);
  }

  // A user's first event also creates their org.
  const orgId = await ensureOrgForUser(c.env.DB, user.id, firstName(user));

  const event = await createEvent(c.env.DB, {
    orgId,
    name,
    slug,
    startDate,
    endDate,
    timezone,
    venue,
    mode,
  });

  await setActiveEvent(c, event.id);
  return c.redirect('/app/setup?ok=' + encodeURIComponent(`“${event.name}” created`));
});

app.post('/app/switch-event', async (c) => {
  const body = await c.req.parseBody();
  const eventId = String(body.event_id ?? '');
  const user = c.var.user!;
  const allowed = await one<{ id: string }>(
    c.env.DB,
    `SELECT e.id FROM events e JOIN org_members m ON m.org_id = e.org_id WHERE e.id = ? AND m.user_id = ?`,
    eventId,
    user.id
  );
  if (allowed) await setActiveEvent(c, eventId);
  const back = c.req.header('referer');
  const path = back && back.includes('/app') ? new URL(back).pathname : '/app';
  return c.redirect(path);
});

export default app;
