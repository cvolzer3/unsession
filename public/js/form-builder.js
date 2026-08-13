/**
 * Form builder island (track B1) — the interactive half of `Forms.dc.html`.
 *
 *   · HTML5 drag-and-drop reorder + palette drops, with the prototype's
 *     "condition cleared — source now later in the form" sanitize rule
 *   · the right-hand field settings rail (label, options, per-type validation,
 *     flags, conditional visibility, archive)
 *   · explicit "Save changes" (header button) posting to
 *     /app/api/forms/:id/schema (copy-on-write versioning happens server-side)
 *   · Preview mode is not rendered here at all — it frames the real public
 *     page (`/{event}/{form}?preview=1`), so there is only one renderer
 */
import { toast, api, copy, openDialog, busy, done } from './ui.js';
// Importing rich-editor.js also auto-mounts the drawer's `data-rich-editor`
// textareas (post-submit message) as a side effect.
import { mountRichEditor, sanitizeHtml } from './rich-editor.js';

const MONO = "'IBM Plex Mono',monospace";
const TYPE_CHIP = `font-family:${MONO};font-size:9.5px;background:#eef0fb;color:#4c5fd5;padding:3px 6px;font-weight:600;min-width:34px;text-align:center;line-height:1.4;flex:none;`;
const SMALL_INPUT = 'width:100%;padding:8px 10px;border:1px solid #e2e3e8;background:#f8f8fa;font-size:12.5px;color:#43464e;outline-color:#4c5fd5;';
const SELECT = 'padding:7px 9px;border:1px solid #e2e3e8;font-size:12.5px;background:#fff;width:100%;';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function boot(D) {
  /* ---------------------------------------------------------- shared bits */

  const copyBtn = document.getElementById('fb-copy-link');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      if (copyBtn.getAttribute('data-draft') === '1') {
        toast('Draft forms have no public link yet — publish from Form settings', false);
        return;
      }
      const link = copyBtn.getAttribute('data-share');
      copy(link, `Share link copied — ${link.replace(/^https?:\/\//, '')}`);
    });
  }

  // Settings drawer + setup step: reveal the late link / welcome hint live.
  document.querySelectorAll('[data-toggle-key]').forEach((label) => {
    const box = label.querySelector('input[type="checkbox"]');
    const key = label.getAttribute('data-toggle-key');
    if (!box) return;
    box.addEventListener('change', () => {
      const scope = label.closest('form') || document;
      if (key === 'lateLink') {
        scope.querySelectorAll('[data-late-link]').forEach((el) => {
          el.hidden = !box.checked;
        });
      }
      if (key === 'welcome') {
        scope.querySelectorAll('[data-welcome-block]').forEach((el) => {
          el.hidden = !box.checked;
        });
        // The builder's PAGE 1 card follows the toggle without a reload; the
        // enabled state persists when the drawer's own Save posts the form.
        // With no welcome page there's nothing in its place — the form itself
        // becomes page 1, so the field list's page number follows too.
        const card = document.getElementById('fb-welcome-card');
        const page = document.getElementById('fb-form-page');
        if (card) card.hidden = !box.checked;
        if (page) page.textContent = `PAGE ${box.checked ? 2 : 1} · FORM`;
      }
    });
  });

  // Preview mode is a server-rendered iframe of the public page — nothing to mount.
  if (D.mode !== 'build') return;

  /* ---------------------------------------------------------- state */

  let fields = (D.schema && D.schema.fields ? D.schema.fields : []).map((f) => ({ ...f }));
  let selId = null;
  let overIdx = null;
  let drag = null;
  let version = D.version;
  // Edits mark the builder dirty; nothing hits the server until the header's
  // "Save changes" button is pressed. rev/savedRev spot edits that land while
  // a save is in flight, so a mid-save change never shows as saved.
  let rev = 0;
  let savedRev = 0;
  let saving = false;
  let schemaDirty = false; // fields changed since the last schema post
  let pendingWelcome = null; // sanitized welcome HTML awaiting save

  const list = document.getElementById('fb-list');
  const endzone = document.getElementById('fb-endzone');
  const rail = document.getElementById('fb-rail');
  const saveState = document.getElementById('fb-save-state');
  const saveBtn = document.getElementById('fb-save-btn');
  const palette = document.getElementById('fb-palette');

  const typeOf = (label) => (D.palette.find((p) => p.label === label) || { type: 'TXT' }).type;

  function flash(msg) {
    toast(msg);
  }

  /* ---------------------------------------------------------- persistence */

  function setSaveState(text, colour) {
    if (!saveState) return;
    saveState.textContent = text;
    saveState.style.color = colour;
  }

  // Shared "there is unsaved work" UI; markDirty() is the field-edit flavour.
  function touch() {
    rev++;
    setSaveState('UNSAVED CHANGES', '#b08800');
    if (saveBtn) saveBtn.disabled = false;
  }

  function markDirty() {
    schemaDirty = true;
    touch();
  }

  async function save() {
    if (saving || rev === savedRev) return;
    saving = true;
    if (saveBtn) busy(saveBtn, 'Saving…');
    setSaveState('SAVING…', '#b08800');
    const at = rev;
    // Posting an unchanged schema to a frozen version would fork a spurious
    // v+1, so only post the parts that actually changed. A mid-save edit
    // re-raises the flag; the catch restores it so a failed post retries.
    const postSchema = schemaDirty;
    schemaDirty = false;
    try {
      if (pendingWelcome != null) {
        const welcome = pendingWelcome;
        await api(`/app/api/forms/${D.formId}/settings`, { welcomeMd: welcome });
        if (pendingWelcome === welcome) pendingWelcome = null;
      }
      if (postSchema) {
        const res = await api(`/app/api/forms/${D.formId}/schema`, { fields });
        if (res.sanitized) {
          fields = res.fields;
          renderList();
          renderRail();
          flash('A condition was cleared: its source now sits later in the form');
        }
        if (res.bumped) {
          version = res.version;
          flash(`Version v${version} created`);
        }
      }
      savedRev = at;
      if (rev === savedRev) {
        setSaveState('ALL CHANGES SAVED', '#c9cbd3');
      } else {
        // Edits arrived while saving — keep the button live.
        setSaveState('UNSAVED CHANGES', '#b08800');
      }
    } catch (err) {
      if (postSchema) schemaDirty = true;
      setSaveState('NOT SAVED', '#c92a2a');
      toast(err.message, false);
    } finally {
      saving = false;
      if (saveBtn) {
        done(saveBtn);
        // Nothing left to save → the button rests disabled, as touch() expects.
        saveBtn.disabled = rev === savedRev;
      }
    }
  }

  if (saveBtn) saveBtn.addEventListener('click', save);

  window.addEventListener('beforeunload', (e) => {
    if (rev === savedRev) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // PAGE 1 · WELCOME — the hidden #fb-welcome textarea carries the (already
  // rich-lite) copy; mount the WYSIWYG editor in its place. Edits are buffered
  // in pendingWelcome and land with the schema on "Save changes".
  const welcomeSrc = document.getElementById('fb-welcome');
  if (welcomeSrc) {
    const holder = document.createElement('div');
    welcomeSrc.parentNode.insertBefore(holder, welcomeSrc);
    const welcomeValue = welcomeSrc.value;
    welcomeSrc.remove();
    mountRichEditor(holder, {
      name: 'welcomeMd',
      value: welcomeValue,
      onChange: (html) => {
        pendingWelcome = sanitizeHtml(html);
        touch();
      },
    });
  }

  /* ---------------------------------------------------------- field list */

  function condLabelFor(f) {
    if (!f.cond) return null;
    const src = fields.find((x) => x.id === f.cond.src);
    if (!src) return 'IF (ARCHIVED FIELD)';
    return `IF ${src.label.toUpperCase()} ${String(f.cond.op).toUpperCase()} ${String(f.cond.val).split(' (')[0].toUpperCase()}`;
  }

  function tagLine(f) {
    return [f.required ? 'required' : null, f.flags && f.flags.public ? 'public' : null, f.flags && !f.flags.evaluatorVisible ? 'hidden from evaluators' : null]
      .filter(Boolean)
      .join(' · ');
  }

  function rowStyle(f, i) {
    const selected = selId === f.id;
    return [
      'display:flex;align-items:flex-start;gap:10px;background:#fff;',
      `border:1px solid ${selected ? '#4c5fd5' : '#e2e3e8'};`,
      selected ? 'outline:1px solid #4c5fd5;' : '',
      overIdx === i ? 'box-shadow:0 -3px 0 #4c5fd5;' : '',
      drag && drag.kind === 'field' && drag.id === f.id ? 'opacity:0.4;' : '',
      'padding:11px 14px;margin-bottom:6px;cursor:grab;',
    ].join('');
  }

  function rowHtml(f, i) {
    const chip = condLabelFor(f);
    const tags = tagLine(f);
    return `<div data-field="${esc(f.id)}" data-idx="${i}" draggable="true" style="${rowStyle(f, i)}">
      <span style="color:#c9cbd3;cursor:grab;font-size:14px;line-height:1;flex:none;">⠿</span>
      <span style="${TYPE_CHIP}">${esc(f.type)}</span>
      <div style="display:flex;flex-direction:column;gap:4px;min-width:0;flex:1;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="font-size:13.5px;font-weight:600;line-height:1.3;">${esc(f.label)}</span>
          ${f.core ? `<span style="font-family:${MONO};font-size:9px;letter-spacing:0.08em;color:#4c5fd5;border:1px solid #d5daf4;padding:2px 5px;line-height:1.4;flex:none;white-space:nowrap;">CORE</span>` : ''}
          ${chip ? `<span style="font-family:${MONO};font-size:10px;color:#b08800;background:#fdf5dc;padding:2px 6px;line-height:1.4;flex:none;white-space:nowrap;">${esc(chip)}</span>` : ''}
        </div>
        ${tags ? `<span style="font-size:11px;color:#9a9da6;line-height:1.3;">${esc(tags)}</span>` : ''}
      </div>
    </div>`;
  }

  /**
   * Style-only repaint. Re-rendering innerHTML mid-drag would destroy the drag
   * source and cancel the gesture, so selection/hover/insert markers repaint
   * the existing rows in place.
   */
  function paint() {
    [...list.children].forEach((el, i) => {
      if (fields[i]) el.style.cssText = rowStyle(fields[i], i);
    });
    if (endzone) {
      const on = overIdx === fields.length;
      endzone.style.borderColor = on ? '#4c5fd5' : '#d8d9de';
      endzone.style.background = on ? '#eef0fb' : 'transparent';
      endzone.style.color = on ? '#4c5fd5' : '#b4b6be';
    }
  }

  function renderList() {
    list.innerHTML = fields.map(rowHtml).join('');
    paint();
  }

  /* ---------------------------------------------------------- drag & drop */

  function sanitize(next) {
    let dropped = false;
    const out = next.map((f, i) => {
      if (f.cond) {
        const idx = next.findIndex((x) => x.id === f.cond.src);
        if (idx >= i) {
          dropped = true;
          return { ...f, cond: null };
        }
      }
      return f;
    });
    return { out, dropped };
  }

  function newField(label) {
    const type = typeOf(label);
    const f = {
      id: `f_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      type,
      label: `New ${label.toLowerCase()}`,
      required: false,
      validation: {},
      flags: { public: false, speakerEditable: false, evaluatorVisible: true },
      cond: null,
    };
    if (type === 'SEL' || type === 'MULTI') f.opts = ['Option A', 'Option B'];
    return f;
  }

  function insertAt(idx) {
    const d = drag;
    drag = null;
    if (!d) return;
    const next = [...fields];
    if (d.kind === 'field') {
      const from = next.findIndex((f) => f.id === d.id);
      if (from < 0) return;
      const [fld] = next.splice(from, 1);
      let at = idx;
      if (from < at) at--;
      next.splice(at, 0, fld);
      const { out, dropped } = sanitize(next);
      fields = out;
      overIdx = null;
      renderList();
      renderRail();
      markDirty();
      flash(dropped ? `“${fld.label}” moved — a condition was cleared (source now later in the form)` : `“${fld.label}” moved`);
    } else {
      const nf = newField(d.label);
      next.splice(idx, 0, nf);
      fields = next;
      overIdx = null;
      selId = nf.id;
      renderList();
      renderRail();
      markDirty();
      flash(`“${nf.label}” added`);
    }
  }

  list.addEventListener('dragstart', (e) => {
    const row = e.target.closest('[data-field]');
    if (!row) return;
    drag = { kind: 'field', id: row.getAttribute('data-field') };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', drag.id);
    setTimeout(paint, 0);
  });
  list.addEventListener('dragend', () => {
    drag = null;
    overIdx = null;
    paint();
  });
  list.addEventListener('dragover', (e) => {
    if (!drag) return;
    const row = e.target.closest('[data-field]');
    if (!row) return;
    e.preventDefault();
    const i = Number(row.getAttribute('data-idx'));
    const r = row.getBoundingClientRect();
    const idx = e.clientY < r.top + r.height / 2 ? i : i + 1;
    if (overIdx !== idx) {
      overIdx = idx;
      paint();
    }
  });
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const row = e.target.closest('[data-field]');
    insertAt(overIdx == null ? (row ? Number(row.getAttribute('data-idx')) : fields.length) : overIdx);
  });
  list.addEventListener('click', (e) => {
    const row = e.target.closest('[data-field]');
    if (!row) return;
    selId = row.getAttribute('data-field');
    paint();
    renderRail();
  });

  if (endzone) {
    endzone.addEventListener('dragover', (e) => {
      if (!drag) return;
      e.preventDefault();
      if (overIdx !== fields.length) {
        overIdx = fields.length;
        paint();
      }
    });
    endzone.addEventListener('drop', (e) => {
      e.preventDefault();
      insertAt(overIdx == null ? fields.length : overIdx);
    });
  }

  if (palette) {
    palette.addEventListener('dragstart', (e) => {
      const btn = e.target.closest('[data-palette]');
      if (!btn) return;
      drag = { kind: 'new', label: btn.getAttribute('data-palette') };
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', drag.label);
    });
    palette.addEventListener('dragend', () => {
      drag = null;
      overIdx = null;
      paint();
    });
    palette.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-palette]');
      if (!btn) return;
      const nf = newField(btn.getAttribute('data-palette'));
      fields = [...fields, nf];
      selId = nf.id;
      renderList();
      renderRail();
      markDirty();
      flash(`“${nf.label}” added`);
    });
  }

  /* ---------------------------------------------------------- right rail */

  function patch(id, delta) {
    fields = fields.map((f) => (f.id === id ? { ...f, ...delta } : f));
    renderList();
    markDirty();
  }

  function patchValidation(id, delta) {
    const f = fields.find((x) => x.id === id);
    if (!f) return;
    patch(id, { validation: { ...(f.validation || {}), ...delta } });
  }

  const VTITLE = {
    TXT: 'Validation — length (characters)',
    MULTI: 'Validation — number of selections',
    LONG: 'Validation — length (words)',
    NUM: 'Validation — value range',
    DATE: 'Validation — date range',
    FILE: 'Validation — file rules',
    GRP: 'Validation — co-speakers',
  };
  const VNOTES = {
    EML: 'Email format checked automatically · email keyboard on mobile',
    URL: 'URL format checked · auto-prepends https:// on blur',
    TEL: 'Phone-format check: length and allowed characters, any country.',
  };
  const FILE_PRESETS = {
    doc: 'pdf, doc, docx',
    img: 'jpg, png, gif',
    slides: 'pdf, ppt, pptx, key',
    video: 'mp4, mov',
    audio: 'mp3, wav, m4a',
  };

  function railHtml(f) {
    const i = fields.indexOf(f);
    const V = f.validation || {};
    const flags = f.flags || {};
    const unit = f.type === 'MULTI' ? 'selections' : 'chars';
    const bound = !!(f.taxonomyId || f.taxonomyName);
    const srcOpts = fields.slice(0, i).filter((x) => x.type === 'SEL' || x.type === 'CHK');
    const srcField = f.cond ? fields.find((x) => x.id === f.cond.src) : null;
    const valOpts = srcField ? (srcField.type === 'CHK' ? ['true'] : srcField.opts || []) : [];
    const num = (v) => (v === undefined || v === null ? '' : String(v));

    let validation = '';
    if (f.type === 'HDR') {
      // B2 copy blocks: the section header's label is the title, help is the
      // description rendered under it on the public form.
      validation = `<div>
        <div style="font-size:12px;color:#686b74;margin-bottom:4px;">Section description (optional)</div>
        <textarea data-help rows="3" style="${SMALL_INPUT}resize:vertical;font-family:inherit;">${esc(f.help || '')}</textarea>
        <div style="font-size:11.5px;color:#9a9da6;margin-top:4px;">Shown under the section header on the public form.</div>
      </div>`;
    } else {
      let inner = '';
      if (f.type === 'TXT' || f.type === 'MULTI') {
        const minKey = f.type === 'TXT' ? 'minChars' : 'min';
        const maxKey = f.type === 'TXT' ? 'maxChars' : 'max';
        inner = `<div style="display:flex;gap:6px;">
          <input type="number" min="0" placeholder="min (${unit})" value="${num(V[minKey])}" data-v="${minKey}" style="${SMALL_INPUT}">
          <input type="number" min="0" placeholder="max (${unit})" value="${num(V[maxKey])}" data-v="${maxKey}" style="${SMALL_INPUT}">
        </div>`;
      } else if (f.type === 'LONG') {
        inner = `<input type="number" min="0" placeholder="max words (live counter shown)" value="${num(V.maxWords)}" data-v="maxWords" style="${SMALL_INPUT}">`;
      } else if (f.type === 'NUM') {
        inner = `<div style="display:grid;gap:6px;">
          <select data-v="numKind" style="${SELECT}">
            <option value="integer"${V.numKind !== 'decimal' ? ' selected' : ''}>integer</option>
            <option value="decimal"${V.numKind === 'decimal' ? ' selected' : ''}>decimal</option>
          </select>
          <div style="display:flex;gap:6px;">
            <input type="number" placeholder="min value" value="${num(V.min)}" data-v="min" style="${SMALL_INPUT}">
            <input type="number" placeholder="max value" value="${num(V.max)}" data-v="max" style="${SMALL_INPUT}">
          </div>
        </div>`;
      } else if (f.type === 'DATE') {
        inner = `<div style="display:flex;gap:6px;">
          <input type="date" title="earliest" value="${esc(V.dateFrom || '')}" data-v="dateFrom" style="${SMALL_INPUT}">
          <input type="date" title="latest" value="${esc(V.dateTo || '')}" data-v="dateTo" style="${SMALL_INPUT}">
        </div>`;
      } else if (f.type === 'FILE') {
        const exts = V.fileExts || '';
        const presetKey = Object.keys(FILE_PRESETS).find((k) => FILE_PRESETS[k] === exts);
        const preset = presetKey || (exts ? 'custom' : 'any');
        inner = `<div style="display:grid;gap:6px;">
          <select data-file-preset style="width:100%;padding:8px 10px;border:1px solid #e2e3e8;background:#f8f8fa;font-size:13px;font-family:inherit;">
            ${[
              ['any', 'Any file type'],
              ['doc', 'Documents (pdf, doc, docx)'],
              ['img', 'Images (jpg, png, gif)'],
              ['slides', 'Slides (pdf, ppt, pptx, key)'],
              ['video', 'Video (mp4, mov)'],
              ['audio', 'Audio (mp3, wav, m4a)'],
              ['custom', 'Custom…'],
            ]
              .map(([v, l]) => `<option value="${v}"${preset === v ? ' selected' : ''}>${l}</option>`)
              .join('')}
          </select>
          ${preset === 'custom' ? `<input placeholder="allowed types, e.g. pdf, pptx" value="${esc(exts)}" data-v="fileExts" style="${SMALL_INPUT}">` : ''}
          <div style="display:flex;gap:6px;">
            <input type="number" min="1" placeholder="max size (MB)" value="${num(V.fileMaxMb)}" data-v="fileMaxMb" style="${SMALL_INPUT}">
            <input type="number" min="1" placeholder="max files" value="${num(V.fileMaxCount)}" data-v="fileMaxCount" style="${SMALL_INPUT}">
          </div>
        </div>`;
      } else if (f.type === 'CHK') {
        inner = `<label style="display:flex;gap:8px;font-size:13px;align-items:center;"><input type="checkbox" data-v-check="mustCheck"${
          V.mustCheck ? ' checked' : ''
        } style="accent-color:#4c5fd5;">Must be checked to submit (consent / code of conduct)</label>`;
      } else if (f.type === 'GRP') {
        inner = `<input type="number" min="1" placeholder="max co-speakers" value="${num(V.maxSpeakers)}" data-v="maxSpeakers" style="${SMALL_INPUT}">`;
      }
      const note = VNOTES[f.type] || (bound ? `bound to taxonomy: ${esc(f.taxonomyName || '')} — options come from Setup & Theming` : '');
      validation = `<div>
        <div style="font-size:12px;color:#686b74;margin-bottom:4px;">${VTITLE[f.type] || 'Validation'}</div>
        ${inner}
        ${note ? `<div style="font-size:11.5px;color:#686b74;background:#f8f8fa;border:1px solid #eceded;padding:8px 10px;margin-top:6px;">${note}</div>` : ''}
      </div>`;
    }

    // The sentence printed next to the box — the public form turns
    // `[label](https://…)` and bare URLs into links, which is how a
    // code-of-conduct field points at the actual document.
    const consent =
      f.type === 'CHK'
        ? `<div>
        <div style="font-size:12px;color:#686b74;margin-bottom:4px;">Checkbox text</div>
        <textarea data-ph rows="2" placeholder="I have read and agree to the [code of conduct](https://…)." style="${SMALL_INPUT}resize:vertical;font-family:inherit;">${esc(f.placeholder || '')}</textarea>
        <div style="font-size:11.5px;color:#9a9da6;margin-top:4px;">Shown next to the box. Link out with <code>[code of conduct](https://…)</code>.</div>
      </div>`
        : '';

    const options =
      (f.type === 'SEL' || f.type === 'MULTI') && !bound
        ? `<div>
        <div style="font-size:12px;color:#686b74;margin-bottom:4px;">Options</div>
        <div style="display:grid;gap:5px;">
          ${(f.opts || [])
            .map(
              (o, oi) => `<div style="display:flex;gap:6px;align-items:center;">
              <input value="${esc(o)}" data-opt="${oi}" style="flex:1;padding:7px 9px;border:1px solid #e2e3e8;font-size:12.5px;outline-color:#4c5fd5;">
              <button type="button" data-opt-remove="${oi}" title="Remove option" style="width:29px;height:29px;flex:none;border:1px solid #e2e3e8;background:#fff;color:#9a9da6;font-size:14px;cursor:pointer;line-height:1;">×</button>
            </div>`
            )
            .join('')}
          <button type="button" data-opt-add style="padding:7px 9px;border:1px dashed #c9cbd3;background:#fff;font-size:12px;color:#686b74;cursor:pointer;text-align:left;">+ Add option</button>
        </div>
      </div>`
        : '';

    const cond = `<div style="border-top:1px solid #eceded;padding-top:12px;">
      <div style="font-family:${MONO};font-size:10px;letter-spacing:0.1em;color:#9a9da6;margin-bottom:8px;">CONDITIONAL VISIBILITY</div>
      <label style="display:flex;gap:8px;font-size:13px;align-items:center;margin-bottom:8px;">
        <input type="checkbox" data-cond-toggle${f.cond ? ' checked' : ''} style="accent-color:#4c5fd5;"${
          srcOpts.length ? '' : ' disabled'
        }>Show only when…
      </label>
      ${
        !srcOpts.length
          ? '<div style="font-size:11.5px;color:#9a9da6;line-height:1.45;">Add a single-select or checkbox field <em>above</em> this one to use conditions.</div>'
          : f.cond
            ? `<div style="display:grid;gap:6px;">
        <select data-cond-src style="${SELECT}">
          ${srcOpts.map((o) => `<option value="${esc(o.id)}"${f.cond.src === o.id ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
          <select data-cond-op style="${SELECT}">
            ${['is', 'is not', 'is answered']
              .map((o) => `<option value="${o}"${f.cond.op === o ? ' selected' : ''}>${o}</option>`)
              .join('')}
          </select>
          <select data-cond-val style="${SELECT}">
            ${(valOpts.length ? valOpts : ['—'])
              .map((v) => `<option value="${esc(v)}"${String(f.cond.val) === String(v) ? ' selected' : ''}>${esc(v === 'true' ? 'checked' : v)}</option>`)
              .join('')}
          </select>
        </div>
        <label style="display:flex;gap:8px;font-size:12.5px;align-items:center;"><input type="checkbox" data-cond-req${
          f.cond.alsoReq ? ' checked' : ''
        } style="accent-color:#4c5fd5;">Also required when shown</label>
        <div style="font-size:11.5px;color:#9a9da6;line-height:1.45;">Conditions can only reference fields <em>earlier</em> in the form.</div>
      </div>`
            : ''
      }
    </div>`;

    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;">
      <span style="${TYPE_CHIP}">${esc(f.type)}</span>
      <span style="font-size:14px;font-weight:700;">Field settings</span>
      <span style="margin-left:auto;font-family:${MONO};font-size:10px;color:#9a9da6;">${esc(f.id)}</span>
    </div>
    <div style="display:grid;gap:14px;">
      <div>
        <div style="font-size:12px;color:#686b74;margin-bottom:4px;">Label (display only)</div>
        <input value="${esc(f.label)}" data-label style="width:100%;padding:8px 10px;border:1px solid #e2e3e8;font-size:13px;outline-color:#4c5fd5;">
      </div>
      ${consent}
      ${options}
      ${validation}
      <label style="display:flex;gap:8px;font-size:13px;align-items:center;"><input type="checkbox" data-required${
        f.required ? ' checked' : ''
      } style="accent-color:#4c5fd5;">Required</label>
      <div style="border-top:1px solid #eceded;padding-top:12px;">
        <div style="font-family:${MONO};font-size:10px;letter-spacing:0.1em;color:#9a9da6;margin-bottom:8px;">PER-FIELD FLAGS</div>
        <label style="display:flex;gap:8px;font-size:13px;align-items:center;margin-bottom:7px;"><input type="checkbox" data-flag="public"${
          flags.public ? ' checked' : ''
        } style="accent-color:#4c5fd5;">Visible on public agenda</label>
        <label style="display:flex;gap:8px;font-size:13px;align-items:center;margin-bottom:7px;"><input type="checkbox" data-flag="speakerEditable"${
          flags.speakerEditable ? ' checked' : ''
        } style="accent-color:#4c5fd5;">Speaker-editable post-acceptance</label>
        <label style="display:flex;gap:8px;font-size:13px;align-items:center;"><input type="checkbox" data-flag="evaluatorVisible"${
          flags.evaluatorVisible ? ' checked' : ''
        } style="accent-color:#4c5fd5;">Visible to evaluators</label>
        ${!flags.evaluatorVisible ? '<div style="margin-top:8px;font-size:11.5px;color:#b08800;background:#fdf5dc;padding:7px 10px;">Hidden from evaluators</div>' : ''}
      </div>
      ${cond}
      <button type="button" data-archive style="padding:8px 0;background:#fff;border:1px solid #ecc5c5;color:#c92a2a;font-size:12.5px;cursor:pointer;">Archive field</button>
    </div>`;
  }

  function renderRail() {
    const f = fields.find((x) => x.id === selId);
    if (!f) {
      rail.innerHTML =
        '<div style="color:#9a9da6;font-size:13px;padding-top:30px;text-align:center;">Select a field to configure it, or drag a field type onto the form.</div>';
      return;
    }
    rail.innerHTML = railHtml(f);
  }

  rail.addEventListener('input', (e) => {
    const f = fields.find((x) => x.id === selId);
    if (!f) return;
    const t = e.target;
    if (t.hasAttribute('data-label')) {
      patch(f.id, { label: t.value });
      return;
    }
    if (t.hasAttribute('data-help')) {
      patch(f.id, { help: t.value });
      return;
    }
    if (t.hasAttribute('data-ph')) {
      patch(f.id, { placeholder: t.value });
      return;
    }
    if (t.hasAttribute('data-v')) {
      const key = t.getAttribute('data-v');
      const raw = t.value;
      const value = t.type === 'number' ? (raw === '' ? undefined : Number(raw)) : raw || undefined;
      patchValidation(f.id, { [key]: value });
      return;
    }
    if (t.hasAttribute('data-opt')) {
      const oi = Number(t.getAttribute('data-opt'));
      const opts = [...(f.opts || [])];
      opts[oi] = t.value;
      patch(f.id, { opts });
    }
  });

  rail.addEventListener('change', (e) => {
    const f = fields.find((x) => x.id === selId);
    if (!f) return;
    const t = e.target;
    if (t.hasAttribute('data-v') && t.tagName === 'SELECT') {
      patchValidation(f.id, { [t.getAttribute('data-v')]: t.value });
      renderRail();
      return;
    }
    if (t.hasAttribute('data-v-check')) {
      patchValidation(f.id, { [t.getAttribute('data-v-check')]: t.checked });
      return;
    }
    if (t.hasAttribute('data-file-preset')) {
      const v = t.value;
      patchValidation(f.id, { fileExts: v === 'custom' ? f.validation?.fileExts || '' : FILE_PRESETS[v] || undefined });
      renderRail();
      return;
    }
    if (t.hasAttribute('data-required')) {
      patch(f.id, { required: t.checked });
      return;
    }
    if (t.hasAttribute('data-flag')) {
      patch(f.id, { flags: { ...(f.flags || {}), [t.getAttribute('data-flag')]: t.checked } });
      renderRail();
      return;
    }
    if (t.hasAttribute('data-cond-toggle')) {
      const i = fields.indexOf(f);
      const srcOpts = fields.slice(0, i).filter((x) => x.type === 'SEL' || x.type === 'CHK');
      patch(f.id, {
        cond: t.checked && srcOpts.length ? { src: srcOpts[0].id, op: 'is', val: '', alsoReq: false } : null,
      });
      renderRail();
      return;
    }
    if (t.hasAttribute('data-cond-src')) {
      patch(f.id, { cond: { ...f.cond, src: t.value, val: '' } });
      renderRail();
      return;
    }
    if (t.hasAttribute('data-cond-op')) {
      patch(f.id, { cond: { ...f.cond, op: t.value } });
      return;
    }
    if (t.hasAttribute('data-cond-val')) {
      patch(f.id, { cond: { ...f.cond, val: t.value } });
      return;
    }
    if (t.hasAttribute('data-cond-req')) {
      patch(f.id, { cond: { ...f.cond, alsoReq: t.checked } });
    }
  });

  rail.addEventListener('click', (e) => {
    const f = fields.find((x) => x.id === selId);
    if (!f) return;
    const add = e.target.closest('[data-opt-add]');
    if (add) {
      patch(f.id, { opts: [...(f.opts || []), 'New option'] });
      renderRail();
      return;
    }
    const rm = e.target.closest('[data-opt-remove]');
    if (rm) {
      const oi = Number(rm.getAttribute('data-opt-remove'));
      patch(f.id, { opts: (f.opts || []).filter((_, x) => x !== oi) });
      renderRail();
      return;
    }
    if (e.target.closest('[data-archive]')) {
      fields = fields.filter((x) => x.id !== f.id);
      const { out } = sanitize(fields);
      fields = out;
      selId = null;
      renderList();
      renderRail();
      markDirty();
      flash(`“${f.label}” archived`);
    }
  });

  renderList();
  renderRail();
}

const dataEl = document.getElementById('fb-data');
if (dataEl) boot(JSON.parse(dataEl.textContent));

// Dashboard deep link: ?focus=deadline opens the settings drawer on the
// Closes date, so "extend the deadline" is one edit away.
if (new URLSearchParams(location.search).get('focus') === 'deadline' && document.querySelector('#form-settings')) {
  openDialog('#form-settings');
  const closes = document.querySelector('#form-settings [name="closes_at"]');
  if (closes) {
    const pulse = document.createElement('style');
    pulse.textContent =
      '@keyframes usFocusPulse{0%{box-shadow:0 0 0 0 rgba(76,95,213,0.5)}100%{box-shadow:0 0 0 10px rgba(76,95,213,0)}}';
    document.head.appendChild(pulse);
    closes.style.animation = 'usFocusPulse 1.2s ease-out 2';
    closes.style.outline = '2px solid #4c5fd5';
    closes.style.outlineOffset = '1px';
    closes.focus();
    setTimeout(() => {
      closes.style.outline = '';
      closes.style.outlineOffset = '';
    }, 4000);
  }
}
