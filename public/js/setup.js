/**
 * Event Setup island — live derived swatches + live preview.
 * Ported from the prototype's `Event Setup.dc.html` logic class (hex2rgb / lum
 * / shade / tint). Mirrors src/lib/theme.ts so client and server agree.
 */
import { toast } from './ui.js';

const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = (rgb) => {
  const a = rgb.map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
};
const shade = (h, f) =>
  '#' +
  hex2rgb(h)
    .map((v) => Math.round(Math.max(0, Math.min(255, v * f))))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
const tint = (h, f) =>
  '#' +
  hex2rgb(h)
    .map((v) => Math.round(v + (255 - v) * f))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');

const input = document.getElementById('theme-primary');
if (input) {
  const paint = () => {
    const p = input.value;
    const L = lum(hex2rgb(p));
    const white = 1.05 / (L + 0.05);
    const dark = (L + 0.05) / 0.05;
    const useWhite = white >= dark;
    const hover = shade(p, 0.85);
    const border = tint(p, 0.55);
    const tintc = tint(p, 0.9);
    const on = useWhite ? '#fff' : '#16171d';

    const set = (id, bg) => {
      const el = document.getElementById(id);
      if (el) el.style.background = bg;
    };
    set('sw-primary', p);
    set('sw-hover', hover);
    set('sw-border', border);
    set('sw-tint', tintc);

    const hexLabel = document.getElementById('theme-primary-hex');
    if (hexLabel) hexLabel.textContent = p;

    const logo = document.getElementById('pv-logo');
    if (logo) {
      logo.style.background = p;
      logo.style.color = on;
    }
    const field = document.getElementById('pv-field');
    if (field) field.style.borderColor = border;
    const btn = document.getElementById('pv-btn');
    if (btn) {
      btn.style.background = p;
      btn.style.color = on;
    }
    const ratio = document.getElementById('pv-contrast');
    if (ratio) {
      ratio.textContent = `${(useWhite ? white : dark).toFixed(1)}:1 · ${useWhite ? 'white' : 'near-black'} text`;
    }
  };
  input.addEventListener('input', paint);
  paint();
}

const bg = document.getElementById('theme-bg');
if (bg) {
  const paintBg = () => {
    const pv = document.getElementById('pv-bg');
    if (pv) pv.style.background = bg.value;
    const label = document.getElementById('theme-bg-hex');
    if (label) label.textContent = bg.value;
  };
  bg.addEventListener('input', paintBg);
  paintBg();
}

const font = document.getElementById('theme-font');
if (font) {
  font.addEventListener('change', () => {
    const pv = document.getElementById('pv-bg');
    if (pv) pv.style.fontFamily = `'${font.value}', sans-serif`;
  });
}

const slug = document.getElementById('event-slug');
const name = document.getElementById('event-name');
if (slug && name && slug.dataset.autoslug === '1') {
  name.addEventListener('input', () => {
    slug.value = name.value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  });
  slug.addEventListener('input', () => {
    slug.dataset.autoslug = '0';
  });
}

const logoBtn = document.getElementById('logo-upload');
if (logoBtn && logoBtn.disabled) {
  logoBtn.parentElement?.addEventListener('click', () => toast('File storage not yet enabled', false));
}
