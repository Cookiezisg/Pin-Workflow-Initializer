# Pin Workflow Initializer

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/aphlkmbopbcnliomahcjeiiigoepponh?utm_source=item-share-cb)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-0F9D58)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)
![License](https://img.shields.io/badge/License-MIT-2EA44F)

**A workspace engine for Chrome.** Describe the tabs a workspace should have; one keystroke makes the
browser match it. Switch between complete tab setups in a second, undo anything, and find any tab you
ever had open.

> 中文简介：Chrome 的「工作区引擎」。声明每个工作区应该有哪些固定标签和分组，一键让浏览器收敛到这个状态；在多套工作区之间秒切，每套都记得自己打开过的标签页；每次操作前自动快照，随时撤销；命令面板模糊搜索所有标签页、工作区和归档；支持规则、定时切换、闲置归档和 AI 智能分组。

## What it does

| | |
|---|---|
| **Initialize** `⌥⇧C` | Converges the window to the workspace: pins in exact order, preset groups, clutter archived. Reuses tabs that are already open (logins, drafts and scroll position survive) and is idempotent. Press it ten times and you get the same result as pressing it once. |
| **Workspaces** | Several named setups (Work, Focus, Research…). Switching saves what's open as the old workspace's session and restores the new one's, lazily: background tabs load only when you look at them. |
| **Command palette** `⌥⇧K` | Fuzzy search over every open tab in every window, your workspaces, all actions and the archive. `>` actions, `@` workspaces, `#` archive. |
| **Timeline & undo** `⌥⇧Z` | Every change is snapshotted first. Undo the last action or restore the whole browser (all windows) to any earlier moment. |
| **Archive** | Nothing gets destroyed: tabs cleaned up, idle tabs and closed windows land in a searchable archive. |
| **Dry run** | Preview exactly what Initialize would do before it does it. |
| **Rules** | Per-URL rules: auto-group (`github.com/*/pull/*` → "PRs"), auto-pin, or block. Scope rules to workspaces for focus modes. |
| **Automation** | Schedules ("Work at 9:00 on weekdays"), idle-tab archiving, duplicate handling, re-pin on start-up, background snapshots. |
| **AI** (optional) | Smart grouping of loose tabs and a "Where was I?" recap. Runs on Chrome's on-device model, DeepSeek, Claude, or any OpenAI-compatible endpoint (including local Ollama). It previews the result before applying anything, and only sends titles and URLs (query strings are stripped). |
| **Side panel** `⌥⇧S` | Live dashboard: workspace switcher, window outline, send-tab-to-workspace, archive and timeline. |

English and 简体中文 UI, light and dark themes. Upgrading from 1.x migrates your pinned sites into a
"Main" workspace.

## How it works

```
src/
  core/        pure, unit-tested logic (no chrome.* here)
    plan.ts      the reconciler: (live window, target) → ordered ops
    targets.ts   workspace / session / snapshot → target
    match.ts     URL matching (scope, glob, /regex/, domain)
    fuzzy.ts     palette ranking
    rules.ts, schedule.ts, defaults.ts (+ v1 migration, import sanitising)
  engine/      side effects
    engine.ts    apply / switch / undo / restore / archive / merge…, serialised, snapshot-first
    executor.ts  runs plan ops against a BrowserApi
    chrome-api.ts, chrome-store.ts (storage.sync + storage.local + IndexedDB)
  entrypoints/ background, popup (palette), sidepanel, options, suspended (lazy tab), blocked
  lib/         rpc, ai, i18n
```

The core idea is reconciliation, the same pattern as React's diff or Terraform's plan/apply.
`plan(window, target)` matches existing tabs to the target's specs. The planner reuses every tab
it can and emits the minimum set of create/pin/move/group/archive ops. Creates always come before
closes, so a window is never emptied by accident. Because the planner is a pure function, a dry
run is just `plan()` without `execute()`, and undo is `plan()` toward a snapshot.

## Develop

```bash
npm install
npm run dev        # Chrome with the extension loaded and hot reload
npm test           # unit tests (planner, engine against a simulated tab strip, i18n coverage)
npm run e2e        # builds, then drives the real extension in Chromium via Playwright
npm run zip        # store-ready zip in .output/
```

The unit tests run the engine against `tests/fake-browser.ts`, a simulator that follows Chrome's
tab-strip rules: pinned tabs stay in front, groups stay contiguous, and closing the last tab closes
the window. Every scenario also checks that planning a second time produces no ops.

Load manually: `npm run build`, then `chrome://extensions` → Developer mode → Load unpacked →
`.output/chrome-mv3`.

## Release

Bump `version` in `package.json`, then push a tag `vX.Y.Z`. The release workflow builds and tests,
attaches the zip to a GitHub release, and submits it to the Chrome Web Store if these repository
secrets exist: `CHROME_EXTENSION_ID`, `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`,
`CHROME_REFRESH_TOKEN`.

## Privacy

Everything stays in your browser. Workspaces and settings sync through your Chrome account. Sessions,
snapshots and the archive stay on the device. API keys are stored locally and never synced or
exported. The only network calls are AI requests, which you have to switch on yourself, and they go
to the provider you choose.

## License

[MIT](LICENSE) © Sun Weilin
