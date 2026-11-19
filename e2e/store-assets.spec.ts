/**
 * Chrome Web Store screenshots (1280×800) and promo tile (440×280), rendered from the real extension.
 * Run: STORE_ASSETS=1 npx playwright test store-assets   → writes to store/
 */
import { mkdirSync, readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, fakeTitles, rpc, strip, test } from './fixtures';

test.skip(!process.env.STORE_ASSETS, 'set STORE_ASSETS=1 to render store assets');
test.setTimeout(120_000);

const OUT = 'store';
const u = (url: string, title: string) => (fakeTitles.set(url.replace(/^https?:\/\//, ''), title), url);

const PINS = [
  ['https://mail.google.com/mail/u/0/', 'Inbox (3) – you@company.com – Gmail'],
  ['https://calendar.google.com/calendar/r/week', 'Google Calendar – Week of Nov 17'],
  ['https://linear.app/acme/my-issues', 'My issues · Linear'],
];
const REVIEW = [
  ['https://github.com/acme/web/pull/1842', 'Fix session refresh on token expiry by mlee · Pull Request #1842'],
  ['https://github.com/acme/web/pull/1839', 'Add workspace export to settings · Pull Request #1839'],
  ['https://github.com/acme/web/actions/runs/9921', 'CI · acme/web · Run #9921'],
];
const LAUNCH = [
  ['https://docs.google.com/document/d/q4-launch', 'Q4 launch plan – Google Docs'],
  ['https://figma.com/file/onboarding-v3', 'Onboarding v3 – Figma'],
  ['https://notion.so/acme/launch-checklist', 'Launch checklist · Notion'],
];
const LOOSE = [
  ['https://developer.chrome.com/docs/extensions/reference/api/tabGroups', 'chrome.tabGroups | API | Chrome for Developers'],
  ['https://stackoverflow.com/questions/7731', 'How to debounce in TypeScript? - Stack Overflow'],
  ['https://news.ycombinator.com/item?id=4242', 'Show HN: A workspace engine for browser tabs | Hacker News'],
  ['https://youtube.com/watch?v=focus', 'Deep work: how to focus in a distracted world - YouTube'],
];
const ARCHIVED = [
  ['https://en.wikipedia.org/wiki/Reconciliation', 'Reconciliation - Wikipedia'],
  ['https://medium.com/@dev/tab-hygiene', 'Tab hygiene for people with 200 tabs | Medium'],
  ['https://twitter.com/home', 'Home / X'],
];

async function setup(ext: Page) {
  await ext.evaluate(async ({ pins, review, launch, loose, archived }) => {
    const index = (await chrome.storage.sync.get('ws:index'))['ws:index'] as string[];
    const key = `ws:${index[0]}`;
    const ws = (await chrome.storage.sync.get(key))[key] as Record<string, unknown>;
    await chrome.storage.sync.set({
      [key]: {
        ...ws,
        pins: pins.map(([url], i) => ({ id: `p${i}`, url })),
        groups: [{ id: 'g1', title: 'Review', color: 'green', collapsed: false, tabs: [] }],
        otherWindows: 'keep',
      },
    });
    // Two more workspaces for the switcher.
    const extra = [
      { id: 'ws-research', name: 'Research', icon: '🔬', color: 'purple' },
      { id: 'ws-side', name: 'Side project', icon: '🚀', color: 'orange' },
    ];
    for (const w of extra) {
      await chrome.storage.sync.set({ [`ws:${w.id}`]: { ...ws, ...w, pins: [], groups: [], ungrouped: 'keep', otherWindows: 'keep' } });
    }
    await chrome.storage.sync.set({ 'ws:index': [...index, ...extra.map((w) => w.id)] });
    await chrome.storage.local.set({ state: { activeWorkspaceId: index[0], lastFired: {} } });

    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    const old = (await chrome.tabs.query({ windowId: win.id })).map((t) => t.id!);
    const open = async (list: string[][], active = false) => {
      const ids: number[] = [];
      for (const [url] of list) ids.push((await chrome.tabs.create({ windowId: win.id, url, active }))!.id!);
      return ids;
    };
    for (const [url] of pins) await chrome.tabs.create({ windowId: win.id, url, pinned: true, active: false });
    const r = await open(review);
    const l = await open(launch);
    await open(loose);
    const toArchive = await open(archived);
    const g1: number = await chrome.tabs.group({ tabIds: r as [number, ...number[]], createProperties: { windowId: win.id } });
    await chrome.tabGroups.update(g1, { title: 'Review', color: 'green' });
    const g2: number = await chrome.tabs.group({ tabIds: l as [number, ...number[]], createProperties: { windowId: win.id } });
    await chrome.tabGroups.update(g2, { title: 'Launch', color: 'blue' });
    await chrome.tabs.update(r[0]!, { active: true });
    await chrome.tabs.remove(old);
    (globalThis as { toArchive?: number[] }).toArchive = toArchive;
  }, { pins: PINS.map(([a, b]) => [u(a!, b!)]), review: REVIEW.map(([a, b]) => [u(a!, b!)]), launch: LAUNCH.map(([a, b]) => [u(a!, b!)]), loose: LOOSE.map(([a, b]) => [u(a!, b!)]), archived: ARCHIVED.map(([a, b]) => [u(a!, b!)]) });
  await expect.poll(async () => (await strip(ext)).length).toBe(16);
  await ext.waitForTimeout(2500); // let pages load so favicons are cached
  const ids = await ext.evaluate(() => (globalThis as { toArchive?: number[] }).toArchive!);
  await rpc(ext, 'archiveTabs', { tabIds: ids });
  await rpc(ext, 'snapshot', { label: 'Before the launch review' });
}

const shot = async (page: Page) => `data:image/png;base64,${(await page.screenshot()).toString('base64')}`;
const icon = `data:image/svg+xml;base64,${Buffer.from(readFileSync('assets/icon.svg')).toString('base64')}`;

const FRAME_CSS = `
  *{box-sizing:border-box;margin:0}
  body{width:1280px;height:800px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;background:#fff;color:#1f2328;display:flex;align-items:center;gap:56px;padding:0 72px}
  .copy{flex:0 0 400px}
  .brand{display:flex;align-items:center;gap:10px;font-weight:600;font-size:16px;color:#5f6368;margin-bottom:28px}
  .brand img{width:28px;height:28px}
  h1{font-size:44px;line-height:1.12;letter-spacing:-.02em;font-weight:700}
  h1 em{font-style:normal;color:#EA4335}
  p{margin-top:20px;font-size:19px;line-height:1.5;color:#5f6368}
  kbd{font:600 15px ui-monospace,Menlo,monospace;border:1px solid #dadce0;border-bottom-width:2px;border-radius:6px;padding:2px 7px;color:#3c4043;background:#f8f9fa}
  .stage{flex:1;display:flex;justify-content:center;align-items:center;gap:24px;height:100%}
  .ui{border-radius:14px;box-shadow:0 1px 2px rgba(0,0,0,.06),0 12px 40px rgba(60,64,67,.18);border:1px solid #e3e5e8;overflow:hidden;background:#fff}
  .ui img{display:block}
`;

async function frame(page: Page, name: string, title: string, sub: string, images: { src: string; w: number }[]) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.setContent(`<style>${FRAME_CSS}</style>
    <div class="copy"><div class="brand"><img src="${icon}">Pin Workflow Initializer</div><h1>${title}</h1><p>${sub}</p></div>
    <div class="stage">${images.map((i) => `<div class="ui"><img src="${i.src}" style="width:${i.w}px"></div>`).join('')}</div>`);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}/${name}.png`, scale: 'css' });
}

test('store assets', async ({ context, extId, ext }) => {
  mkdirSync(OUT, { recursive: true });
  // The side panel normally belongs to a browser window; opened as a page it should still look at the main window.
  await context.addInitScript(() => {
    if (location.pathname.endsWith('/sidepanel.html')) {
      chrome.windows.getCurrent = (() => chrome.windows.getLastFocused({ windowTypes: ['normal'] })) as typeof chrome.windows.getCurrent;
    }
  });
  await setup(ext);
  const base = `chrome-extension://${extId}`;

  // 1. Palette
  const palette = await context.newPage();
  await palette.setViewportSize({ width: 620, height: 470 });
  await palette.goto(`${base}/popup.html`);
  await palette.locator('.q').fill('pull');
  await palette.waitForTimeout(600);
  const paletteImg = await shot(palette);
  await palette.close();

  // 2–4. Side panel views
  let panel = await context.newPage();
  await panel.setViewportSize({ width: 380, height: 690 });
  await panel.goto(`${base}/sidepanel.html`);
  await panel.waitForTimeout(1200);
  const nowImg = await shot(panel);
  await panel.close();
  // A few real actions so the timeline and archive have history (Initialize archives the loose tabs).
  await rpc(ext, 'apply');
  await ext.waitForTimeout(800);
  await rpc(ext, 'switchTo', { workspaceId: 'ws-research' });
  await ext.waitForTimeout(800);
  await rpc(ext, 'undo');
  await ext.waitForTimeout(1000);
  panel = await context.newPage();
  await panel.setViewportSize({ width: 380, height: 690 });
  await panel.goto(`${base}/sidepanel.html`);
  await panel.waitForTimeout(1200);
  await panel.locator('.tab').nth(2).click();
  await panel.waitForTimeout(600);
  const timelineImg = await shot(panel);
  await panel.locator('.tab').nth(1).click();
  await panel.waitForTimeout(600);
  const archiveImg = await shot(panel);
  await panel.close();

  // 5. Options: workspace editor
  const options = await context.newPage();
  await options.setViewportSize({ width: 1100, height: 720 });
  await options.goto(`${base}/options.html#workspaces`);
  await options.waitForTimeout(800);
  const optionsImg = await shot(options);
  await options.close();

  const canvas = await context.newPage();
  await frame(canvas, '1-palette', 'Find any tab in <em>one keystroke</em>', 'Fuzzy search across every window, every workspace and everything you ever archived. Press <kbd>⌥⇧K</kbd>, type, done.', [{ src: paletteImg, w: 620 }]);
  await frame(canvas, '2-initialize', 'One click. <em>Everything in its place.</em>', 'Your pins in exact order, preset groups rebuilt, clutter archived. Tabs that are already open are reused, so logins and drafts survive.', [{ src: nowImg, w: 380 }]);
  await frame(canvas, '3-workspaces', 'Switch between <em>whole setups</em>', 'Work, Research, Side project — each workspace remembers its own tabs and restores them lazily when you come back.', [{ src: optionsImg, w: 700 }]);
  await frame(canvas, '4-undo', '<em>Undo</em> anything. Lose nothing.', 'Every change is snapshotted first. Roll the whole browser back to any moment, or dig a tab out of the searchable archive.', [{ src: timelineImg, w: 330 }, { src: archiveImg, w: 330 }]);

  // Small promo tile 440×280
  await canvas.setViewportSize({ width: 440, height: 280 });
  await canvas.setContent(`<style>*{margin:0;box-sizing:border-box}body{width:440px;height:280px;background:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:#1f2328}
    img{width:88px;height:88px}h1{font-size:26px;letter-spacing:-.01em}p{font-size:15px;color:#5f6368}</style>
    <img src="${icon}"><h1>Pin Workflow Initializer</h1><p>Your tabs, one keystroke from order.</p>`);
  await canvas.screenshot({ path: `${OUT}/promo-small-440x280.png`, scale: 'css' });
});
