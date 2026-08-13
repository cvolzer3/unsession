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
import { raw } from 'hono/html';
import type { Ctx, Event } from '../types';
import { PublicLayout, publicNav, PUBLIC_PAGE_MAX } from '../views/layout';
import { loadPublicEvent } from '../lib/public';
import { one, jsonParse } from '../lib/db';
import { eventDays, fmtSpan, loadAgenda, roomNamer, speakerAffiliation, type SessionRow } from '../lib/agenda';

const app = new Hono<Ctx>();

type ProfileRow = {
  id: string;
  event_id: string;
  name: string;
  email: string;
  bio: string;
  job_title: string | null;
  company: string | null;
  tagline: string | null;
  pronouns: string | null;
  links_json: string | null;
  slug: string;
  headshot_file_id: string | null;
};

type ProfileLinks = { linkedin?: string; x?: string; website?: string; other?: string };

/** "Other" links get labeled by their hostname — "github.com ↗" reads better than "Other ↗". */
function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || 'Link';
  } catch {
    return 'Link';
  }
}

/** Sessions a public profile may list: published, and confirmed when the event hides unconfirmed talks. */
function publishable(event: Event, s: SessionRow): boolean {
  return s.published === 1 && (!event.hide_unconfirmed || s.status === 'confirmed' || s.type !== 'talk');
}

function initialsOfName(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/**
 * Responsive rules for the profile. Only the properties that must change on a
 * phone live here — everything else stays inline, per SPECS/M-mobile.md. The
 * session card is a two-column grid on desktop (time rail + body); below the
 * breakpoint the rail would squeeze the title to one word per line, so the
 * card stacks.
 */
const speakerCss = () => `
.sp-page{padding:24px 28px 72px;}
.sp-hero{gap:30px;margin-top:34px;}
.sp-shot{width:172px;height:172px;}
.sp-shot-img{width:172px;height:172px;}
.sp-body{flex:1;min-width:280px;}
.sp-name{font-size:34px;overflow-wrap:anywhere;}
.sp-card{padding:16px 20px;display:grid;grid-template-columns:130px 1fr;gap:18px;}
.sp-when-b{margin-top:3px;}
.sp-when-c{margin-top:2px;}
@media (max-width:768px){
  .sp-page{padding:16px 14px 48px;}
  .sp-hero{gap:16px;margin-top:20px;}
  .sp-shot{width:120px;height:120px;}
  .sp-shot-img{width:120px;height:120px;}
  .sp-body{min-width:0;flex-basis:100%;}
  .sp-name{font-size:27px;}
  .sp-card{padding:14px;grid-template-columns:minmax(0,1fr);gap:8px;}
  /* Stacked card: the time rail reads as one line above the title. */
  .sp-when{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 9px;}
  .sp-when-b,.sp-when-c{margin-top:0;}
  /* Comfortable thumb target for the small text links. */
  .sp-link{min-height:40px;display:inline-flex;align-items:center;}
}
`;

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
    <div style="display:flex;align-items:center;gap:14px;margin-top:18px;">
      <a class="sp-link" href={`/${event.slug}/speakers`} style="margin-left:auto;font-size:13px;">
        ← All speakers
      </a>
      <a class="sp-link" href={`/${event.slug}/agenda`} style="font-size:13px;">
        Full agenda
      </a>
    </div>
  );

  if (!profile || !mine.length) {
    return c.html(
      <PublicLayout title="Speaker" event={event} theme={theme} maxWidth={PUBLIC_PAGE_MAX} nav={publicNav(event.slug, 'speakers')}>
        <style>{raw(speakerCss())}</style>
        <div class="sp-page" style={`max-width:${PUBLIC_PAGE_MAX}px;margin:0 auto;`}>
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

  const links = jsonParse<ProfileLinks>(profile.links_json, {});
  const linkItems: { label: string; url: string }[] = [];
  if (links.linkedin) linkItems.push({ label: 'LinkedIn', url: links.linkedin });
  if (links.x) linkItems.push({ label: 'X', url: links.x });
  if (links.website) linkItems.push({ label: 'Website', url: links.website });
  if (links.other) linkItems.push({ label: hostLabel(links.other), url: links.other });

  return c.html(
    <PublicLayout title={profile.name} event={event} theme={theme} maxWidth={PUBLIC_PAGE_MAX} nav={publicNav(event.slug, 'speakers')}>
      <style>{raw(speakerCss())}</style>
      <div class="sp-page" style={`max-width:${PUBLIC_PAGE_MAX}px;margin:0 auto;`}>
        {backLink}
        <div class="sp-hero" style="display:flex;align-items:flex-start;flex-wrap:wrap;">
          <div class="sp-shot" style="flex:none;">
            {headshot ? (
              <img
                src={headshot}
                alt={profile.name}
                width="172"
                height="172"
                class="sp-shot-img"
                style="object-fit:cover;display:block;background:var(--chip);"
              />
            ) : (
              <div class="sp-shot" style="background:var(--chip);color:var(--primary);display:grid;place-items:center;font-size:46px;font-weight:700;letter-spacing:-0.02em;">
                {initialsOfName(profile.name)}
              </div>
            )}
          </div>
          <div class="sp-body">
            <div style="font-family:var(--font-mono);font-size:10px;letter-spacing:0.14em;color:var(--muted);">
              {`SPEAKER · ${event.name.toUpperCase()}`}
            </div>
            <h1 class="sp-name" style="margin:8px 0 0;letter-spacing:-0.02em;line-height:1.1;">{profile.name}</h1>
            {speakerAffiliation(profile) ? (
              <div style="font-size:14.5px;color:var(--text-secondary);margin-top:6px;">{speakerAffiliation(profile)}</div>
            ) : null}
            {profile.pronouns ? (
              <div style="font-size:13px;color:var(--muted);margin-top:6px;">{profile.pronouns}</div>
            ) : null}
            {profile.bio ? (
              <div style="font-size:14.5px;color:var(--text-secondary);line-height:1.6;margin-top:12px;max-width:520px;">
                {profile.bio}
              </div>
            ) : null}
            {linkItems.length ? (
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;margin-top:12px;">
                {linkItems.map((l, i) => (
                  <>
                    {i > 0 ? <span style="color:var(--faint);">·</span> : null}
                    <a class="sp-link" href={l.url} target="_blank" rel="noopener noreferrer">
                      {`${l.label} ↗`}
                    </a>
                  </>
                ))}
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
              <div class="sp-card" style="background:var(--card);border:1px solid var(--border);">
                <div class="sp-when" style="font-family:var(--font-mono);">
                  <div style="font-size:12px;font-weight:600;color:var(--text);">{s.time}</div>
                  <div class="sp-when-b" style="font-size:10px;color:var(--muted);">{s.day}</div>
                  {s.room ? <div class="sp-when-c" style="font-size:10px;color:var(--muted);">{s.room}</div> : null}
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
