/**
 * Theme derivation — ported verbatim from the prototype's `Event Setup.dc.html`
 * logic class (hex2rgb / lum / shade / tint + the WCAG contrast choice).
 */
import type { Theme } from '../types';

export const DEFAULT_THEME: Theme = {
  primary: '#e8590c',
  accent: '#1a1a2e',
  bg: '#faf8f5',
  font: 'Space Grotesk',
  logoFileId: null,
};

/** Curated font pairings (spec §4.12 — token list, never custom CSS). */
export const FONT_PAIRINGS: { label: string; ui: string; mono: string; google: string }[] = [
  {
    label: 'Space Grotesk / IBM Plex Mono',
    ui: 'Space Grotesk',
    mono: 'IBM Plex Mono',
    google: 'family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600',
  },
  {
    label: 'Source Serif 4 / Source Sans 3',
    ui: 'Source Serif 4',
    mono: 'IBM Plex Mono',
    google:
      'family=Source+Serif+4:wght@400;600;700&family=Source+Sans+3:wght@400;600&family=IBM+Plex+Mono:wght@400;500;600',
  },
  {
    label: 'Archivo / Archivo',
    ui: 'Archivo',
    mono: 'IBM Plex Mono',
    google: 'family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600',
  },
  {
    label: 'Lora / PT Sans',
    ui: 'Lora',
    mono: 'IBM Plex Mono',
    google:
      'family=Lora:wght@400;500;600;700&family=PT+Sans:wght@400;700&family=IBM+Plex+Mono:wght@400;500;600',
  },
  {
    label: 'Inter / IBM Plex Mono',
    ui: 'Inter',
    mono: 'IBM Plex Mono',
    google: 'family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600',
  },
  {
    label: 'DM Sans / DM Mono',
    ui: 'DM Sans',
    mono: 'DM Mono',
    google: 'family=DM+Sans:wght@400;500;700&family=DM+Mono:wght@400;500',
  },
  {
    label: 'Work Sans / IBM Plex Mono',
    ui: 'Work Sans',
    mono: 'IBM Plex Mono',
    google: 'family=Work+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600',
  },
  {
    label: 'Libre Franklin / IBM Plex Mono',
    ui: 'Libre Franklin',
    mono: 'IBM Plex Mono',
    google: 'family=Libre+Franklin:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600',
  },
];

export function pairingFor(font: string) {
  return FONT_PAIRINGS.find((p) => p.ui === font) ?? FONT_PAIRINGS[0];
}

export function hex2rgb(h: string): [number, number, number] {
  const s = normalizeHex(h);
  return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)) as [number, number, number];
}

export function normalizeHex(h: string): string {
  let s = (h || '').trim();
  if (!s.startsWith('#')) s = '#' + s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) return '#e8590c';
  return s.toLowerCase();
}

export function lum(rgb: [number, number, number]): number {
  const a = rgb.map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}

export function shade(h: string, f: number): string {
  const rgb = hex2rgb(h).map((v) => Math.round(Math.max(0, Math.min(255, v * f))));
  return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
}

export function tint(h: string, f: number): string {
  const rgb = hex2rgb(h).map((v) => Math.round(v + (255 - v) * f));
  return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
}

export type Derived = {
  primary: string;
  hover: string;
  border: string;
  tint: string;
  textOn: string;
};

/** Prototype's derivation: hover = shade 0.85, border = tint 0.55, tint = tint 0.9. */
export function derive(primaryRaw: string): Derived {
  const primary = normalizeHex(primaryRaw);
  const L = lum(hex2rgb(primary));
  const white = 1.05 / (L + 0.05);
  const dark = (L + 0.05) / 0.05;
  const useWhite = white >= dark;
  return {
    primary,
    hover: shade(primary, 0.85),
    border: tint(primary, 0.55),
    tint: tint(primary, 0.9),
    textOn: useWhite ? '#fff' : '#16171d',
  };
}

/** Derived palette with the theme's manual overrides applied on top. */
export function paletteFor(theme: Theme): Derived {
  const d = derive(theme.primary || DEFAULT_THEME.primary);
  return {
    ...d,
    hover: theme.hover ? normalizeHex(theme.hover) : d.hover,
    border: theme.border ? normalizeHex(theme.border) : d.border,
    tint: theme.tint ? normalizeHex(theme.tint) : d.tint,
  };
}

/** CSS custom-property string for the public (event-themed) layout. */
export function themeStyleVars(theme: Theme): string {
  const d = paletteFor(theme);
  const pair = pairingFor(theme.font || DEFAULT_THEME.font);
  return [
    `--primary:${d.primary}`,
    `--primary-hover:${d.hover}`,
    `--primary-border:${d.border}`,
    `--primary-tint:${d.tint}`,
    `--on-primary:${d.textOn}`,
    `--bg:${normalizeHex(theme.bg || DEFAULT_THEME.bg)}`,
    `--accent:${normalizeHex(theme.accent || DEFAULT_THEME.accent)}`,
    `--text:#1a1a2e`,
    `--text-secondary:#555a63`,
    `--muted:#8b857a`,
    `--faint:#b0a99c`,
    `--card:#ffffff`,
    `--border:#ece7de`,
    `--border-strong:#ded8cd`,
    `--chip:#f0ece4`,
    `--font-ui:'${pair.ui}',sans-serif`,
    `--font-mono:'${pair.mono}',monospace`,
  ].join(';');
}

export function parseTheme(raw: string | null | undefined): Theme {
  if (!raw) return { ...DEFAULT_THEME };
  try {
    return { ...DEFAULT_THEME, ...(JSON.parse(raw) as Partial<Theme>) };
  } catch {
    return { ...DEFAULT_THEME };
  }
}

/** Initials used by the logo block on public surfaces (prototype: "DC" for DevConf). */
export function initialsOf(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'UN';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
