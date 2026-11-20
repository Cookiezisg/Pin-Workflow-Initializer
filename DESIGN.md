# Design

**One rule: it should feel like part of Chrome.** This is a tool. Nobody should notice the design; they
should only notice that it is comfortable. When unsure, copy what Chrome itself does — the tab search
popup, the side panel (Reading list, Bookmarks), `chrome://settings`, tab group chips — and don't invent.

## Reference surfaces

| Our surface | Behave and look like |
|---|---|
| Command palette (popup) | Chrome's Tab search (`⌘⇧A`): search field on top, flat list, favicon + title + secondary line, close on hover |
| Side panel | Chrome's Reading list / Bookmarks side panel: flat list, section headings in sentence case, actions on hover or in a `⋮` menu |
| Settings (options page) | `chrome://settings`: left nav, cards of rows separated by hairlines, toggle on the right of each row, pill buttons |
| Workspaces | Tab group chips: a colour and a name. No emoji. |

## Tokens

Google Material 3 baseline (the palette Chrome, Gmail and Drive share). Light / dark:

| Token | Light | Dark | Use |
|---|---|---|---|
| `--surface` | `#FFFFFF` | `#1F1F1F` | page background, side panel, popup |
| `--surface-1` | `#F8FAFD` | `#1B1B1B` | settings page background |
| `--surface-2` | `#F0F4F9` | `#282A2C` | search fields, hover on surface-1 |
| `--surface-3` | `#E9EEF6` | `#333537` | pressed |
| `--text` | `#1F1F1F` | `#E3E3E3` | primary text |
| `--text-2` | `#474747` | `#C4C7C5` | secondary text, icons |
| `--text-3` | `#747775` | `#8E918F` | hints, timestamps |
| `--divider` | `#E1E3E1` | `#444746` | hairlines |
| `--primary` | `#0B57D0` | `#A8C7FA` | the one action colour: primary button, focus ring, links, selected state |
| `--on-primary` | `#FFFFFF` | `#062E6F` | text on primary |
| `--primary-container` | `#D3E3FD` | `#004A77` | selected row / selected nav item |
| `--hover` | `rgb(31 31 31 / 6%)` | `rgb(227 227 227 / 8%)` | hover overlay on any row/button |
| `--danger` | `#B3261E` | `#F2B8B5` | destructive text only |

Tab group colours are Chrome's own and appear **only** where they mean a Chrome tab group or a workspace's colour.

The extension icon's red is brand only (icon, store art). It never appears in the UI.

## Type

System UI font (what Chrome's own UI uses). Four sizes, no others:

- 13px / 20px — body, list rows, buttons
- 12px / 16px — secondary lines, timestamps, hints
- 15px / 20px, 500 — section titles in settings, panel title
- 11px / 16px, 500 — section headings in lists (sentence case, `--text-2`). **Never uppercase.**

Weights: 400 and 500 only. No bold.

## Shape and space

- 4px grid. List rows 36px (side panel, palette: 44px with a secondary line). Settings rows 48px+.
- Radius: 8px rows and fields, 12px cards and menus, 999px buttons and chips (Chrome's pill buttons).
- No shadows on things that sit on the page. Shadows only on things that float: menus, toasts.
- No coloured borders, no stripes, no accent bars, no gradients.
- Cards exist only on the settings page, white on `--surface-1`, like `chrome://settings`.
  Everywhere else content sits directly on the surface.

## Icons

Material Symbols Outlined (Apache-2.0), 20px in lists and toolbars, `--text-2`. The same set Chrome uses.
No emoji anywhere in UI chrome. No sparkle icon for AI.

## Interaction

- **Hover reveals.** Row actions (close, archive, move) appear on hover/focus, like Chrome's tab search.
- **One primary button per view, at most.** Everything else is a text button, an icon button or a `⋮` menu.
- **Undo instead of confirm.** Act immediately, then show a toast with *Undo* (like Chrome's "Tab closed – Undo").
  Confirmation only for permanent deletion.
- **Keyboard first.** ↑/↓ move, Enter acts, Esc closes, every action reachable from the palette.
  Focus ring: 2px `--primary`, offset 2px, only for keyboard focus (`:focus-visible`).
- **No explanations in the UI.** No "Tip:" lines, no paragraphs under buttons. If a control needs one, change the control.
  Settings rows may have one short secondary line, like `chrome://settings`.
- **Calm motion.** 150ms fades and expands. Nothing bounces, slides in from far away or pulses.
- **Empty states**: one short line in `--text-3`, centred. No illustrations.

## Copy

Chrome's voice: plain, short, sentence case. "Archive tab", not "Archive this tab!". No exclamation marks,
no "Nice.", no emoji.
