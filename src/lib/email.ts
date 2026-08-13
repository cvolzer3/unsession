/**
 * Email abstraction (DECISIONS D6).
 *
 * Every send writes an `emails` row first, so the log is the source of truth.
 * When `env.EMAIL` is bound AND `EMAIL_ENABLED === '1'` we send through the
 * Cloudflare Email Service binding and flip the row to sent/failed. Otherwise
 * the row stays `simulated` and callers surface the link in the UI.
 */
import { newId } from './ids';
import { now, one, run } from './db';
import type { Bindings, Theme } from '../types';
import { DEFAULT_THEME, derive, parseTheme } from './theme';
import { looksRich, richToText, sanitizeRich } from './rich';

export type SendEmailInput = {
  eventId?: string | null;
  /** Org-level sends (Speaker CRM outreach) carry this and leave eventId null. */
  orgId?: string | null;
  to: string;
  toName?: string | null;
  templateKey?: string | null;
  subject: string;
  text: string;
  subjectType?: string | null;
  subjectId?: string | null;
};

export type SendEmailResult = {
  id: string;
  status: 'sent' | 'failed' | 'simulated';
  error?: string;
};

export const EMAIL_FROM_NAME = 'Unsession';

export function renderTemplate(str: string, vars: Record<string, string | number | null | undefined>): string {
  // In a rich-lite template the substituted values are text content, so
  // angle-bracket values (a title like "Faster <canvas> rendering") must be
  // entity-escaped or the sanitizer strips them. Subjects and plain-text
  // bodies never trip looksRich and keep raw values.
  const rich = looksRich(str || '');
  return (str || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key: string) => {
    const v = vars[key];
    if (v === undefined || v === null) return whole;
    const s = String(v);
    return rich ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : s;
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function linkify(s: string): string {
  return s.replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" style="color:inherit;">${u}</a>`);
}

/**
 * Linkify bare URLs in a rich-lite body's text nodes (skipping existing
 * anchors), so a substituted {{confirmation_link}} stays clickable after a
 * template is upgraded to rich-lite. Emits unstyled <a href> — styleRich
 * runs afterwards and applies the accent color.
 */
function linkifyRichHtml(html: string): string {
  return html
    .split(/(<a\b[^>]*>[\s\S]*?<\/a>|<[^>]+>)/g)
    .map((part) => {
      if (!part || part.startsWith('<')) return part;
      return part.replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}">${u}</a>`);
    })
    .join('');
}

/**
 * Inline styles for the rich-lite subset — email clients need inline CSS.
 * Only safe on `sanitizeRich` output, where the subset tags carry no
 * attributes except a[href] and text content is entity-escaped.
 */
function styleRich(html: string, accent: string): string {
  return html
    .replace(/<p>/g, '<p style="margin:0 0 14px;">')
    .replace(/<h2>/g, '<h2 style="font-size:18px;line-height:1.3;letter-spacing:-0.01em;margin:20px 0 10px;">')
    .replace(/<h3>/g, '<h3 style="font-size:15px;line-height:1.35;margin:16px 0 8px;">')
    .replace(/<ul>/g, '<ul style="margin:0 0 14px;padding-left:22px;">')
    .replace(/<ol>/g, '<ol style="margin:0 0 14px;padding-left:22px;">')
    .replace(/<li>/g, '<li style="margin:0 0 6px;">')
    .replace(/<a href=/g, `<a style="color:${accent};" href=`);
}

/** Minimal themed HTML shell: accent bar in the event primary, logo name, footer. */
export function wrapHtml(text: string, opts: { subject: string; theme?: Theme; eventName?: string }): string {
  const theme = opts.theme ?? DEFAULT_THEME;
  const d = derive(theme.primary);
  const body = looksRich(text)
    ? styleRich(linkifyRichHtml(sanitizeRich(text)), d.primary)
    : linkify(escapeHtml(text))
        .split(/\n{2,}/)
        .map((p) => `<p style="margin:0 0 14px;">${p.replace(/\n/g, '<br>')}</p>`)
        .join('');
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f6;">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e3e8;">
  <div style="height:4px;background:${d.primary};"></div>
  <div style="padding:22px 26px;">
    <div style="font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:10px;letter-spacing:0.14em;color:#9a9da6;text-transform:uppercase;margin-bottom:14px;">${escapeHtml(
      opts.eventName || EMAIL_FROM_NAME
    )}</div>
    <div style="font-family:-apple-system,'Space Grotesk',Segoe UI,sans-serif;font-size:14px;line-height:1.55;color:#16171d;">${body}</div>
  </div>
  <div style="padding:14px 26px;border-top:1px solid #eceded;font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:10.5px;color:#9a9da6;">Unsession</div>
</div>
</body></html>`;
}

export async function sendEmail(env: Bindings, input: SendEmailInput): Promise<SendEmailResult> {
  const id = newId('eml');
  const created = now();
  let enabled = env.EMAIL_ENABLED === '1' && !!env.EMAIL;

  // Sandbox events never send real mail: their seeded speakers/reviewers use
  // addresses on domains we don't own, and every sandbox flow already surfaces
  // links in the UI when the row is `simulated`.
  if (enabled) {
    if (input.to.toLowerCase().endsWith('@sandbox.unsession.dev')) {
      enabled = false;
    } else if (input.eventId) {
      const sb = await one<{ is_sandbox: number }>(
        env.DB,
        `SELECT o.is_sandbox FROM events e JOIN orgs o ON o.id = e.org_id WHERE e.id = ?`,
        input.eventId
      );
      if (sb?.is_sandbox) enabled = false;
    } else if (input.orgId) {
      // Org-level send: no event to look the org up through, so check it directly.
      const sb = await one<{ is_sandbox: number }>(env.DB, `SELECT is_sandbox FROM orgs WHERE id = ?`, input.orgId);
      if (sb?.is_sandbox) enabled = false;
    }
  }

  await run(
    env.DB,
    `INSERT INTO emails (id, event_id, org_id, to_email, to_name, template_key, subject, body, status, error, subject_type, subject_id, created_at, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
    id,
    input.eventId ?? null,
    input.orgId ?? null,
    input.to,
    input.toName ?? null,
    input.templateKey ?? null,
    input.subject,
    input.text,
    enabled ? 'queued' : 'simulated',
    input.subjectType ?? null,
    input.subjectId ?? null,
    created
  );

  if (!enabled) return { id, status: 'simulated' };

  let theme: Theme | undefined;
  let eventName: string | undefined;
  if (input.eventId) {
    const ev = await one<{ name: string; theme_json: string }>(
      env.DB,
      `SELECT name, theme_json FROM events WHERE id = ?`,
      input.eventId
    );
    if (ev) {
      theme = parseTheme(ev.theme_json);
      eventName = ev.name;
    }
  }

  // Rich-lite bodies (DECISIONS R3) render as sanitized HTML; the text/plain
  // part is derived. Plain bodies keep the byte-for-byte legacy path.
  // Email Service's send binding takes structured fields ({subject, html,
  // text}), not raw MIME — a raw message fails with "text or html must have
  // content in order for an email to be sent".
  const html = wrapHtml(input.text, { subject: input.subject, theme, eventName });

  try {
    await env.EMAIL!.send({
      to: input.to,
      from: { email: env.EMAIL_FROM, name: EMAIL_FROM_NAME },
      subject: input.subject,
      html,
      text: looksRich(input.text) ? richToText(input.text) : input.text,
    });
    await run(env.DB, `UPDATE emails SET status = 'sent', sent_at = ? WHERE id = ?`, now(), id);
    return { id, status: 'sent' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await run(env.DB, `UPDATE emails SET status = 'failed', error = ? WHERE id = ?`, message, id);
    return { id, status: 'failed', error: message };
  }
}
