/**
 * `/app/org/pipeline` island — drag a card between stage columns.
 *
 * HTML5 drag events, same shape as `agenda-builder.js`: the drop moves the card
 * optimistically, then `/app/api/org/pipeline/move` confirms it. A rejected move
 * puts the card back where it was and toasts the server's sentence.
 *
 * The board itself is server-rendered. Without JavaScript, cards still link to
 * their page and the stage changes from the `Move to` form there.
 */
import { toast, api } from './ui.js';

const board = document.getElementById('pipeline-board');
if (board) boot(board);

function boot(board) {
  const HILITE = 'background:#eef0fb;outline:1px dashed #4c5fd5;outline-offset:-1px;';
  let dragged = null; // { el, parent, next } — enough to undo a failed move

  const zones = () => board.querySelectorAll('[data-drop]');

  function highlight(zone, on) {
    zone.style.cssText = zone.dataset.base + (on ? HILITE : '');
  }

  function clearHighlights() {
    zones().forEach((z) => highlight(z, false));
  }

  /** Column counts and the "Drop here" placeholder follow the cards. */
  function refresh() {
    zones().forEach((z) => {
      const n = z.querySelectorAll('[data-card-id]').length;
      const count = board.querySelector(`[data-count="${z.dataset.drop}"]`);
      if (count) count.textContent = String(n);
      const empty = z.querySelector('[data-empty]');
      if (empty) empty.hidden = n > 0;
    });
  }

  // Keep each zone's server-rendered style so highlighting can be undone.
  zones().forEach((z) => {
    z.dataset.base = z.getAttribute('style') || '';
  });

  // A click anywhere on the card that is not a link opens the card page.
  board.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const card = e.target.closest('[data-card-id]');
    if (card) location.href = card.dataset.href;
  });

  board.addEventListener('dragstart', (e) => {
    const card = e.target.closest('[data-card-id]');
    if (!card) return;
    dragged = { el: card, parent: card.parentElement, next: card.nextElementSibling };
    try {
      e.dataTransfer.setData('text', card.dataset.cardId);
      e.dataTransfer.effectAllowed = 'move';
    } catch {
      /* older browsers */
    }
  });

  board.addEventListener('dragend', () => {
    clearHighlights();
    dragged = null;
  });

  board.addEventListener('dragover', (e) => {
    const zone = e.target.closest('[data-drop]');
    if (!zone || !dragged) return;
    e.preventDefault();
    highlight(zone, true);
  });

  board.addEventListener('dragleave', (e) => {
    const zone = e.target.closest('[data-drop]');
    if (!zone) return;
    if (e.relatedTarget && zone.contains(e.relatedTarget)) return;
    highlight(zone, false);
  });

  board.addEventListener('drop', async (e) => {
    const zone = e.target.closest('[data-drop]');
    if (!zone || !dragged) return;
    e.preventDefault();
    clearHighlights();

    const move = dragged;
    dragged = null;
    if (move.parent === zone) return;

    const empty = zone.querySelector('[data-empty]');
    if (empty) zone.insertBefore(move.el, empty);
    else zone.appendChild(move.el);
    refresh();

    try {
      await api('/app/api/org/pipeline/move', { id: move.el.dataset.cardId, stage: zone.dataset.drop });
    } catch (err) {
      move.parent.insertBefore(move.el, move.next);
      refresh();
      toast(err.message, false);
    }
  });
}
