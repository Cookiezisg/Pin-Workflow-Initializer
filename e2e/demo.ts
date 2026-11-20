/** Realistic demo data for store screenshots and the UI preview gallery. */
import type { BrowserContext, Page } from '@playwright/test';
import { expect, fakeTitles, rpc, strip } from './fixtures';

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

export async function setup(ext: Page) {
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

export const shot = async (page: Page) => {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200);
  return `data:image/png;base64,${(await page.screenshot()).toString('base64')}`;
};

/** The side panel normally belongs to a browser window; opened as a page it should still look at the main window. */
export async function patchSidePanelWindow(context: BrowserContext) {
  await context.addInitScript(() => {
    if (location.pathname.endsWith('/sidepanel.html')) {
      chrome.windows.getCurrent = (() => chrome.windows.getLastFocused({ windowTypes: ['normal'] })) as typeof chrome.windows.getCurrent;
    }
  });
}
