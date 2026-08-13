/**
 * Contact record (Speaker CRM) — dropdown option builder in the "Add a custom
 * field" dialog.
 *
 * The server renders a plain comma-separated <input name="options"> so the
 * dialog still works without JavaScript. This island hides that input and lets
 * options be added one at a time as removable chips; each chip carries a
 * hidden <input name="options[]">, so the ordinary form POST is unchanged. It
 * also hides the whole OPTIONS block while the field type is Text.
 */

const INPUT = 'width:100%;padding:8px 10px;border:1px solid #e2e3e8;font-size:13px;background:#fff;';
const ADD = 'padding:8px 14px;background:#fff;border:1px solid #e2e3e8;font-size:13px;cursor:pointer;white-space:nowrap;';
const CHIP =
  'display:inline-flex;align-items:center;gap:6px;background:#eef0fb;color:#4c5fd5;border:1px solid #d5daf4;padding:4px 6px 4px 9px;font-size:12.5px;font-weight:600;line-height:1.4;';
const CHIP_X = 'background:none;border:none;padding:0 2px;color:#4c5fd5;font-size:13px;line-height:1;cursor:pointer;';

function mount(host) {
  const form = host.closest('form');
  const fallback = host.querySelector('input[name="options"]');
  if (!form || !fallback) return;
  fallback.hidden = true;

  const chips = document.createElement('div');
  chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;';
  chips.hidden = true;

  const entry = document.createElement('input');
  entry.placeholder = 'Add an option, e.g. Confirmed';
  entry.style.cssText = INPUT;
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.textContent = 'Add';
  addBtn.style.cssText = ADD;
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;';
  row.append(entry, addBtn);
  host.append(chips, row);

  const values = [];

  function paint() {
    chips.textContent = '';
    chips.hidden = !values.length;
    values.forEach((v) => {
      const chip = document.createElement('span');
      chip.style.cssText = CHIP;
      const text = document.createElement('span');
      text.textContent = v;
      const x = document.createElement('button');
      x.type = 'button';
      x.style.cssText = CHIP_X;
      x.textContent = '×';
      x.setAttribute('aria-label', `Remove option ${v}`);
      x.addEventListener('click', () => {
        values.splice(values.indexOf(v), 1);
        paint();
      });
      const hidden = document.createElement('input');
      hidden.type = 'hidden';
      hidden.name = 'options[]';
      hidden.value = v;
      chip.append(text, x, hidden);
      chips.appendChild(chip);
    });
  }

  function add() {
    const v = entry.value.trim();
    entry.value = '';
    if (v && !values.includes(v)) {
      values.push(v);
      paint();
    }
    entry.focus();
  }

  addBtn.addEventListener('click', add);
  entry.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      add();
    }
  });
  // A typed-but-not-added value still counts on submit.
  form.addEventListener('submit', () => {
    const v = entry.value.trim();
    if (v && !values.includes(v)) {
      values.push(v);
      paint();
    }
  });

  const type = form.querySelector('select[name="type"]');
  if (type) {
    const sync = () => {
      host.hidden = type.value !== 'dropdown';
    };
    type.addEventListener('change', sync);
    sync();
  }
}

document.querySelectorAll('[data-option-builder]').forEach(mount);
