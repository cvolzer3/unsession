/**
 * Layout primitives. Markup + inline styles are ported verbatim from the
 * prototype (`Dashboard.dc.html`, `Event Setup.dc.html`, `Forms.dc.html`
 * picker, `Submit.dc.html` public header). Square corners, admin indigo,
 * Space Grotesk + IBM Plex Mono. Product name "Unsession", modular open-U mark.
 */
import type { FC, PropsWithChildren } from 'hono/jsx';
import { raw } from 'hono/html';
import type { Event, Theme, User } from '../types';
import { pairingFor, themeStyleVars, initialsOf } from '../lib/theme';
import { Favicons, SocialMeta } from './meta';
import { ProductLogo } from './brand';
import { SANDBOX_PERSONAS, SANDBOX_PERSONA_KEYS, type SandboxPersonaKey } from '../lib/seed-data';

export const MONO = "'IBM Plex Mono',monospace";
export const GOOGLE_FONTS =
  'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap';

/**
 * The one mobile breakpoint. Every media query in the app keys off this width —
 * see `SPECS/M-mobile.md`, the contract page code follows. Below it we are on a
 * phone: single column, overlay nav, full-width drawers, 16px form controls.
 */
export const MOBILE_MAX = 768;

/**
 * Rules both shells need — the mobile toolkit and the sandbox chip. Spliced
 * into ADMIN_BASE_CSS and into PublicLayout's own `css`, so a page gets the
 * same utilities whichever shell it renders in.
 *
 * `!important` appears only where an inline style or a later page-scoped rule
 * would otherwise win. Inline styles are the house style here (ported verbatim
 * from the prototype) and no media query can beat them, so the mobile
 * overrides that must land on inline-styled elements say so explicitly.
 */
const SHARED_BASE_CSS = `
  /* ------------------------------------------- cross-page paint stability
     Every nav click is a full document load, so two things must hold or the
     chrome appears to jitter on every click. (1) The viewport keeps a stable
     scrollbar gutter: page heights straddle the viewport (some fit, some
     scroll), and on classic-scrollbar systems the bar appearing/leaving
     reflows the page ~15px per navigation. (2) Same-origin navigations run
     as cross-document view transitions: the old frame holds until the new
     document is ready, then cross-fades briefly — no white flash while the
     server thinks. Browsers without @view-transition keep today's behavior. */
  html{scrollbar-gutter:stable;}
  @view-transition{navigation:auto;}
  ::view-transition-group(*){animation-duration:0.12s;}
  ::view-transition-old(root),::view-transition-new(root){animation-duration:0.12s;}
  @media (prefers-reduced-motion:reduce){
    ::view-transition-group(*),::view-transition-old(*),::view-transition-new(*){animation:none !important;}
  }
  /* Wrap anything that cannot narrow — wide tables, code blocks, kanban lanes —
     in .us-scroll-x so it scrolls in its own box instead of widening the page. */
  .us-scroll-x{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%;}
  /* Visibility helpers. Both resolve to display:revert, so put them on elements
     that do NOT set display inline — see SPECS/M-mobile.md. */
  .us-mobile-only{display:none !important;}
  /* Sandbox chip: fits a 320px screen and keeps its menu on-screen. */
  #sandbox-switcher summary::-webkit-details-marker{display:none;}
  .us-sandbox-chip{max-width:calc(100vw - 36px);}
  .us-sandbox-who{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .us-sandbox-menu{width:min(280px,calc(100vw - 36px));}
  @media (max-width:${MOBILE_MAX}px){
    .us-desktop-only{display:none !important;}
    .us-mobile-only{display:revert !important;}
    /* 16px stops iOS Safari zooming the page when a field takes focus. */
    input,textarea,select{font-size:16px !important;}
    /* A side drawer takes the whole screen on a phone, so its header expand
       button becomes a no-op (left in place — it does no harm). Each page
       declares its own .drawer-* width later in the document, hence the
       !important rather than more specificity. */
    .us-drawer-panel{width:100vw !important;max-width:100vw !important;--band-x:16px;}
    /* On a phone the chip must sit under every overlay surface (drawers are
       z 50, dialogs 60+, sheets 72+): at its desktop z 70 it covered drawer
       action footers, leaving Done/Save unreachable. 40 keeps it above plain
       page content only. !important beats the element's inline z-index. */
    #sandbox-switcher{z-index:40 !important;}
  }
`;

export const ADMIN_BASE_CSS = `
  html,body{margin:0;padding:0;background:#f4f4f6;color:#16171d;font-family:'Space Grotesk',sans-serif;}
  a{color:#4c5fd5;text-decoration:none;} a:hover{color:#3a4ab8;text-decoration:underline;}
  *{box-sizing:border-box;} input,textarea,select,button{font-family:inherit;}
  [hidden]{display:none !important;}
  @keyframes toastin{from{transform:translateY(12px);opacity:0}to{transform:none;opacity:1}}
  @keyframes slidein{from{transform:translateX(24px);opacity:0}to{transform:none;opacity:1}}
  @keyframes us-spin{to{transform:rotate(360deg)}}
  /* Side drawers. Every drawer header carries the full-screen toggle: ui.js
     flips [data-expanded] on the nearest [data-drawer] and these rules widen
     the panel to the viewport. Expanding widens the shell, not the text — the
     bands take their side padding from --band-x, so the body stays a readable
     ~880px column while header and footer rules still run edge to edge. A
     panel's own width must live in CSS, not an inline style, or it outranks
     the expanded rule. */
  .us-drawer-panel{--band-x:22px;transition:width 0.16s ease;}
  [data-expanded].us-drawer-panel,[data-expanded] .us-drawer-panel{width:100vw;max-width:100vw;--band-x:max(22px,calc((100vw - 880px) / 2));}
  .us-icon-btn{background:none;border:none;color:#9a9da6;cursor:pointer;padding:4px;display:flex;align-items:center;line-height:0;}
  .us-icon-btn:hover{color:#16171d;}
  [data-drawer] .ic-min{display:none;}
  [data-drawer][data-expanded] .ic-max{display:none;}
  [data-drawer][data-expanded] .ic-min{display:block;}
  .sw-input{appearance:none;-webkit-appearance:none;display:block;width:100%;height:30px;border:1px solid #e2e3e8;padding:0;background:none;cursor:pointer;}
  .sw-input::-webkit-color-swatch-wrapper{padding:0;}
  .sw-input::-webkit-color-swatch{border:none;}
  .sw-input::-moz-color-swatch{border:none;}

  /* ------------------------------------------------- admin shell + header
     The sidebar's geometry and the header's box live here, not inline, so the
     mobile block below can restyle them: an inline style outranks any media
     query. Desktop values are byte-for-byte what the inline styles used to be. */
  .us-shell{display:grid;grid-template-columns:216px 1fr;min-height:100vh;}
  .us-sidenav{background:#fff;border-right:1px solid #e2e3e8;display:flex;flex-direction:column;position:sticky;top:0;height:100vh;}
  /* Keep the sidebar in the root snapshot. Isolating this scroll container as
     its own view-transition group makes Chromium/WebKit intermittently omit
     unchanged descendants while a heavier sandbox page is revealed, which is
     the visible nav jitter. Its geometry matches between documents, so the
     root transition keeps those pixels stationary without a separate layer. */
  .us-adminhead{view-transition-name:us-adminhead;}
  .us-navscrim{display:none;}
  .us-burger,.us-navclose{display:none;}
  .us-adminhead{background:#fff;border-bottom:1px solid #e2e3e8;padding:14px 28px;display:flex;align-items:center;gap:14px;}
  .us-headmain{position:relative;min-width:0;}
  .us-headactions{margin-left:auto;display:flex;align-items:center;gap:12px;}
  .us-eventpick{max-width:540px;}
  .us-eventmenu{left:0;width:360px;}
  @media (max-width:${MOBILE_MAX}px){
    /* The sidebar leaves the grid and becomes an overlay drawer over its own
       scrim; ui.js flips [data-nav-open] on the shell. visibility:hidden while
       closed keeps the off-screen links out of the tab order. */
    .us-shell{grid-template-columns:1fr;}
    .us-signout{display:inline-block;padding:9px 12px 9px 0;}
    /* viewport-fit=cover lets the drawer paint edge to edge, behind the status
       bar and home indicator; the env() padding keeps its content out of them.
       The width grows by the left inset so links don't narrow on notched
       phones in landscape. */
    .us-sidenav{position:fixed;top:0;left:0;z-index:99;width:calc(min(80vw,300px) + env(safe-area-inset-left));height:100vh;height:100dvh;
      padding-top:env(safe-area-inset-top);padding-left:env(safe-area-inset-left);
      border-right:none;box-shadow:6px 0 28px rgba(22,23,29,0.22);
      transform:translateX(-100%);visibility:hidden;transition:transform 0.18s ease,visibility 0s linear 0.18s;}
    /* visibility flips on the same tick the drawer opens (0s, no delay) so
       ui.js can move focus into it right away; hiding waits for the slide out. */
    .us-shell[data-nav-open] .us-sidenav{transform:none;visibility:visible;transition:transform 0.18s ease,visibility 0s;}
    .us-shell[data-nav-open] .us-navscrim{display:block;position:fixed;inset:0;background:rgba(22,23,29,0.45);z-index:98;}
    .us-burger{display:flex;align-items:center;justify-content:center;flex:none;width:40px;height:40px;
      margin:-6px 0 -6px -10px;padding:0;background:none;border:none;color:#16171d;cursor:pointer;}
    .us-navclose{display:flex;align-items:center;justify-content:center;position:absolute;top:calc(12px + env(safe-area-inset-top));right:8px;
      width:40px;height:40px;padding:0;background:none;border:none;color:#686b74;font-size:19px;line-height:1;cursor:pointer;}
    /* Burger and event picker share row one — flex-basis 0 keeps the picker
       from wrapping under the burger. headerActions is arbitrary per-page
       markup, so it takes a full row of its own instead of squeezing the event
       name; :not(:empty) spares that row on the pages that pass none. */
    /* With viewport-fit=cover the page reaches under the status bar, so the
       header keeps its content clear of the top and side insets itself. */
    .us-adminhead{padding:calc(10px + env(safe-area-inset-top)) max(14px,env(safe-area-inset-right)) 10px max(14px,env(safe-area-inset-left));gap:10px;flex-wrap:wrap;}
    .us-headmain{flex:1 1 0;}
    .us-headactions{flex-wrap:wrap;justify-content:flex-end;gap:8px;}
    .us-headactions:not(:empty){flex:1 0 100%;margin-left:0;}
    .us-eventpick{max-width:100%;}
    .us-eventmeta{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    /* Anchored to the right edge instead of the button: the button sits ~54px
       in (past the burger), which would push a 360px menu off screen. */
    .us-eventmenu{left:auto;right:0;width:min(360px,calc(100vw - 28px));}
  }
${SHARED_BASE_CSS}`;

export function initials(nameOrEmail: string): string {
  const s = (nameOrEmail || '').trim();
  if (!s) return '?';
  if (s.includes('@') && !s.includes(' ')) return s.slice(0, 2).toUpperCase();
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Avatar hues run the blue → magenta → red arc only. The cyan-to-yellow band
 * is too light at these lightnesses to carry white initials, so it is left out
 * of the range rather than special-cased.
 */
const HUE_FROM = 205;
const HUE_SPAN = 170;

/**
 * A person's own two-tone avatar fill — one initial picks each stop's hue, so
 * the same person is always the same colour and two people collide only when
 * both their initials match.
 */
export function initialsGradient(nameOrEmail: string): string {
  const [a, b] = initials(nameOrEmail).padEnd(2, '?');
  // ×63 is coprime with the span, so it permutes rather than folds: every
  // letter lands on its own hue, and neighbours are nowhere near each other.
  const hue = (ch: string) => HUE_FROM + ((ch.charCodeAt(0) * 63) % HUE_SPAN);
  return `linear-gradient(135deg,hsl(${hue(a)} 52% 44%),hsl(${hue(b)} 52% 32%))`;
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
        style="position:fixed;bottom:24px;left:50%;transform:translateX(-50%);max-width:calc(100vw - 32px);background:#16171d;color:#fff;padding:11px 18px;font-size:13px;z-index:80;animation:toastin 0.15s ease;display:flex;gap:10px;align-items:center;box-shadow:0 8px 24px rgba(22,23,29,0.3);"
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
    <summary class="us-sandbox-chip" style="list-style:none;display:flex;align-items:center;gap:9px;background:#16171d;color:#fff;padding:9px 14px;font-size:12.5px;cursor:pointer;user-select:none;box-shadow:0 8px 24px rgba(22,23,29,0.35);">
      <span style={`flex:none;font-family:${MONO};font-size:9.5px;letter-spacing:0.12em;font-weight:600;color:#ffd43b;`}>SANDBOX</span>
      <span class="us-sandbox-who">
        Viewing as <b id="sandbox-persona-label">{sandbox.personaLabel}</b>
      </span>
      <span style="flex:none;color:#9a9da6;font-size:10px;">▾</span>
    </summary>
    <div class="us-sandbox-menu" style="position:absolute;bottom:calc(100% + 8px);right:0;background:#fff;border:1px solid #e2e3e8;box-shadow:0 8px 24px rgba(22,23,29,0.16);">
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

export type AdminLayoutProps = PropsWithChildren<{
  title: string;
  user: User | null;
  event: Event | null;
  events?: Event[];
  path: string;
  headerTitle?: string;
  headerActions?: unknown;
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
  const host = (props.origin || 'https://unsession.dev').replace(/^https?:\/\//, '');
  const isActive = (p: string) => path === p || (p !== '/app' && path.startsWith(p + '/'));

  return (
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>{`Unsession — ${title}`}</title>
        {/* palette.js scopes its prefetched recent-submissions cache to this event */}
        <meta name="us-event-id" content={event?.id ?? ''} />
        <Favicons />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href={GOOGLE_FONTS} rel="stylesheet" />
        <style>{raw(ADMIN_BASE_CSS)}</style>
        {/* Hovering an admin link prerenders it (Chromium; others ignore the
            tag). Safe because every GET under /app is read-only — mutations
            are POSTs. /auth and public surfaces stay excluded: GET
            /auth/signout has side effects. */}
        <script type="speculationrules">
          {raw(
            JSON.stringify({
              prerender: [
                { where: { or: [{ href_matches: '/app' }, { href_matches: '/app/*' }] }, eagerness: 'moderate' },
              ],
            })
          )}
        </script>
      </head>
      <body>
        {/* Below MOBILE_MAX the sidebar becomes an overlay drawer: ui.js flips
            [data-nav-open] here, the CSS slides `.us-sidenav` in over `.us-navscrim`,
            and the header's burger is the only way in. See SPECS/M-mobile.md. */}
        <div class="us-shell" data-nav-shell>
          <div class="us-navscrim" data-nav-close aria-hidden="true"></div>
          {/* Three fixed-height zones: logo header and user footer never scroll;
              only the link list between them does. */}
          <nav id="us-sidenav" class="us-sidenav" data-nav-panel>
            <a
              href="/app"
              aria-label="Unsession dashboard"
              style="flex-shrink:0;padding:20px 20px 18px;display:block;text-decoration:none;"
            >
              <ProductLogo height={22} />
            </a>
            {/* Absolute, so it costs the desktop sidebar no layout at all. */}
            <button type="button" class="us-navclose" data-nav-close aria-label="Close menu">
              ✕
            </button>
            <div style="flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:2px;padding-bottom:14px;">
            {navLink('/app', 'Dashboard', path === '/app')}
            <div style={`padding:6px 20px 4px;font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;`}>
              EVENT
            </div>
            {navLink('/app/setup', 'Setup & Theming', isActive('/app/setup'))}
            {navLink('/app/forms', 'Forms', isActive('/app/forms'))}
            {navLink('/app/emails', 'Emails', isActive('/app/emails'))}
            <div style={SECTION_LABEL}>PROGRAM</div>
            {navLink('/app/submissions', 'Submissions', isActive('/app/submissions'))}
            {navLink('/app/evaluation', 'Evaluation', isActive('/app/evaluation'))}
            {navLink('/app/sessions', 'Sessions', isActive('/app/sessions'))}
            {navLink('/app/speakers', 'Speakers & Tasks', isActive('/app/speakers'))}
            {navLink('/app/files', 'Files', isActive('/app/files'))}
            {navLink('/app/agenda', 'Agenda', isActive('/app/agenda'))}
            {navLink('/app/embeds', 'Embeds', isActive('/app/embeds'))}
            {/* Public-page links live on the Dashboard's PUBLIC PAGES card,
                not here — an event with many forms made this section balloon. */}
            <div style={SECTION_LABEL}>ORGANIZATION</div>
            {navLink('/app/org/contacts', 'Speaker Directory', isActive('/app/org/contacts'))}
            {navLink('/app/org/pipeline', 'Pipeline', isActive('/app/org/pipeline'))}
            {navLink('/app/team', 'Team', isActive('/app/team'))}
            {/* Sandbox orgs can't mint API tokens — hide the page entirely. */}
            {props.sandbox ? null : navLink('/app/api', 'API', isActive('/app/api'))}
            </div>
            <div style="flex-shrink:0;padding:14px 20px calc(16px + env(safe-area-inset-bottom));border-top:1px solid #eceded;">
              <div style="display:flex;align-items:center;gap:9px;">
                <div style={`width:28px;height:28px;border-radius:50%;background:#4c5fd5;color:#fff;display:grid;place-items:center;font-family:${MONO};font-size:10.5px;font-weight:600;`}>
                  {initials(user?.name || user?.email || '')}
                </div>
                <div style="min-width:0;">
                  <div style="font-size:12.5px;font-weight:600;">{user?.name || user?.email || 'Signed out'}</div>
                  <a href="/auth/signout" class="us-signout" style="font-size:11px;color:#9a9da6;text-decoration:none;">
                    Sign out
                  </a>
                </div>
              </div>
            </div>
          </nav>
          <main style="min-width:0;">
            <header class="us-adminhead">
              <button
                type="button"
                class="us-burger"
                data-nav-toggle
                aria-controls="us-sidenav"
                aria-expanded="false"
                aria-label="Open menu"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                  <path d="M3 6h18" />
                  <path d="M3 12h18" />
                  <path d="M3 18h18" />
                </svg>
              </button>
              <div class="us-headmain">
                {props.headerTitle ? (
                  <div style="font-weight:700;font-size:16px;letter-spacing:-0.01em;">{props.headerTitle}</div>
                ) : (
                  <>
                    <button
                      type="button"
                      data-toggle="#event-picker"
                      title="Switch event"
                      class="us-eventpick"
                      style="display:flex;align-items:center;gap:10px;background:#f4f5f9;border:1px solid #d8d9de;padding:6px 10px;cursor:pointer;"
                    >
                      <span style="font-weight:700;font-size:16px;letter-spacing:-0.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                        {event?.name ?? 'No event yet'}
                      </span>
                      <span style="color:#686b74;font-size:11px;border-left:1px solid #d8d9de;padding-left:10px;">▾</span>
                    </button>
                    <div class="us-eventmeta" style={`font-family:${MONO};font-size:11px;color:#9a9da6;margin-top:5px;`}>
                      {event
                        ? `${host}/${event.slug} · ${fmtDateRange(event.start_date, event.end_date)} · ${event.timezone}`
                        : 'Create your first event to get started'}
                    </div>
                    <div
                      id="event-picker"
                      hidden
                      class="us-eventmenu"
                      style="position:absolute;top:calc(100% + 8px);background:#fff;border:1px solid #e2e3e8;box-shadow:0 8px 24px rgba(22,23,29,0.12);z-index:50;"
                    >
                      {/* margin:0 — the UA sheet's form margin-block-end would gap each row */}
                      {events.map((e) => (
                        <form method="post" action="/app/switch-event" style="margin:0;">
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
              <div class="us-headactions">{props.headerActions as never}</div>
            </header>
            {children}
          </main>
        </div>
        <Toast message={props.toast} />
        {props.sandbox ? <SandboxSwitcher sandbox={props.sandbox} /> : null}
        <script type="module" src="/js/ui.js"></script>
        {/* ⌘K / ⌘L command palette — keyboard-only, no visible trigger. */}
        <script type="module" src="/js/palette.js"></script>
        {(props.scripts ?? []).map((s) => (
          <script type="module" src={s}></script>
        ))}
      </body>
    </html>
  );
};

/* ------------------------------------------------------------------ public */

/**
 * The one content width shared by every attendee-facing page that carries the
 * nav row (agenda, sessions, speakers, gallery, itinerary). The header takes
 * its width from PublicLayout's `maxWidth`, so pages that disagree make the
 * nav jump sideways on every click — always pass this on nav pages.
 */
export const PUBLIC_PAGE_MAX = 960;

/**
 * The attendee-facing nav row (Agenda / Sessions / Speakers / Gallery /
 * Itinerary). Pass the current page's key so it renders bold; content pages
 * (forms, portal) simply don't pass `nav` and keep their chrome unchanged.
 */
export function publicNav(slug: string, active: string): { label: string; href: string; active: boolean }[] {
  return [
    ['Agenda', 'agenda'],
    ['Sessions', 'sessions'],
    ['Speakers', 'speakers'],
    ['Gallery', 'gallery'],
    ['Itinerary', 'itinerary'],
  ].map(([label, key]) => ({ label, href: `/${slug}/${key}`, active: key === active }));
}

export type PublicLayoutProps = PropsWithChildren<{
  title: string;
  /** Share/meta description — falls back to "title · event name" when omitted. */
  description?: string;
  event: { name: string; slug: string };
  theme: Theme;
  toast?: string | null;
  scripts?: string[];
  maxWidth?: number;
  kicker?: string;
  /** Attendee nav links (from `publicNav`) — omitted on forms/portal pages. */
  nav?: { label: string; href: string; active: boolean }[];
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
  /* File inputs stay focusable inside their styled labels: visually hidden
     (not display:none, which drops them from the accessibility tree) so
     keyboard and screen-reader users can reach and activate the picker. */
  .vh-file{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;clip:rect(0 0 0 0);overflow:hidden;white-space:nowrap;}
  .file-btn{position:relative;}
  .file-btn:focus-within{outline:2px solid var(--primary);outline-offset:2px;}
  @keyframes toastin{from{transform:translateY(12px);opacity:0}to{transform:none;opacity:1}}
  @keyframes slidein{from{transform:translateX(24px);opacity:0}to{transform:none;opacity:1}}
  @keyframes us-spin{to{transform:rotate(360deg)}}
  /* Sticky event header. Box and spacing live here so the mobile block can
     tighten them — an inline style would outrank the media query. */
  .us-pubhead{padding:12px 20px;display:flex;align-items:center;gap:10px;}
  .us-pubmark{flex:none;}
  .us-pubname{font-weight:700;font-size:14.5px;}
  .us-pubnav{margin-left:18px;display:flex;gap:2px;overflow-x:auto;}
  .us-pubkicker{margin-left:auto;font-family:var(--font-mono);font-size:10.5px;color:var(--muted);}
  @media (max-width:${MOBILE_MAX}px){
    .us-pubhead{padding:10px 14px;gap:8px;}
    /* The event name ellipsizes; the nav takes what is left and scrolls
       sideways inside itself (flex-basis 0 keeps it from pushing the name out). */
    .us-pubname{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .us-pubnav{margin-left:4px;flex:1 1 0;min-width:110px;}
    .us-pubkicker{max-width:45vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    /* Name + nav + kicker is one row too many at 320px. Nav pages keep the nav. */
    .us-pubhead-nav .us-pubkicker{display:none;}
  }
${SHARED_BASE_CSS}`;
  return (
    <html style={vars}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Content-focused share tags: the event is the subject, so it is the
            og:site_name and the brand card is left off — a shared CFP or
            agenda link unfurls as the event's page, not as Unsession's. */}
        <SocialMeta
          title={`${props.event.name} — ${props.title}`}
          description={props.description ?? `${props.title} · ${props.event.name}`}
          siteName={props.event.name}
          image={null}
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href={fontsHref} rel="stylesheet" />
        <style>{raw(css)}</style>
      </head>
      <body>
        <div style="position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--border);z-index:10;">
          <div
            class={props.nav ? 'us-pubhead us-pubhead-nav' : 'us-pubhead'}
            style={`max-width:${max}px;margin:0 auto;`}
          >
            <div class="us-pubmark" style="width:26px;height:26px;background:var(--primary);color:var(--on-primary);display:grid;place-items:center;font-family:var(--font-mono);font-size:12px;font-weight:700;">
              {initialsOf(props.event.name)}
            </div>
            <div class="us-pubname">{props.event.name}</div>
            {props.nav ? (
              <nav class="us-pubnav">
                {props.nav.map((n) => (
                  <a
                    href={n.href}
                    style={`padding:6px 10px;font-size:13px;white-space:nowrap;text-decoration:none;${
                      n.active ? 'color:var(--primary);font-weight:700;background:var(--chip);' : 'color:var(--text-secondary);'
                    }`}
                  >
                    {n.label}
                  </a>
                ))}
              </nav>
            ) : null}
            {props.kicker ? <div class="us-pubkicker">{props.kicker}</div> : null}
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

/**
 * The corner-arrows full-screen toggle every drawer header carries, sitting
 * left of the close button. ui.js flips `data-expanded` on the enclosing
 * `[data-drawer]`; ADMIN_BASE_CSS widens the panel and swaps which icon shows.
 * Drawers rendered client-side use `expandButton()` from ui.js — same markup.
 */
export const DrawerExpandButton: FC = () => (
  <button type="button" class="us-icon-btn" data-drawer-expand aria-label="Expand to full screen" title="Expand to full screen">
    <svg class="ic-max" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M16 3h3a2 2 0 0 1 2 2v3" />
      <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
    <svg class="ic-min" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M8 3v3a2 2 0 0 1-2 2H3" />
      <path d="M16 3v3a2 2 0 0 0 2 2h3" />
      <path d="M8 21v-3a2 2 0 0 0-2-2H3" />
      <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
    </svg>
  </button>
);

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
  // submission statuses (migration 0011 retired `submitted` and `confirmed`)
  draft: { label: 'Draft', fg: '#686b74', bg: '#f1f3f5' },
  in_review: { label: 'In Review', fg: '#b08800', bg: '#fdf5dc' },
  // Display-only split of `in_review`: no evaluation plan covers the row yet.
  // Never stored — see CHIP_ORDER in routes/admin-submissions.tsx.
  needs_assigned: { label: 'Needs Assigned', fg: '#1c7ed6', bg: '#e7f1fb' },
  // Display-only: a decision sits in the outbox, not yet sent. Never stored —
  // see CHIP_ORDER. (`queued` below is the email log's word, hence `outbox`.)
  outbox: { label: 'Queued', fg: '#8a6d1a', bg: '#fbf4e2' },
  accepted: { label: 'Accepted', fg: '#2b8a3e', bg: '#e6f4ea' },
  declined: { label: 'Declined', fg: '#c92a2a', bg: '#fbe9e9' },
  waitlisted: { label: 'Waitlisted', fg: '#9c36b5', bg: '#f6e8f9' },
  withdrawn: { label: 'Withdrawn', fg: '#868e96', bg: '#f1f3f5' },
  // session statuses — `confirmed` is the speaker confirmation, and it lives here
  confirmed: { label: 'Confirmed', fg: '#087f5b', bg: '#dcf2eb' },
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
