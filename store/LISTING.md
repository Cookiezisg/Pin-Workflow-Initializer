# Chrome Web Store listing — copy/paste source

Images in this folder: `1-palette.png`, `2-initialize.png`, `3-workspaces.png`, `4-undo.png` (1280×800 screenshots),
`promo-small-440x280.png` (small promo tile), and `public/icon-128.png` (store icon).
Regenerate with `npx wxt build && STORE_ASSETS=1 npx playwright test store-assets`.

## Category

Workflow & Planning

## Description

Pin Workflow Initializer turns your tabs into workspaces. Describe the tabs a workspace should have, and one keystroke makes the browser match it: pins in exact order, groups rebuilt, clutter archived.

★ Initialize (Alt+Shift+C)
Converges the window to your workspace. Tabs that are already open are reused, so logins, drafts and scroll position survive. Press it ten times and you get the same result as pressing it once.

★ Workspaces
Keep several complete setups: Work, Research, Side project… Switching saves what's open as the old workspace's session and restores the new one. Background tabs load only when you look at them.

★ Command palette (Alt+Shift+K)
Fuzzy search over every open tab in every window, your workspaces, all actions and the archive. Type > for actions, @ for workspaces, # for the archive.

★ Timeline & undo (Alt+Shift+Z)
Every change is snapshotted first. Undo the last action, or roll the whole browser back to any earlier moment.

★ Archive
Nothing gets destroyed. Cleaned-up tabs, idle tabs and closed windows land in a searchable archive.

★ Rules & automation
Auto-group (github.com/*/pull/* → "PRs"), auto-pin, or block sites per workspace for focus modes. Schedules ("Work at 9:00 on weekdays"), idle-tab archiving, duplicate handling, re-pin on start-up.

★ AI (optional, off by default)
Smart grouping of loose tabs and a "Where was I?" recap. Runs on Chrome's on-device model, DeepSeek, Claude, or any OpenAI-compatible endpoint with your own key. You see a preview before anything is applied.

★ Side panel (Alt+Shift+S)
A live dashboard: workspace switcher, window outline, send a tab to another workspace, archive and timeline.

Private by design: everything stays in your browser. Workspaces and settings sync through your Chrome account; sessions, snapshots and the archive stay on the device. No accounts, no analytics. The only network requests are AI requests, and only if you turn AI on.

English and 简体中文. Light and dark themes. Upgrading from 1.x keeps your pinned sites as a "Main" workspace.

Open source: https://github.com/Cookiezisg/Pin-Workflow-Initializer

## Privacy tab

### Single purpose

Organize the browser's tabs into user-defined workspaces: open, pin, group, archive and restore tabs so a window matches the workspace the user chose.

### Permission justifications

- **tabs**: Read the URL and title of open tabs to match them against the user's workspace, and create, move, pin and close tabs when the user applies or switches a workspace. Also powers the tab search in the command palette.
- **tabGroups**: Create, rename, recolor, collapse and reorder tab groups that belong to a workspace or a grouping rule.
- **storage**: Save the user's workspaces and settings (synced through their Chrome account) and per-device session state.
- **unlimitedStorage**: Keep the local snapshot history (for undo) and the archive of cleaned-up tabs, which can exceed the default quota.
- **alarms**: Run user-defined schedules (e.g. switch to "Work" at 9:00), idle-tab archiving and periodic background snapshots.
- **sidePanel**: Show the extension's side panel dashboard.
- **notifications**: Tell the user when a scheduled switch or idle archiving ran in the background, so changes are never silent. Can be turned off in settings.
- **favicon**: Show site icons next to tabs in the command palette, side panel and archive.
- **Optional host permissions** (`https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`): Requested at runtime only when the user turns on an AI provider, and only for that provider's API host (e.g. api.deepseek.com, or a local model server), so the extension can send the request.

### Remote code

No, I am not using remote code. (All code is in the package; AI providers return JSON data only.)

### Data usage

Check: **Web history** (tab URLs and titles are read locally; when the user turns on an AI provider, titles and URLs with query strings stripped are sent to that provider to produce groupings or a summary).

Certify all three:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

### Privacy policy URL

https://github.com/Cookiezisg/Pin-Workflow-Initializer#privacy
