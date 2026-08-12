/**
 * /app/files island — submit the drawer's reply form via fetch and append the
 * comment in place. Without this the POST → redirect → re-render cycle
 * remounts the drawer and re-runs its slide-in animation on every reply.
 * The form still works as a plain POST with JavaScript off.
 */
import { toast } from './ui.js';

const MONO = "'IBM Plex Mono',monospace";

const form = document.querySelector('[data-comment-form]');
if (form) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = form.querySelector('input[name="body"]');
    const button = form.querySelector('button[type="submit"]');
    const body = (input.value || '').trim();
    if (!body) return;
    button.disabled = true;
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: new URLSearchParams(new FormData(form)),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Could not add the comment');

      const empty = document.querySelector('[data-comment-empty]');
      if (empty) empty.remove();

      // Same markup the server renders for an organizer comment.
      const row = document.createElement('div');
      row.style.cssText = 'padding:9px 12px;border-bottom:1px solid #f2f3f5;';
      const head = document.createElement('div');
      head.style.cssText = `font-family:${MONO};font-size:10px;color:#4c5fd5;margin-bottom:2px;`;
      head.textContent = `${data.comment.author_name.toUpperCase()} · ORGANIZER · ${data.comment.when}`;
      const text = document.createElement('div');
      text.style.cssText = 'font-size:12.5px;line-height:1.5;';
      text.textContent = data.comment.body;
      row.append(head, text);
      form.parentElement.insertBefore(row, form);

      const count = document.querySelector('[data-comment-count]');
      if (count) {
        const n = Number(count.dataset.commentCount || '0') + 1;
        count.dataset.commentCount = String(n);
        count.textContent = `COMMENTS · ${n}`;
      }

      input.value = '';
      toast(data.message || 'Comment added');
    } catch (err) {
      toast(err.message, false);
    } finally {
      button.disabled = false;
    }
  });
}
