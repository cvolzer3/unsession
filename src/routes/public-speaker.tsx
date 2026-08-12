/**
 * Public speaker profile — `/{event}/speakers/{slug}`.
 *
 * Ported from `Speaker Profile.dc.html` minus its dev-only speaker picker.
 * A profile is public only while the speaker has at least one publishable
 * session; scheduled slots show day/time/room, confirmed-but-unscheduled
 * sessions show a TBA row.
 *
 * OWNER: B4.
 */
import { Hono } from 'hono';
import type { Ctx, Event } from '../types';
import { PublicLayout } from '../views/layout';
import { loadPublicEvent } from '../lib/public';
import { one } from '../lib/db';
import { eventDays, fmtSpan, loadAgenda, roomNamer, type SessionRow } from '../lib/agenda';

const app = new Hono<Ctx>();

type ProfileRow = {
  id: string;
  event_id: string;
  name: string;
  email: string;
  bio: string;
  slug: string;
  headshot_file_id: string | null;
};

/** Sessions a public profile may list: published, and confirmed when the event hides unconfirmed talks. */
function publishable(event: Event, s: SessionRow): boolean {
  return s.published === 1 && (!event.hide_unconfirmed || s.status === 'confirmed' || s.type !== 'talk');
}

function initialsOfName(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

app.get('/:event/speakers/:slug', async (c) => {
  const found = await loadPublicEvent(c.env.DB, c.req.param('event'));
  if (!found) return c.notFound();
  const { event, theme } = found;

  const profile = await one<ProfileRow>(
    c.env.DB,
    `SELECT * FROM speaker_profiles WHERE event_id = ? AND slug = ?`,
    event.id,
    c.req.param('slug')
  );

  const bundle = event.published ? await loadAgenda(c.env.DB, event.id) : null;
  const mine =
    profile && bundle
      ? bundle.sessions.filter(
          (s) => publishable(event, s) && (bundle.speakers.get(s.id) ?? []).some((p) => p.id === profile.id)
        )
      : [];

  const backLink = (
    <div style="display:flex;align-items:center;gap:10px;margin-top:18px;">
      <a href={`/${event.slug}/agenda`} style="margin-left:auto;font-size:13px;">
        ← Full agenda
      </a>
    </div>
  );

  if (!profile || !mine.length) {
    return c.html(
      <PublicLayout title="Speaker" event={event} theme={theme} maxWidth={840}>
        <div style="max-width:840px;margin:0 auto;padding:24px 28px 72px;">
          {backLink}
          <div style="margin-top:60px;text-align:center;">
            <div style="font-size:20px;font-weight:600;">Speaker not found</div>
            <div style="font-size:13px;color:var(--muted);margin-top:8px;">
              This profile doesn’t exist or isn’t public. <a href={`/${event.slug}/agenda`}>Browse the agenda</a>
            </div>
          </div>
        </div>
      </PublicLayout>,
      404
    );
  }

  const days = eventDays(event);
  const roomName = roomNamer(bundle!);
  const trackById = new Map(bundle!.tracks.map((t) => [t.id, t]));
  const formatById = new Map(bundle!.formats.map((f) => [f.id, f]));

  const rows = mine
    .map((s) => {
      const scheduled = s.day !== null && s.start_min !== null;
      const co = (bundle!.speakers.get(s.id) ?? []).filter((p) => p.id !== profile.id).map((p) => p.name);
      const fmt = s.format_option_id ? formatById.get(s.format_option_id) : null;
      return {
        sort: scheduled ? s.day! * 10000 + s.start_min! : 999999,
        time: scheduled ? fmtSpan(s.start_min!, s.end_min ?? s.start_min! + s.duration_min) : 'TBA',
        day: scheduled ? days[s.day!]?.long ?? `DAY ${s.day! + 1}` : 'TO BE ANNOUNCED',
        room: scheduled ? (s.all_rooms ? 'ALL ROOMS' : roomName(s.room_id).toUpperCase()) : '',
        title: s.title,
        track: s.track_option_id ? trackById.get(s.track_option_id) : null,
        format: fmt ? (fmt.duration_min ? `${fmt.name} (${fmt.duration_min} min)` : fmt.name) : '',
        with: co.join(', '),
        abstract: s.abstract,
      };
    })
    .sort((a, b) => a.sort - b.sort);

  const headshot = profile.headshot_file_id ? `/files/${profile.headshot_file_id}` : null;

  return c.html(
    <PublicLayout title={profile.name} event={event} theme={theme} maxWidth={840}>
      <div style="max-width:840px;margin:0 auto;padding:24px 28px 72px;">
        {backLink}
        <div style="display:flex;gap:30px;align-items:flex-start;margin-top:34px;flex-wrap:wrap;">
          <div style="width:172px;height:172px;flex:none;">
            {headshot ? (
              <img
                src={headshot}
                alt={profile.name}
                width="172"
                height="172"
                style="width:172px;height:172px;object-fit:cover;display:block;background:var(--chip);"
              />
            ) : (
              <div style="width:172px;height:172px;background:var(--chip);color:var(--primary);display:grid;place-items:center;font-size:46px;font-weight:700;letter-spacing:-0.02em;">
                {initialsOfName(profile.name)}
              </div>
            )}
          </div>
          <div style="flex:1;min-width:280px;">
            <div style="font-family:var(--font-mono);font-size:10px;letter-spacing:0.14em;color:var(--muted);">
              {`SPEAKER · ${event.name.toUpperCase()}`}
            </div>
            <h1 style="margin:8px 0 0;font-size:34px;letter-spacing:-0.02em;line-height:1.1;">{profile.name}</h1>
            {profile.bio ? (
              <div style="font-size:14.5px;color:var(--text-secondary);line-height:1.6;margin-top:12px;max-width:520px;">
                {profile.bio}
              </div>
            ) : null}
          </div>
        </div>
        <div style="margin-top:40px;">
          <div style="font-family:var(--font-mono);font-size:10px;letter-spacing:0.14em;color:var(--muted);border-bottom:1px solid var(--border);padding-bottom:9px;">
            {rows.length ? `SESSIONS · ${rows.length}` : 'SESSIONS'}
          </div>
          <div style="display:grid;gap:10px;margin-top:14px;">
            {rows.map((s) => (
              <div style="background:var(--card);border:1px solid var(--border);padding:16px 20px;display:grid;grid-template-columns:130px 1fr;gap:18px;">
                <div style="font-family:var(--font-mono);">
                  <div style="font-size:12px;font-weight:600;color:var(--text);">{s.time}</div>
                  <div style="font-size:10px;color:var(--muted);margin-top:3px;">{s.day}</div>
                  {s.room ? <div style="font-size:10px;color:var(--muted);margin-top:2px;">{s.room}</div> : null}
                </div>
                <div>
                  <div style="font-size:16.5px;font-weight:600;letter-spacing:-0.01em;line-height:1.3;">{s.title}</div>
                  <div style="display:flex;align-items:center;gap:7px;font-size:12px;color:var(--text-secondary);margin-top:5px;flex-wrap:wrap;">
                    <span
                      style={`width:8px;height:8px;border-radius:50%;background:${s.track?.color ?? '#adb5bd'};flex:none;`}
                    ></span>
                    {s.track?.name ?? '—'}
                    {s.format ? (
                      <>
                        <span style="color:var(--faint);">·</span>
                        {s.format}
                      </>
                    ) : null}
                    {s.with ? (
                      <>
                        <span style="color:var(--faint);">·</span>
                        <span>{`with ${s.with}`}</span>
                      </>
                    ) : null}
                  </div>
                  {s.abstract ? (
                    <div style="font-size:13px;color:var(--text-secondary);line-height:1.55;margin-top:8px;">{s.abstract}</div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </PublicLayout>
  );
});

export default app;
