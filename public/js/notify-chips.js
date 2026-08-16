/**
 * Notify-members chips (track B1) — the "@Sean Parker" picker in form
 * settings' NOTIFY ON EVERY NEW SUBMISSION block.
 *
 * The server renders a plain `<select multiple name="notifyMembers[]">` so the
 * settings drawer still picks teammates without JavaScript. This island hides
 * that select and drives it through chips plus a filterable add menu — the
 * select stays the source of truth, so the ordinary form POST is unchanged.
 */

const MONO = "'IBM Plex Mono',monospace";
const ROW = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;position:relative;';
const CHIP =
  'display:inline-flex;align-items:center;gap:6px;background:#eef0fb;color:#4c5fd5;border:1px solid #d5daf4;padding:4px 6px 4px 9px;font-size:12.5px;font-weight:600;line-height:1.4;';
/* Padding for the × and the add button lives in the page's `.fb-chipx` /
   `.fb-chipadd` rules (admin-forms.tsx), which grow them to a finger-sized
   box below 768px — an inline padding here could not be overridden. */
const CHIP_X = 'display:inline-flex;align-items:center;background:none;border:none;color:#4c5fd5;font-size:13px;line-height:1;cursor:pointer;';
const ADD =
  'display:inline-flex;align-items:center;gap:6px;background:#fff;border:1px dashed #c9cbd3;color:#686b74;font-size:12.5px;line-height:1.4;cursor:pointer;';
const MENU =
  'position:absolute;top:calc(100% + 4px);left:0;z-index:60;width:min(280px,100%);background:#fff;border:1px solid #e2e3e8;box-shadow:0 8px 24px rgba(22,23,29,0.12);';
const FILTER =
  'width:100%;box-sizing:border-box;padding:8px 10px;border:none;border-bottom:1px solid #e2e3e8;font-size:12.5px;outline:none;';
const ITEM =
  'display:flex;flex-direction:column;gap:1px;width:100%;text-align:left;background:#fff;border:none;border-bottom:1px solid #f2f3f5;padding:8px 10px;cursor:pointer;';
const EMPTY = 'padding:10px;font-size:12px;color:#9a9da6;';

function nameOf(opt) {
  return opt.dataset.name || opt.dataset.email || opt.value;
}

/** Where the menu would get cut off — the drawer's scroll box, else the viewport. */
function clipBottom(el) {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll') return p.getBoundingClientRect().bottom;
  }
  return window.innerHeight;
}

function mount(host) {
  const select = host.querySelector('select[multiple]');
  if (!select) return;
  const opts = [...select.options];
  select.hidden = true;

  const row = document.createElement('div');
  row.style.cssText = ROW;
  host.appendChild(row);

  let menu = null;
  const closeMenu = () => {
    if (menu) menu.remove();
    menu = null;
  };

  function openMenu() {
    closeMenu();
    const rest = opts.filter((o) => !o.selected);
    menu = document.createElement('div');
    menu.style.cssText = MENU;

    const filter = document.createElement('input');
    filter.placeholder = 'Search teammates…';
    filter.style.cssText = FILTER;
    const list = document.createElement('div');
    list.style.cssText = 'max-height:190px;overflow-y:auto;';

    const paint = () => {
      const q = filter.value.trim().toLowerCase();
      list.textContent = '';
      const shown = q
        ? rest.filter((o) => `${o.dataset.name || ''} ${o.dataset.email || ''}`.toLowerCase().includes(q))
        : rest;
      if (!shown.length) {
        const none = document.createElement('div');
        none.style.cssText = EMPTY;
        none.textContent = rest.length ? 'No teammate matches' : 'Everyone is already on the list';
        list.appendChild(none);
        return;
      }
      shown.forEach((o) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.style.cssText = ITEM;
        const name = document.createElement('span');
        name.style.cssText = 'font-size:13px;font-weight:600;color:#16171d;';
        name.textContent = nameOf(o);
        item.appendChild(name);
        if (o.dataset.email && o.dataset.name) {
          const email = document.createElement('span');
          email.style.cssText = `font-family:${MONO};font-size:11px;color:#686b74;`;
          email.textContent = o.dataset.email;
          item.appendChild(email);
        }
        item.addEventListener('click', () => {
          o.selected = true;
          render();
        });
        list.appendChild(item);
      });
    };

    filter.addEventListener('input', paint);
    menu.append(filter, list);
    paint();
    row.appendChild(menu);
    // The block sits near the bottom of the settings drawer, so a menu that
    // always dropped down would be clipped by the drawer's scroll edge.
    const box = menu.getBoundingClientRect();
    if (box.bottom > clipBottom(row) - 8 && box.height < row.getBoundingClientRect().top - 8) {
      menu.style.top = 'auto';
      menu.style.bottom = 'calc(100% + 4px)';
    }
    filter.focus();
  }

  function render() {
    closeMenu();
    row.textContent = '';
    opts
      .filter((o) => o.selected)
      .forEach((o) => {
        const chip = document.createElement('span');
        chip.style.cssText = CHIP;
        const text = document.createElement('span');
        text.textContent = `@${nameOf(o)}`;
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'fb-chipx';
        x.style.cssText = CHIP_X;
        x.textContent = '×';
        x.setAttribute('aria-label', `Stop notifying ${nameOf(o)}`);
        x.addEventListener('click', () => {
          o.selected = false;
          render();
        });
        chip.append(text, x);
        row.appendChild(chip);
      });

    if (opts.some((o) => !o.selected)) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'fb-chipadd';
      add.style.cssText = ADD;
      add.textContent = opts.some((o) => o.selected) ? '＋ Add' : '＋ Add teammate';
      add.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menu) closeMenu();
        else openMenu();
      });
      row.appendChild(add);
    }
  }

  document.addEventListener('click', (e) => {
    if (menu && !row.contains(e.target)) closeMenu();
  });
  // Capture so Escape closes the menu without also closing the settings drawer.
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && menu) {
        e.stopPropagation();
        closeMenu();
      }
    },
    true
  );

  render();
}

document.querySelectorAll('[data-notify-members]').forEach(mount);
