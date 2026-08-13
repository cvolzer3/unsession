# M — Mobile conventions

The contract every page follows to work on a phone. The foundation (shared
shells, global utility classes, the burger nav) is already in place in
`src/views/layout.tsx` and `public/js/ui.js`. **Those two files are frozen.** If
your page needs something the toolkit here does not give you, do not add it to
them — describe the change in your report.

Targets: **390×844** primary, **320×568** minimum. Desktop must not change.

## The breakpoint

One breakpoint, everywhere: **`max-width: 768px`**. It is `MOBILE_MAX` in
`src/views/layout.tsx` and mirrored once in `public/js/ui.js`. Write your page
media queries as `@media (max-width:768px){…}`. Do not invent a second
breakpoint; if a page needs a mid-size tweak, prefer a fluid value
(`min()`, `clamp()`, `%`) over a new query.

Do not import `MOBILE_MAX` into a route module's top-level template
(`const PAGE_CSS = \`…${MOBILE_MAX}…\``). The bundle's import cycle leaves it
undefined at module-evaluation time and the worker crashes at startup. Write
the literal `768` in page CSS.

## Porting an inline style to a media query

Inline `style="…"` beats every stylesheet rule, so a property that must change
on mobile **cannot stay inline**. The pattern:

1. Give the element a class (page-scoped prefix, or one of the shared `us-*`
   classes below).
2. Move **only the properties that differ on mobile** into your page's `<style>`
   block, with the desktop value byte-for-byte identical to what was inline.
3. Leave every other property inline.
4. Add the `@media (max-width:768px)` rule with the mobile value.

```
- <div style="padding:14px 28px;display:flex;gap:14px;">
+ <div class="pg-bar" style="display:flex;">
+ .pg-bar{padding:14px 28px;gap:14px;}
+ @media (max-width:768px){ .pg-bar{padding:10px 14px;gap:8px;} }
```

Use `!important` only when a *later* stylesheet rule would win (page `<style>`
blocks render after the shell's, so a shell rule targeting a page class needs
it). Never reach for `!important` to beat an inline style — move the property
out instead.

## The core rule

**Everything must fit 320px.** `document.documentElement.scrollWidth <=
window.innerWidth` at both 390 and 320, in every interactive state (drawer open,
dialog open, filter expanded).

Content that genuinely cannot narrow — wide tables, code blocks, kanban lanes,
timeline grids — **scrolls inside its own container**, it does not widen the
page. Wrap it in `.us-scroll-x`. Reflow a table to stacked cards instead when
scrolling would break the page's workflow (e.g. a row's action buttons would
sit off-screen).

Fixed pixel widths on cards, dialogs, drawers and popovers become
`min(<px>, calc(100vw - <margins>))` or `100%`.

## Shared utility classes

Available in **both** shells (`ADMIN_BASE_CSS` and `PublicLayout`'s `css`), so
they work on admin and public pages alike.

| Class | What it does | Use it for |
|---|---|---|
| `.us-scroll-x` | `overflow-x:auto; -webkit-overflow-scrolling:touch; max-width:100%` — at all widths | The wrapper around any wide table, code block or lane row |
| `.us-desktop-only` | `display:none` below 768px | Chrome that has no room on a phone (a secondary column, a hint line) |
| `.us-mobile-only` | Hidden above 768px, shown below | A phone-only affordance (e.g. a "Filters" toggle standing in for a sidebar) |
| `.us-drawer-panel` | Already on every side drawer; forced to `width:100vw` below 768px | Nothing to do — just keep the class on new drawers |

Both visibility helpers resolve to `display:revert` when shown, so **put them on
elements that do not set `display` inline**. If the element needs `flex` or
`grid` when visible, set that in your page-scoped class, not inline.

`.us-scroll-x` needs a real width limit to work: its parent must not be a flex
or grid item that sizes to content. Add `min-width:0` to the parent when the
scroll box refuses to shrink.

## Automatic rules (nothing to do)

Below 768px the shells already apply these — do not re-declare them:

- **`input, textarea, select` → `font-size:16px`.** Anything under 16px makes
  iOS Safari zoom the page on focus. This overrides your inline font sizes on
  purpose. Dense inline-styled inputs will grow on a phone; adjust the
  surrounding layout, do not fight the rule.
- **Side drawers (`.us-drawer-panel`) go full width** (`100vw`), and their
  `--band-x` inner padding drops to 16px. The drawer header's expand button
  becomes a no-op; it is left visible and harmless.
- **Toasts** cap at `calc(100vw - 32px)`.
- **The sandbox "Viewing as…" chip** and its menu fit 320px.

## The admin shell and the burger

`AdminLayout` renders `<div class="us-shell" data-nav-shell>` with a
`.us-navscrim`, the `<nav id="us-sidenav" class="us-sidenav" data-nav-panel>`,
and `<main>` containing `<header class="us-adminhead">`.

Below 768px the grid collapses to one column and the sidebar becomes an overlay
drawer: `min(80vw,300px)` wide, full height, its own dim scrim, scrolling
internally with the logo pinned at the top and the user/sign-out block at the
bottom. The header grows a `.us-burger` button as its first child.

State is a single attribute — `[data-nav-open]` on `.us-shell` — flipped by
`ui.js` (`data-nav-toggle` / `data-nav-close`). Desktop runs no JS at all.
It closes on: the burger again, the scrim, the drawer's ✕, `Escape` (focus
returns to the burger), tapping any nav link, a bfcache restore, and crossing
back above 768px. Focus moves into the drawer on open and `Tab` is trapped
inside it.

**Do not** reuse `data-toggle` for a page's own overlay drawer — it closes on
any outside click, which fights a scrim, and it flips `[hidden]`. Follow the
`data-nav-toggle` delegate in `ui.js` instead.

### Header

`.us-adminhead` wraps below 768px. Row one is the burger plus the event picker
(or `headerTitle`); **`headerActions` drops to a full row of its own**,
right-aligned, wrapping internally. So: keep `headerActions` to a small number
of short buttons — three compact buttons fit 320px, a toolbar does not. Move
anything bigger into the page body.

The event name and its meta line ellipsize; the `#event-picker` menu narrows to
`min(360px, 100vw - 28px)` and anchors to the right edge.

## Touch

- **HTML5 drag-and-drop does not fire on iOS or Android.** `dragstart` /
  `dragover` / `drop` are desktop-only. Any page that reorders or moves things by
  dragging needs a second path: pointer-event dragging (`pointerdown` +
  `setPointerCapture` + `pointermove`), or explicit move controls (↑/↓ buttons, a
  "Move to…" menu). Keep the desktop DnD; add the touch path alongside it.
- **No hover-only affordances.** Anything revealed by `:hover` needs a tap path
  — show it always on mobile, or put it behind a tap.
- **~40px hit area** for real actions (padding counts). The burger and drawer
  close button are both 40×40; match that.
- **Fixed elements** (toasts, chips, pickers) stay on screen and must not
  permanently cover a primary action.

## Text

- No 9px body copy on a phone. Mono labels at 9–10px are fine as *labels*; body
  text should stay ≥ 12.5px.
- Long unbroken strings — emails, URLs, tokens, slugs — wrap
  (`overflow-wrap:anywhere`) or ellipsize (`white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis` on a `min-width:0` box). They must never stretch the
  page.

## Checking your work

Verify at 390×844, 320×568, **and 1280×900** (desktop unchanged — your media
queries must not leak). On every page and every interactive state:

```js
({p:location.pathname, sw:document.documentElement.scrollWidth,
  iw:window.innerWidth, ok:document.documentElement.scrollWidth<=window.innerWidth})
```

One caveat when driving headless Chrome: when a page overflows, Chrome zooms out
to fit, which inflates `window.innerWidth` and makes the check above pass
anyway. If `innerWidth` is larger than the width you emulated, **the page is
overflowing** — measure the offending element's `getBoundingClientRect().right`
against the emulated width instead.

Take screenshots and look at them. Exercise the real flows — open the drawers,
submit the forms, run the searches — not just page loads.
