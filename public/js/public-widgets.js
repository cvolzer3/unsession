/**
 * Public widgets island — shared by /{event}/sessions, /speakers, /gallery,
 * /itinerary and their /embed/* variants (the embed documents load this same
 * module; inside the iframe it runs against our origin, so localStorage keeps
 * working for the itinerary's personal schedule).
 *
 *   [data-w-search]    keyword filter over [data-w-card] / [data-i-card] via data-search
 *   [data-facet]       Format/Track/Location checkboxes (sessions page)
 *   [data-w-count]     "1–X of N" result count, updated on every filter
 *   [data-more]        Show more / Show less toggle for clamped text (hidden
 *                      when the text fits inside the clamp)
 *   [data-g-card]      gallery card → opens [data-g-detail=<id>] overlay
 *   [data-day-tab]     itinerary day switcher over [data-day-section]
 *   [data-star]        personal-schedule toggle, persisted in localStorage
 *   [data-mine-toggle] My schedule view (starred sessions across all days)
 *   [data-ics-link]    export link — carries ?ids= for the current selection
 *
 * Everything is server-rendered; with JS off the full lists stay readable.
 */
const root = document.querySelector('[data-widget]');
if (root) boot(root);

function boot(root) {
  const widget = root.dataset.widget;
  const slug = root.dataset.slug || '';
  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => [...root.querySelectorAll(sel)];

  const cardSel = widget === 'itinerary' ? '[data-i-card]' : '[data-w-card]';
  const searchEl = $('[data-w-search]');
  const countEl = $('[data-w-count]');
  const emptyEl = $('[data-w-empty]');
  const clearEl = $('[data-w-clear]');
  const total = $$(cardSel).filter((el) => !el.hasAttribute('data-service')).length;

  const state = { q: '', track: '', mine: false, day: firstDay() };

  function firstDay() {
    const tab = $('[data-day-tab]');
    return tab ? tab.dataset.dayTab : null;
  }

  /* ------------------------------------------------------------ storage */
  const KEY = 'us-schedule-' + slug;
  function readSel() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  function writeSel(ids) {
    try {
      localStorage.setItem(KEY, JSON.stringify(ids));
    } catch {
      /* storage unavailable (private mode / blocked iframe) — selection is session-only */
    }
  }
  let selected = readSel();

  /* ------------------------------------------------------------ filters */
  function checkedFacets() {
    const groups = {};
    $$('[data-facet]').forEach((cb) => {
      if (!cb.checked) return;
      (groups[cb.dataset.facet] = groups[cb.dataset.facet] || []).push(cb.value);
    });
    return groups;
  }

  function cardMatches(el) {
    if (el.hasAttribute('data-service')) return !state.q && !state.track && !state.mine;
    const q = state.q;
    if (q && !(el.dataset.search || '').includes(q)) return false;
    if (state.track && el.dataset.track !== state.track) return false;
    if (state.mine && !selected.includes(el.dataset.sid)) return false;
    const groups = checkedFacets();
    for (const facet in groups) {
      const val = el.dataset[facet];
      if (!groups[facet].includes(val)) return false;
    }
    return true;
  }

  function apply() {
    let shown = 0;
    if (widget === 'itinerary') {
      const sections = $$('[data-day-section]');
      sections.forEach((sec) => {
        const inDay = state.mine || !state.day || sec.dataset.daySection === state.day || sections.length === 1;
        sec.hidden = !inDay;
        if (!inDay) return;
        let secShown = 0;
        sec.querySelectorAll('[data-i-group]').forEach((group) => {
          let groupShown = 0;
          group.querySelectorAll('[data-i-card]').forEach((card) => {
            const ok = cardMatches(card);
            card.hidden = !ok;
            if (ok && !card.hasAttribute('data-service')) groupShown++;
            if (ok) secShown++;
          });
          group.hidden = groupShown === 0;
        });
        shown += secShown;
        if (state.mine) sec.hidden = secShown === 0;
      });
      const tabs = $('[data-i-days]');
      if (tabs) tabs.hidden = state.mine;
    } else {
      $$(cardSel).forEach((card) => {
        const ok = cardMatches(card);
        card.hidden = !ok;
        if (ok) shown++;
      });
    }
    const dirty = !!state.q || !!state.track || Object.keys(checkedFacets()).length > 0;
    // With no cards at all, the server-rendered "none yet" placeholder and
    // count stay in charge — the no-match message is only for active filters.
    if (countEl && total > 0) countEl.textContent = shown ? `1–${shown} of ${total}` : `0 of ${total}`;
    if (emptyEl) emptyEl.hidden = total === 0 || shown > 0 || !(dirty || state.mine);
    if (clearEl) clearEl.hidden = !dirty;
    styleDayTabs();
    styleMineToggle();
    trimMoreButtons();
  }

  /**
   * Hide [data-more] when its clamped text is not actually truncated. A hidden
   * card measures 0×0, so those are skipped and re-measured when they become
   * visible (day switch / gallery overlay → the callers below). All reads run
   * before any write to keep this a single layout pass.
   */
  function trimMoreButtons() {
    const pairs = $$('[data-more]')
      .map((btn) => ({ btn, text: btn.parentElement.querySelector('[data-abstract]') }))
      .filter((p) => p.text && p.text.getAttribute('data-open') !== '1' && p.text.clientHeight > 0);
    const fits = pairs.map((p) => p.text.scrollHeight <= p.text.clientHeight + 1);
    pairs.forEach((p, i) => {
      p.btn.hidden = fits[i];
    });
  }

  /* ------------------------------------------------------------- chrome */
  function styleDayTabs() {
    $$('[data-day-tab]').forEach((b) => {
      const on = !state.mine && b.dataset.dayTab === state.day;
      b.style.borderColor = on ? 'var(--accent)' : 'var(--border-strong)';
      b.style.background = on ? 'var(--accent)' : 'var(--card)';
      b.style.color = on ? '#fff' : 'var(--text-secondary)';
    });
  }

  function styleMineToggle() {
    const btn = $('[data-mine-toggle]');
    if (!btn) return;
    btn.style.background = state.mine ? 'var(--accent)' : 'var(--card)';
    btn.style.color = state.mine ? '#fff' : 'var(--text)';
    btn.style.borderColor = state.mine ? 'var(--accent)' : 'var(--border-strong)';
    const count = $('[data-mine-count]');
    if (count) count.textContent = String(selected.length);
  }

  function styleStars() {
    $$('[data-star]').forEach((b) => {
      const on = selected.includes(b.dataset.star);
      b.textContent = on ? '★ Added' : '☆ Add';
      b.title = on ? 'Remove from my schedule' : 'Add to my schedule';
      b.style.background = on ? 'var(--accent)' : 'none';
      b.style.color = on ? '#fff' : 'var(--text-secondary)';
      b.style.borderColor = on ? 'var(--accent)' : 'var(--border-strong)';
    });
    const link = $('[data-ics-link]');
    if (link) {
      const base = link.dataset.icsBase;
      link.href = selected.length ? `${base}?ids=${selected.join(',')}` : base;
      link.textContent = selected.length
        ? `＋ Add my ${selected.length} session${selected.length === 1 ? '' : 's'} to calendar (.ics)`
        : '＋ Add to calendar (.ics)';
    }
  }

  /* -------------------------------------------------------------- events */
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      state.q = searchEl.value.trim().toLowerCase();
      apply();
    });
  }

  root.addEventListener('change', (e) => {
    if (e.target.closest('[data-facet]')) {
      apply();
      return;
    }
    const trackSel = e.target.closest('[data-i-track]');
    if (trackSel) {
      state.track = trackSel.value;
      apply();
    }
  });

  root.addEventListener('click', (e) => {
    const more = e.target.closest('[data-more]');
    if (more) {
      const text = more.parentElement.querySelector('[data-abstract]');
      if (text) {
        const open = text.getAttribute('data-open') === '1';
        text.setAttribute('data-open', open ? '0' : '1');
        text.style.webkitLineClamp = open ? '3' : 'unset';
        more.textContent = open ? 'Show more' : 'Show less';
      }
      return;
    }

    const toggle = e.target.closest('[data-facets-toggle]');
    if (toggle) {
      const panel = $('[data-facets]');
      if (panel) panel.hidden = !panel.hidden;
      return;
    }

    if (e.target.closest('[data-w-clear]')) {
      state.q = '';
      state.track = '';
      if (searchEl) searchEl.value = '';
      $$('[data-facet]').forEach((cb) => {
        cb.checked = false;
      });
      apply();
      return;
    }

    const tab = e.target.closest('[data-day-tab]');
    if (tab) {
      state.day = tab.dataset.dayTab;
      state.mine = false;
      apply();
      return;
    }

    const mine = e.target.closest('[data-mine-toggle]');
    if (mine) {
      state.mine = !state.mine;
      apply();
      return;
    }

    const star = e.target.closest('[data-star]');
    if (star) {
      const id = star.dataset.star;
      selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
      writeSel(selected);
      styleStars();
      styleMineToggle();
      if (state.mine) apply();
      return;
    }

    const gCard = e.target.closest('[data-g-card]');
    if (gCard) {
      const detail = root.querySelector(`[data-g-detail="${gCard.dataset.gCard}"]`);
      if (detail) {
        detail.hidden = false;
        trimMoreButtons();
      }
      return;
    }
    const gClose = e.target.closest('[data-g-close]');
    if (gClose) {
      const overlay = gClose.closest('[data-g-detail]');
      if (overlay) overlay.hidden = true;
      return;
    }
    // Backdrop click closes the gallery overlay.
    if (e.target.matches('[data-g-detail]')) e.target.hidden = true;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    $$('[data-g-detail]').forEach((d) => {
      d.hidden = true;
    });
  });

  styleStars();
  styleMineToggle();
  apply();

  // Late webfont metrics or a resized viewport can change how many lines the
  // text wraps to, flipping whether the clamp truncates.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(trimMoreButtons);
  window.addEventListener('resize', trimMoreButtons);
}
