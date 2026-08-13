/**
 * `/app/org/pipeline` island — drag a card between stage columns, or up and
 * down inside one to keep each stage hand-ordered.
 *
 * HTML5 drag events, same shape as `agenda-builder.js`: while dragging, the
 * card slides into its would-be slot under the pointer, and the drop POSTs the
 * stage plus position to `/app/api/org/pipeline/move`. A rejected move puts
 * the card back where it was and toasts the server's sentence; a cancelled
 * drag walks it back locally.
 *
 * The board itself is server-rendered. Without JavaScript, cards still link to
 * their page and the stage changes from the `Move to` form there.
 */
import { toast, api } from './ui.js';

const board = document.getElementById('pipeline-board');
if (board) boot(board);

function boot(board) {
  const HILITE = 'background:#eef0fb;outline:1px dashed #4c5fd5;outline-offset:-1px;';
  let dragged = null; // { el, parent, next, index, dropped } — enough to undo

  const zones = () => board.querySelectorAll('[data-drop]');
  const cardsIn = (zone) => [...zone.querySelectorAll('[data-card-id]')];

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

  const midY = (el) => {
    const r = el.getBoundingClientRect();
    return r.top + r.height / 2;
  };

  /** Slide the dragged card into the slot under the pointer. */
  function placeAt(zone, el, y) {
    const next = cardsIn(zone).find((k) => k !== el && y < midY(k));
    zone.insertBefore(el, next ?? zone.querySelector('[data-empty]'));
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
    dragged = {
      el: card,
      parent: card.parentElement,
      next: card.nextElementSibling,
      index: cardsIn(card.parentElement).indexOf(card),
      dropped: false,
    };
    try {
      e.dataTransfer.setData('text', card.dataset.cardId);
      e.dataTransfer.effectAllowed = 'move';
    } catch {
      /* older browsers */
    }
  });

  board.addEventListener('dragend', () => {
    // A cancelled drag (Esc, released outside a column) leaves the card
    // wherever the preview last put it — walk it back.
    if (dragged && !dragged.dropped) {
      dragged.parent.insertBefore(dragged.el, dragged.next);
      refresh();
    }
    clearHighlights();
    dragged = null;
  });

  board.addEventListener('dragover', (e) => {
    const zone = e.target.closest('[data-drop]');
    if (!zone || !dragged) return;
    e.preventDefault();
    placeAt(zone, dragged.el, e.clientY);
    refresh();
    zones().forEach((z) => highlight(z, z === zone));
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
    move.dropped = true;
    dragged = null;

    placeAt(zone, move.el, e.clientY);
    refresh();

    const index = cardsIn(zone).indexOf(move.el);
    if (zone === move.parent && index === move.index) return;

    try {
      await api('/app/api/org/pipeline/move', { id: move.el.dataset.cardId, stage: zone.dataset.drop, index });
    } catch (err) {
      move.parent.insertBefore(move.el, move.next);
      refresh();
      toast(err.message, false);
    }
  });
}
