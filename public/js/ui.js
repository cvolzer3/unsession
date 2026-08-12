/**
 * Shared island helpers. Loaded on every page as `<script type="module" src="/js/ui.js">`.
 * Vanilla, no build step (DECISIONS D10).
 *
 *   toast('Saved')                       dark prototype toast, auto-hides
 *   api('/app/api/x', { a: 1 })          JSON POST → parsed body, throws on !ok
 *   data-toggle="#id"                    click toggles [hidden] on the target, closes on outside click
 *   data-dialog-open="#id"               opens a dialog overlay
 *   data-dialog-close                    closes the nearest dialog overlay
 *   data-drawer-expand                   toggles [data-expanded] on the nearest [data-drawer]
 */

export function toast(msg, ok = true) {
  const prev = document.getElementById('us-toast');
  if (prev) prev.remove();
  const el = document.createElement('div');
  el.id = 'us-toast';
  el.style.cssText =
    'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#16171d;color:#fff;padding:11px 18px;font-size:13px;z-index:80;animation:toastin 0.15s ease;display:flex;gap:10px;align-items:center;box-shadow:0 8px 24px rgba(22,23,29,0.3);';
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

window.us = { toast, api, openDialog, closeDialog, copy };
