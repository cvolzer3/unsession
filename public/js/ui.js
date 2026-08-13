/**
 * Shared island helpers. Loaded on every page as `<script type="module" src="/js/ui.js">`.
 * Vanilla, no build step (DECISIONS D10).
 *
 *   toast('Saved')                       dark prototype toast, auto-hides
 *   api('/app/api/x', { a: 1 })          JSON POST → parsed body, throws on !ok
 *   busy(btn, 'Saving…') / done(btn)     spinner + label while an api() call runs
 *   data-busy="Sending…"                 submit buttons get the busy state on plain form POSTs
 *   data-toggle="#id"                    click toggles [hidden] on the target, closes on outside click
 *   data-dialog-open="#id"               opens a dialog overlay
 *   data-dialog-close                    closes the nearest dialog overlay
 *   data-drawer-expand                   toggles [data-expanded] on the nearest [data-drawer]
 *   expandButton(expanded)               that button's markup, for JS-rendered drawers
 *   data-confirm="Sure?"                 destructive submits ask before posting
 *   data-nav-toggle / data-nav-close     admin sidebar as a mobile overlay drawer
 */

export function toast(msg, ok = true) {
  const prev = document.getElementById('us-toast');
  if (prev) prev.remove();
  const el = document.createElement('div');
  el.id = 'us-toast';
  el.style.cssText =
    'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);max-width:calc(100vw - 32px);background:#16171d;color:#fff;padding:11px 18px;font-size:13px;z-index:80;animation:toastin 0.15s ease;display:flex;gap:10px;align-items:center;box-shadow:0 8px 24px rgba(22,23,29,0.3);';
  const mark = document.createElement('span');
  mark.style.color = ok ? '#69db7c' : '#ff8787';
  mark.textContent = ok ? '✓' : '✕';
  el.appendChild(mark);
  el.appendChild(document.createTextNode(msg));
  document.body.appendChild(el);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.remove(), 3000);
}

export async function api(url, body, method = 'POST') {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || (data && data.ok === false)) {
    const message = (data && (data.error || data.message)) || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

/**
 * Progress state for an action button while its request runs: swaps the label
 * for a spinner + present-progressive verb ('Saving…'), blocks re-clicks, and
 * keeps the button's width so the row doesn't shift. `done(btn)` restores it.
 *
 * Islands wrap their api() calls by hand:
 *
 *   busy(btn, 'Saving…');
 *   try { await api(…); } catch (err) { toast(err.message, false); done(btn); }
 *
 * Plain form POSTs are declarative — `<button type="submit" data-busy="Sending…">`
 * gets the same treatment from the submit listener below, and the navigation
 * replaces the page so nothing needs restoring. A bare `data-busy` keeps the
 * button's own label under the spinner.
 */
export function busy(btn, label) {
  if (!btn || btn.dataset.busyPrev != null) return;
  const text = label ?? btn.getAttribute('data-busy') ?? '';
  btn.dataset.busyPrev = btn.getAttribute('style') || '';
  btn.dataset.busyHtml = btn.innerHTML;
  btn.dataset.busyDisabled = btn.disabled ? '1' : '';
  const width = btn.offsetWidth;
  btn.textContent = text || btn.textContent.trim();
  const spin = document.createElement('span');
  spin.setAttribute('aria-hidden', 'true');
  spin.style.cssText =
    'width:12px;height:12px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;flex:none;animation:us-spin 0.6s linear infinite;';
  btn.prepend(spin);
  // The saved style attribute is restored verbatim by done(), so appending here
  // never loses the button's own inline styles.
  btn.style.cssText +=
    `;display:inline-flex;align-items:center;justify-content:center;gap:8px;pointer-events:none;` +
    (width ? `min-width:${Math.ceil(width)}px;` : '');
  btn.setAttribute('aria-disabled', 'true');
  // Disable after the tick: a submit button disabled during the submit event
  // would drop its own name/value from the POST body (see /oauth deny).
  setTimeout(() => {
    if (btn.dataset.busyPrev != null) btn.disabled = true;
  }, 0);
}

export function done(btn) {
  if (!btn || btn.dataset.busyPrev == null) return;
  btn.innerHTML = btn.dataset.busyHtml;
  if (btn.dataset.busyPrev) btn.setAttribute('style', btn.dataset.busyPrev);
  else btn.removeAttribute('style');
  btn.disabled = !!btn.dataset.busyDisabled;
  btn.removeAttribute('aria-disabled');
  delete btn.dataset.busyPrev;
  delete btn.dataset.busyHtml;
  delete btn.dataset.busyDisabled;
}

// Submit buttons marked data-busy show progress on plain form POSTs. Runs on
// document so island handlers (validation, previews) get to preventDefault first.
document.addEventListener('submit', (e) => {
  if (e.defaultPrevented) return;
  // When the browser names a submitter, trust it alone — falling back would
  // spin a sibling button (forms with several named submit buttons).
  const btn = e.submitter ?? e.target.querySelector('button[type="submit"][data-busy]');
  if (btn && btn.hasAttribute('data-busy')) busy(btn);
});

// A bfcache restore (back button) would otherwise revive the page with the
// button still spinning, or the mobile nav drawer still open over it.
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  document.querySelectorAll('[data-busy-prev]').forEach((btn) => done(btn));
  setNav(false);
});

/**
 * Drawer header full-screen toggle for drawers rendered from JS — the twin of
 * `DrawerExpandButton` in views/layout.tsx. Pass whether the drawer is already
 * expanded: the icons follow [data-expanded] in CSS, but the accessible name
 * has to be re-stated when the header is re-rendered under an open drawer.
 */
export function expandButton(expanded = false) {
  const arrow = (cls, paths) =>
    `<svg class="${cls}" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  return (
    `<button type="button" class="us-icon-btn" data-drawer-expand title="Expand to full screen"` +
    ` aria-label="${expanded ? 'Exit full screen' : 'Expand to full screen'}">` +
    arrow(
      'ic-max',
      '<path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M16 3h3a2 2 0 0 1 2 2v3" />' +
        '<path d="M8 21H5a2 2 0 0 1-2-2v-3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" />'
    ) +
    arrow(
      'ic-min',
      '<path d="M8 3v3a2 2 0 0 1-2 2H3" /><path d="M16 3v3a2 2 0 0 0 2 2h3" />' +
        '<path d="M8 21v-3a2 2 0 0 0-2-2H3" /><path d="M16 21v-3a2 2 0 0 1 2-2h3" />'
    ) +
    `</button>`
  );
}

export function openDialog(sel) {
  const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
  if (!el) return;
  el.hidden = false;
  const focusable = el.querySelector('input,textarea,select');
  if (focusable) setTimeout(() => focusable.focus(), 0);
}

export function closeDialog(sel) {
  const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
  if (el) el.hidden = true;
}

// Destructive submits ask before posting. Registered ahead of the delegates
// below so a declined confirm stops the click before anything else acts on it.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-confirm]');
  if (btn && !window.confirm(btn.dataset.confirm)) e.preventDefault();
});

/* ------------------------------------------------- admin sidebar on mobile
 * Below the CSS breakpoint (MOBILE_MAX in views/layout.tsx) the admin sidebar
 * is an overlay drawer. All of its look lives in ADMIN_BASE_CSS; the only state
 * is [data-nav-open] on the shell, so desktop needs no JS at all.
 *
 * Deliberately NOT `data-toggle`: that mechanism closes on any outside click,
 * which would fight the scrim, and it flips [hidden] — the sidebar has to stay
 * in the layout on desktop.
 */
const navShell = () => document.querySelector('[data-nav-shell]');

function setNav(open) {
  const shell = navShell();
  if (!shell) return;
  if (open) shell.setAttribute('data-nav-open', '');
  else shell.removeAttribute('data-nav-open');
  const btn = document.querySelector('[data-nav-toggle]');
  if (btn) {
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }
  // The drawer scrolls internally; the page behind it must not.
  document.body.style.overflow = open ? 'hidden' : '';
  if (open) {
    const first = shell.querySelector('[data-nav-panel] a[href],[data-nav-panel] button');
    // The drawer is visibility:hidden until the attribute above takes effect,
    // and focus() on a hidden element is a no-op — read a layout property first
    // to flush the style change.
    if (first) {
      void shell.offsetWidth;
      first.focus();
    }
  }
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-nav-toggle]')) {
    e.preventDefault();
    const shell = navShell();
    setNav(!(shell && shell.hasAttribute('data-nav-open')));
    return;
  }
  if (e.target.closest('[data-nav-close]')) {
    e.preventDefault();
    setNav(false);
    return;
  }
  // Tapping a nav link navigates away, but close anyway: an in-page anchor or
  // a same-URL link would otherwise leave the drawer sitting open.
  if (e.target.closest('[data-nav-panel] a')) setNav(false);
});

document.addEventListener('keydown', (e) => {
  const shell = document.querySelector('[data-nav-shell][data-nav-open]');
  if (!shell) return;
  if (e.key === 'Escape') {
    setNav(false);
    const btn = document.querySelector('[data-nav-toggle]');
    if (btn) btn.focus();
    return;
  }
  if (e.key !== 'Tab') return;
  // Keep Tab inside the open drawer — the page behind it is inert to the eye,
  // so it should be inert to the keyboard too.
  const stops = shell.querySelectorAll('[data-nav-panel] a[href],[data-nav-panel] button:not([disabled])');
  if (!stops.length) return;
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

// Growing past the breakpoint puts the sidebar back in the grid — drop the
// open state so the body scroll lock goes with it.
// Mirror of MOBILE_MAX (768) in views/layout.tsx — keep the two in step.
window.matchMedia('(min-width:769px)').addEventListener('change', (e) => {
  if (e.matches) setNav(false);
});

function closeAllToggles(except) {
  document.querySelectorAll('[data-toggle-target]').forEach((el) => {
    if (el !== except) el.hidden = true;
  });
}

document.addEventListener('click', (e) => {
  const toggle = e.target.closest('[data-toggle]');
  if (toggle) {
    e.preventDefault();
    const target = document.querySelector(toggle.getAttribute('data-toggle'));
    if (target) {
      target.setAttribute('data-toggle-target', '');
      const willOpen = target.hidden;
      closeAllToggles(target);
      target.hidden = !willOpen;
    }
    return;
  }

  const opener = e.target.closest('[data-dialog-open]');
  if (opener) {
    e.preventDefault();
    openDialog(opener.getAttribute('data-dialog-open'));
    return;
  }

  // Full-screen toggle on a side drawer. The width lives in CSS so the
  // expanded state is a single attribute, not an inline-style edit.
  const expander = e.target.closest('[data-drawer-expand]');
  if (expander) {
    e.preventDefault();
    const drawer = expander.closest('[data-drawer]');
    if (drawer) {
      const expanded = drawer.hasAttribute('data-expanded');
      if (expanded) drawer.removeAttribute('data-expanded');
      else drawer.setAttribute('data-expanded', '');
      expander.setAttribute('aria-label', expanded ? 'Expand to full screen' : 'Exit full screen');
    }
    return;
  }

  const closer = e.target.closest('[data-dialog-close]');
  if (closer) {
    e.preventDefault();
    const explicit = closer.getAttribute('data-dialog-close');
    if (explicit) closeDialog(explicit);
    else closeDialog(closer.closest('[data-dialog]'));
    return;
  }

  // Click on the dim backdrop itself closes the dialog.
  if (e.target.matches('[data-dialog]')) {
    e.target.hidden = true;
    return;
  }

  if (!e.target.closest('[data-toggle-target]')) closeAllToggles(null);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  document.querySelectorAll('[data-dialog]').forEach((d) => {
    d.hidden = true;
  });
  closeAllToggles(null);
});

/** Copy helper used by share-link buttons. */
export async function copy(text, message = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast('Copy failed — select the link manually', false);
  }
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  e.preventDefault();
  copy(btn.getAttribute('data-copy'), btn.getAttribute('data-copy-msg') || 'Copied');
});

window.us = { toast, api, openDialog, closeDialog, copy, busy, done };
