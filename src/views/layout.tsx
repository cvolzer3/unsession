/**
 * Layout primitives. Markup + inline styles are ported verbatim from the
 * prototype (`Dashboard.dc.html`, `Event Setup.dc.html`, `Forms.dc.html`
 * picker, `Submit.dc.html` public header). Square corners, admin indigo,
 * Space Grotesk + IBM Plex Mono. Product name "Unsession", logo letter "U".
 */
import type { FC, PropsWithChildren } from 'hono/jsx';
import { raw } from 'hono/html';
import type { Event, Theme, User } from '../types';
import { pairingFor, themeStyleVars, initialsOf } from '../lib/theme';
import { SANDBOX_PERSONAS, SANDBOX_PERSONA_KEYS, type SandboxPersonaKey } from '../lib/seed-data';

export const MONO = "'IBM Plex Mono',monospace";
export const GOOGLE_FONTS =
  'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap';

export const ADMIN_BASE_CSS = `
  html,body{margin:0;padding:0;background:#f4f4f6;color:#16171d;font-family:'Space Grotesk',sans-serif;}
  a{color:#4c5fd5;text-decoration:none;} a:hover{color:#3a4ab8;text-decoration:underline;}
  *{box-sizing:border-box;} input,textarea,select,button{font-family:inherit;}
  [hidden]{display:none !important;}
  @keyframes toastin{from{transform:translateY(12px);opacity:0}to{transform:none;opacity:1}}
  @keyframes slidein{from{transform:translateX(24px);opacity:0}to{transform:none;opacity:1}}
  #sandbox-switcher summary::-webkit-details-marker{display:none;}
`;

export function initials(nameOrEmail: string): string {
  const s = (nameOrEmail || '').trim();
  if (!s) return '?';
  if (s.includes('@') && !s.includes(' ')) return s.slice(0, 2).toUpperCase();
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function firstName(user: User | null): string {
  if (!user) return 'there';
  const n = (user.name || '').trim();
  if (n) return n.split(/\s+/)[0];
  return user.email.split('@')[0];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtDate(iso: string | null | undefined, withYear = false): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${MONTHS[m - 1]} ${d}` + (withYear ? `, ${y}` : '');
}

export function fmtDateRange(start: string, end: string): string {
  if (!start) return '';
  const [sy, sm, sd] = start.slice(0, 10).split('-').map(Number);
  const [ey, em, ed] = (end || start).slice(0, 10).split('-').map(Number);
  if (start.slice(0, 10) === (end || start).slice(0, 10)) return `${MONTHS[sm - 1]} ${sd}`;
  if (sy === ey && sm === em) return `${MONTHS[sm - 1]} ${sd}–${ed}`;
  return `${MONTHS[sm - 1]} ${sd} – ${MONTHS[em - 1]} ${ed}`;
}

/* ------------------------------------------------------------------ toast */

export const Toast: FC<{ message?: string | null }> = ({ message }) => {
  if (!message) return null;
  return (
    <>
      <div
        id="us-toast"
        style="position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#16171d;color:#fff;padding:11px 18px;font-size:13px;z-index:80;animation:toastin 0.15s ease;display:flex;gap:10px;align-items:center;box-shadow:0 8px 24px rgba(22,23,29,0.3);"
      >
        <span style="color:#69db7c;">✓</span>
        {message}
      </div>
      {raw(
        `<script>setTimeout(function(){var t=document.getElementById('us-toast');if(t)t.remove();},3000);` +
          `if(history.replaceState){var u=new URL(location.href);u.searchParams.delete('ok');history.replaceState({},'',u.pathname+(u.search||'')+u.hash);}</script>`
      )}
    </>
  );
};

/* -------------------------------------------------------- sandbox switcher */

/** What the bottom-right "Viewing as …" chip needs (sandbox orgs only). */
export type SandboxWidget = {
  orgId: string;
  /** e.g. "Marta (Organizer)" */
  personaLabel: string;
  personaKey: SandboxPersonaKey | null;
};

/**
 * Fixed bottom-right role chip for sandbox orgs: "SANDBOX · Viewing as … ▾"
 * opening a three-persona menu. Pure `<details>` — no island. Each row is a
 * real form POST to `/sandbox/switch`, which re-signs the visitor in as that
 * persona (routes/sandbox.tsx verifies the org really is a sandbox).
 */
const SandboxSwitcher: FC<{ sandbox: SandboxWidget; hidden?: boolean }> = ({ sandbox, hidden }) => (
  <details id="sandbox-switcher" hidden={hidden} style="position:fixed;bottom:18px;right:18px;z-index:70;font-family:'Space Grotesk',sans-serif;">
    <summary style="list-style:none;display:flex;align-items:center;gap:9px;background:#16171d;color:#fff;padding:9px 14px;font-size:12.5px;cursor:pointer;user-select:none;box-shadow:0 8px 24px rgba(22,23,29,0.35);">
      <span style={`font-family:${MONO};font-size:9.5px;letter-spacing:0.12em;font-weight:600;color:#ffd43b;`}>SANDBOX</span>
      <span>
        Viewing as <b id="sandbox-persona-label">{sandbox.personaLabel}</b>
      </span>
      <span style="color:#9a9da6;font-size:10px;">▾</span>
    </summary>
    <div style="position:absolute;bottom:calc(100% + 8px);right:0;width:280px;background:#fff;border:1px solid #e2e3e8;box-shadow:0 8px 24px rgba(22,23,29,0.16);">
      <div style={`padding:10px 14px 6px;font-family:${MONO};font-size:9.5px;letter-spacing:0.12em;color:#9a9da6;`}>
        SWITCH ROLE
      </div>
      {SANDBOX_PERSONA_KEYS.map((key) => {
        const p = SANDBOX_PERSONAS[key];
        const current = key === sandbox.personaKey;
        return (
          <form method="post" action="/sandbox/switch">
            <input type="hidden" name="org" value={sandbox.orgId} />
            <input type="hidden" name="persona" value={key} />
            <button
              type="submit"
              data-persona={key}
              style={`display:flex;flex-direction:column;gap:2px;align-items:flex-start;text-align:left;width:100%;padding:9px 14px;cursor:pointer;background:${current ? '#eef0fb' : '#fff'};border:none;border-top:1px solid #eceded;`}
            >
              <span style="font-size:13px;font-weight:600;color:#16171d;">{`${p.name} — ${p.title}${current ? ' ✓' : ''}`}</span>
              <span style="font-size:11.5px;color:#686b74;">{p.blurb}</span>
            </button>
          </form>
        );
      })}
    </div>
  </details>
);

/**
 * PublicLayout fallback when the route didn't pass a `sandbox` prop: a hidden
 * widget plus an inline script that fills it from the `us_sandbox` cookie set
 * by routes/sandbox.tsx — zero extra queries on public pages. The slug check
 * keeps the chip off real events even while a sandbox cookie exists, and
 * `/sandbox/switch` re-verifies everything server-side anyway.
 */
const SANDBOX_COOKIE_SCRIPT = `<script>(function(){
var el=document.getElementById('sandbox-switcher');if(!el||!el.hidden)return;
var m=document.cookie.match(/(?:^|; )us_sandbox=([^;]*)/);if(!m){el.remove();return;}
var d;try{d=JSON.parse(decodeURIComponent(m[1]));}catch(e){}
if(!d||!d.o||!d.s||(location.pathname+'/').indexOf('/'+d.s+'/')!==0){el.remove();return;}
var l=document.getElementById('sandbox-persona-label');if(l)l.textContent=d.n||'…';
el.querySelectorAll('input[name=org]').forEach(function(i){i.value=d.o;});
var b=el.querySelector('button[data-persona="'+d.p+'"]');if(b)b.style.background='#eef0fb';
el.hidden=false;
})();</script>`;

/**
 * Cookie-driven sandbox chip for shells without a `sandbox` prop — PublicLayout
 * pages and standalone shells like the evaluator workspace. Renders hidden;
 * the inline script reveals it only on the sandbox event's own pages.
 */
export const SandboxCookieFallback: FC = () => (
  <>
    <SandboxSwitcher sandbox={{ orgId: '', personaLabel: '…', personaKey: null }} hidden />
    {raw(SANDBOX_COOKIE_SCRIPT)}
  </>
);

/* ------------------------------------------------------------------ admin */

export type NavItem = { label: string; href: string; external?: boolean };

export type CfpPill = { label: string; color: string } | null;

export type AdminLayoutProps = PropsWithChildren<{
  title: string;
  user: User | null;
  event: Event | null;
  events?: Event[];
  path: string;
  headerTitle?: string;
  headerActions?: unknown;
  cfp?: CfpPill;
  publicFormSlug?: string | null;
  publicForms?: { slug: string; name: string }[];
  toast?: string | null;
  scripts?: string[];
  origin?: string;
  /** Set (by adminProps) when the active org is a sandbox — renders the role switcher. */
  sandbox?: SandboxWidget | null;
}>;

function navLink(href: string, label: string, active: boolean, external = false) {
  const style = active
    ? 'display:block;padding:7px 20px;color:#4c5fd5;font-size:13.5px;background:#eef0fb;font-weight:600;text-decoration:none;'
    : 'display:block;padding:7px 20px;color:#16171d;font-size:13.5px;text-decoration:none;';
  return external ? (
    <a href={href} target="_blank" rel="noreferrer" style={style}>
      {label}
    </a>
  ) : (
    <a href={href} style={style}>
      {label}
    </a>
  );
}

const SECTION_LABEL = `padding:14px 20px 4px;font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;`;

export const AdminLayout: FC<AdminLayoutProps> = (props) => {
  const { title, user, event, path, children } = props;
  const events = props.events ?? [];
  const slug = event?.slug ?? '';
  const host = (props.origin || 'https://unsession.dev').replace(/^https?:\/\//, '');
  const isActive = (p: string) => path === p || (p !== '/app' && path.startsWith(p + '/'));

  return (
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`Unsession — ${title}`}</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href={GOOGLE_FONTS} rel="stylesheet" />
        <style>{raw(ADMIN_BASE_CSS)}</style>
      </head>
      <body>
        <div style="display:grid;grid-template-columns:216px 1fr;min-height:100vh;">
          <nav style="background:#fff;border-right:1px solid #e2e3e8;padding:20px 0;display:flex;flex-direction:column;gap:2px;position:sticky;top:0;height:100vh;overflow-y:auto;">
            <div style="padding:0 20px 18px;display:flex;align-items:center;gap:8px;">
              <div style={`width:22px;height:22px;background:#4c5fd5;color:#fff;display:grid;place-items:center;font-family:${MONO};font-size:12px;font-weight:600;`}>
                U
              </div>
              <div style="font-weight:700;font-size:15px;letter-spacing:-0.01em;">Unsession</div>
            </div>
            {navLink('/app', 'Dashboard', path === '/app')}
            <div style={`padding:6px 20px 4px;font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;`}>
              EVENT
            </div>
            {navLink('/app/setup', 'Setup & Theming', isActive('/app/setup'))}
            {navLink('/app/forms', 'Forms', isActive('/app/forms'))}
            {navLink('/app/team', 'Team', isActive('/app/team'))}
            {navLink('/app/emails', 'Emails', isActive('/app/emails'))}
            <div style={SECTION_LABEL}>PROGRAM</div>
            {navLink('/app/submissions', 'Submissions', isActive('/app/submissions'))}
            {navLink('/app/evaluation', 'Evaluation', isActive('/app/evaluation'))}
            {navLink('/app/sessions', 'Sessions', isActive('/app/sessions'))}
            {navLink('/app/speakers', 'Speakers & Tasks', isActive('/app/speakers'))}
            {navLink('/app/agenda', 'Agenda', isActive('/app/agenda'))}
            <div style={SECTION_LABEL}>PUBLIC</div>
            {(props.publicForms ?? []).map((f) => navLink(`/${slug}/${f.slug}`, `${f.name} ↗`, false, true))}
            {navLink(`/${slug}/agenda`, 'Agenda Page ↗', false, true)}
            <div style="margin-top:auto;padding:14px 20px 0;border-top:1px solid #eceded;">
              <div style="display:flex;align-items:center;gap:9px;">
                <div style={`width:28px;height:28px;border-radius:50%;background:#4c5fd5;color:#fff;display:grid;place-items:center;font-family:${MONO};font-size:10.5px;font-weight:600;`}>
                  {initials(user?.name || user?.email || '')}
                </div>
                <div style="min-width:0;">
                  <div style="font-size:12.5px;font-weight:600;">{user?.name || user?.email || 'Signed out'}</div>
                  <a href="/auth/signout" style="font-size:11px;color:#9a9da6;text-decoration:none;">
                    Sign out
                  </a>
                </div>
              </div>
            </div>
          </nav>
          <main style="min-width:0;">
            <header style="background:#fff;border-bottom:1px solid #e2e3e8;padding:14px 28px;display:flex;align-items:center;gap:14px;">
              <div style="position:relative;min-width:0;">
                {props.headerTitle ? (
                  <div style="font-weight:700;font-size:16px;letter-spacing:-0.01em;">{props.headerTitle}</div>
                ) : (
                  <>
                    <button
                      type="button"
                      data-toggle="#event-picker"
                      title="Switch event"
                      style="display:flex;align-items:center;gap:10px;background:#f4f5f9;border:1px solid #d8d9de;padding:6px 10px;cursor:pointer;max-width:540px;"
                    >
                      <span style="font-weight:700;font-size:16px;letter-spacing:-0.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                        {event?.name ?? 'No event yet'}
                      </span>
                      <span style="color:#686b74;font-size:11px;border-left:1px solid #d8d9de;padding-left:10px;">▾</span>
                    </button>
                    <div style={`font-family:${MONO};font-size:11px;color:#9a9da6;margin-top:5px;`}>
                      {event
                        ? `${host}/${event.slug} · ${fmtDateRange(event.start_date, event.end_date)} · ${event.timezone}`
                        : 'Create your first event to get started'}
                    </div>
                    <div
                      id="event-picker"
                      hidden
                      style="position:absolute;top:calc(100% + 8px);left:0;width:360px;background:#fff;border:1px solid #e2e3e8;box-shadow:0 8px 24px rgba(22,23,29,0.12);z-index:50;"
                    >
                      {events.map((e) => (
                        <form method="post" action="/app/switch-event">
                          <input type="hidden" name="event_id" value={e.id} />
                          <button
                            type="submit"
                            style={`display:flex;flex-direction:column;gap:3px;align-items:flex-start;text-align:left;width:100%;padding:11px 14px;cursor:pointer;background:${
                              e.id === event?.id ? '#eef0fb' : '#fff'
                            };border:none;border-bottom:1px solid #eceded;`}
                          >
                            <span style="display:flex;align-items:center;gap:8px;">
                              <span style="font-size:13px;font-weight:600;">{e.name}</span>
                            </span>
                            <span style={`font-size:11px;color:#9a9da6;font-family:${MONO};`}>
                              {`/${e.slug} · ${fmtDateRange(e.start_date, e.end_date)}`}
                            </span>
                          </button>
                        </form>
                      ))}
                      <a
                        href="/app/events/new"
                        style="display:block;width:100%;padding:11px 14px;font-size:13px;font-weight:600;color:#4c5fd5;background:#fff;text-decoration:none;"
                      >
                        ＋ New event
                      </a>
                    </div>
                  </>
                )}
              </div>
              <div style="margin-left:auto;display:flex;align-items:center;gap:12px;">
                {props.headerActions as never}
                {props.cfp ? (
                  <div style="display:flex;align-items:center;gap:7px;">
                    <span style={`width:7px;height:7px;border-radius:50%;background:${props.cfp.color};`}></span>
                    <span style={`font-family:${MONO};font-size:10px;letter-spacing:0.1em;color:#686b74;`}>
                      {props.cfp.label}
                    </span>
                  </div>
                ) : null}
              </div>
            </header>
            {children}
          </main>
        </div>
        <Toast message={props.toast} />
        {props.sandbox ? <SandboxSwitcher sandbox={props.sandbox} /> : null}
        <script type="module" src="/js/ui.js"></script>
        {(props.scripts ?? []).map((s) => (
          <script type="module" src={s}></script>
        ))}
      </body>
    </html>
  );
};

/* ------------------------------------------------------------------ public */

export type PublicLayoutProps = PropsWithChildren<{
  title: string;
  event: { name: string; slug: string };
  theme: Theme;
  toast?: string | null;
  scripts?: string[];
  maxWidth?: number;
  kicker?: string;
  /**
   * Pass when the route already knows the event's org is a sandbox (renders
   * the role switcher server-side). When omitted, a cookie-driven fallback
   * still shows the chip on the sandbox event's own pages — no extra query.
   */
  sandbox?: SandboxWidget | null;
}>;

export const PublicLayout: FC<PublicLayoutProps> = (props) => {
  const pair = pairingFor(props.theme.font);
  const vars = themeStyleVars(props.theme);
  const max = props.maxWidth ?? 620;
  const fontsHref = `https://fonts.googleapis.com/css2?${pair.google}&display=swap`;
  const css = `
  html,body{margin:0;padding:0;background:var(--bg);color:var(--text);font-family:var(--font-ui);}
  a{color:var(--primary);text-decoration:none;} a:hover{color:var(--primary-hover);text-decoration:underline;}
  *{box-sizing:border-box;} input,textarea,select,button{font-family:inherit;}
  [hidden]{display:none !important;}
  @keyframes toastin{from{transform:translateY(12px);opacity:0}to{transform:none;opacity:1}}
  @keyframes slidein{from{transform:translateX(24px);opacity:0}to{transform:none;opacity:1}}
  #sandbox-switcher summary::-webkit-details-marker{display:none;}
`;
  return (
    <html style={vars}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${props.event.name} — ${props.title}`}</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href={fontsHref} rel="stylesheet" />
        <style>{raw(css)}</style>
      </head>
      <body>
        <div style="position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--border);z-index:10;">
          <div style={`max-width:${max}px;margin:0 auto;padding:12px 20px;display:flex;align-items:center;gap:10px;`}>
            <div style="width:26px;height:26px;background:var(--primary);color:var(--on-primary);display:grid;place-items:center;font-family:var(--font-mono);font-size:12px;font-weight:700;">
              {initialsOf(props.event.name)}
            </div>
            <div style="font-weight:700;font-size:14.5px;">{props.event.name}</div>
            {props.kicker ? (
              <div style="margin-left:auto;font-family:var(--font-mono);font-size:10.5px;color:var(--muted);">
                {props.kicker}
              </div>
            ) : null}
          </div>
        </div>
        {props.children}
        <Toast message={props.toast} />
        {props.sandbox ? <SandboxSwitcher sandbox={props.sandbox} /> : <SandboxCookieFallback />}
        <script type="module" src="/js/ui.js"></script>
        {(props.scripts ?? []).map((s) => (
          <script type="module" src={s}></script>
        ))}
      </body>
    </html>
  );
};

/* ------------------------------------------------------------------ shared bits */

export const Card: FC<PropsWithChildren<{ label?: string; pad?: string }>> = ({ label, pad, children }) => (
  <div style={`background:#fff;border:1px solid #e2e3e8;padding:${pad ?? '18px 20px'};`}>
    {label ? (
      <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;margin-bottom:12px;`}>
        {label}
      </div>
    ) : null}
    {children}
  </div>
);

/** "Under construction" placeholder used by the B-track route stubs. */
export const UnderConstruction: FC<{ page: string; note?: string }> = ({ page, note }) => (
  <div style="padding:24px 28px;max-width:1160px;">
    <div style="background:#fff;border:1px solid #e2e3e8;padding:40px 28px;text-align:center;">
      <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;margin-bottom:8px;`}>
        UNDER CONSTRUCTION
      </div>
      <div style="font-size:18px;font-weight:700;letter-spacing:-0.01em;margin-bottom:4px;">{page}</div>
      <div style="font-size:13px;color:#686b74;">{note ?? 'This screen lands in the next build phase.'}</div>
    </div>
  </div>
);

export const STATUS_COLORS: Record<string, { label: string; fg: string; bg: string }> = {
  draft: { label: 'Draft', fg: '#686b74', bg: '#f1f3f5' },
  submitted: { label: 'Submitted', fg: '#1c7ed6', bg: '#e7f1fb' },
  in_review: { label: 'In Review', fg: '#b08800', bg: '#fdf5dc' },
  accepted: { label: 'Accepted', fg: '#2b8a3e', bg: '#e6f4ea' },
  confirmed: { label: 'Confirmed', fg: '#087f5b', bg: '#dcf2eb' },
  declined: { label: 'Declined', fg: '#c92a2a', bg: '#fbe9e9' },
  waitlisted: { label: 'Waitlisted', fg: '#9c36b5', bg: '#f6e8f9' },
  withdrawn: { label: 'Withdrawn', fg: '#868e96', bg: '#f1f3f5' },
  // email log statuses
  sent: { label: 'Sent', fg: '#2b8a3e', bg: '#e6f4ea' },
  queued: { label: 'Queued', fg: '#1c7ed6', bg: '#e7f1fb' },
  failed: { label: 'Failed', fg: '#c92a2a', bg: '#fbe9e9' },
  simulated: { label: 'Simulated', fg: '#b08800', bg: '#fdf5dc' },
  open: { label: 'Open', fg: '#2b8a3e', bg: '#e6f4ea' },
  closed: { label: 'Closed', fg: '#c92a2a', bg: '#fbe9e9' },
  pending: { label: 'Pending', fg: '#686b74', bg: '#f1f3f5' },
  accepted_invite: { label: 'Accepted', fg: '#2b8a3e', bg: '#e6f4ea' },
  revoked: { label: 'Revoked', fg: '#868e96', bg: '#f1f3f5' },
};

export const StatusChip: FC<{ status: string; label?: string }> = ({ status, label }) => {
  const s = STATUS_COLORS[status] ?? { label: status, fg: '#686b74', bg: '#f1f3f5' };
  return (
    <span
      style={`font-family:${MONO};font-size:9px;letter-spacing:0.08em;padding:2px 6px;font-weight:600;color:${s.fg};background:${s.bg};text-transform:uppercase;`}
    >
      {label ?? s.label}
    </span>
  );
};
