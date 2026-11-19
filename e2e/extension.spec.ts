import { expect, rpc, strip, test } from './fixtures';

const PINS = ['http://mail.test/inbox', 'http://cal.test/week', 'http://docs.test/'];

test.beforeEach(async ({ ext }) => {
  // Point the default "Work" workspace at our fake sites and start from a known window.
  await ext.evaluate(async (pins) => {
    const index = (await chrome.storage.sync.get('ws:index'))['ws:index'] as string[];
    const key = `ws:${index[0]}`;
    const ws = (await chrome.storage.sync.get(key))[key] as Record<string, unknown>;
    await chrome.storage.sync.set({ [key]: { ...ws, pins: pins.map((url, i) => ({ id: `p${i}`, url })), otherWindows: 'archive' } });
    await chrome.storage.local.set({ state: { activeWorkspaceId: index[0], lastFired: {} } });
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    const old = (await chrome.tabs.query({ windowId: win.id })).map((t) => t.id!);
    await chrome.tabs.create({ windowId: win.id, url: 'http://mail.test/inbox/thread-7', active: false });
    await chrome.tabs.create({ windowId: win.id, url: 'http://news.test/a', active: false });
    const g1 = await chrome.tabs.create({ windowId: win.id, url: 'http://pr.test/1', active: false });
    const g2 = await chrome.tabs.create({ windowId: win.id, url: 'http://pr.test/2', active: false });
    await chrome.tabs.create({ windowId: win.id, url: 'http://blog.test/post', active: true });
    const gid = await chrome.tabs.group({ tabIds: [g1.id!, g2.id!], createProperties: { windowId: win.id } });
    await chrome.tabGroups.update(gid, { title: 'Review', color: 'green' });
    await chrome.tabs.remove(old);
  }, PINS);
  await expect.poll(async () => (await strip(ext)).length).toBe(5);
});

test('initialize: reuses tabs, pins in order, archives clutter, keeps groups', async ({ ext }) => {
  const report = await rpc<{ errors: string[] }>(ext, 'apply');
  expect(report.errors).toEqual([]);
  const s = await strip(ext);
  expect(s.filter((t) => t.pinned).map((t) => t.url)).toEqual(['http://mail.test/inbox/thread-7', 'http://cal.test/week', 'http://docs.test/']);
  expect(s.filter((t) => t.group === 'Review').map((t) => t.url)).toEqual(['http://pr.test/1', 'http://pr.test/2']);
  expect(s.at(-1)).toMatchObject({ url: 'chrome://newtab/', active: true });
  expect(s).toHaveLength(6);
  const archived = await ext.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const req = indexedDB.open('pin-workflow');
        req.onsuccess = () => {
          const all = req.result.transaction('archive').objectStore('archive').getAll();
          all.onsuccess = () => resolve((all.result as { url: string }[]).map((a) => a.url).sort());
        };
      }),
  );
  expect(archived).toEqual(['http://blog.test/post', 'http://news.test/a']);

  // Idempotent: a second run changes nothing.
  const again = await rpc<{ summary: Record<string, number> }>(ext, 'apply');
  expect(again.summary).toMatchObject({ created: 0, moved: 0, archived: 0, closed: 0 });
});

test('undo brings everything back', async ({ ext }) => {
  const before = await strip(ext);
  await rpc(ext, 'apply');
  await rpc(ext, 'undo');
  await expect.poll(async () => (await strip(ext)).map((t) => [t.url, t.pinned, t.group])).toEqual(before.map((t) => [t.url, t.pinned, t.group]));
});

test('switching workspaces saves and lazily restores sessions', async ({ ext }) => {
  const ids = await ext.evaluate(async () => (await chrome.storage.sync.get('ws:index'))['ws:index'] as string[]);
  await rpc(ext, 'switchTo', { workspaceId: ids[1] });
  let s = await strip(ext);
  expect(s.map((t) => t.url)).toEqual(['chrome://newtab/']);

  await rpc(ext, 'switchTo', { workspaceId: ids[0] });
  s = await strip(ext);
  // The Gmail thread that was open becomes the Gmail pin rather than a duplicate.
  expect(s.filter((t) => t.pinned).map((t) => t.url)).toEqual(['http://mail.test/inbox/thread-7', 'http://cal.test/week', 'http://docs.test/']);
  const rest = s.filter((t) => !t.pinned);
  // The previously active tab loads for real; the others are placeholders until focused.
  expect(rest.find((t) => t.active)?.url).toBe('http://blog.test/post');
  // Others come back as lazy placeholders (headless Chrome reports every tab as visible, so they may
  // already have turned into the real page here; in a real window they wait until focused).
  const real = (u: string) => decodeURIComponent(u.replace(/^chrome-extension:.*suspended\.html\?url=([^&]*).*$/, '$1'));
  expect(rest.map((t) => [real(t.url), t.group])).toEqual([
    ['http://news.test/a', null],
    ['http://pr.test/1', 'Review'],
    ['http://pr.test/2', 'Review'],
    ['http://blog.test/post', null],
  ]);
  await expect.poll(async () => (await strip(ext)).every((t) => !t.url.includes('suspended.html')), { timeout: 10_000 }).toBe(true);
});

test('focus rule blocks distracting sites only in its workspace', async ({ ext, extId }) => {
  const ids = await ext.evaluate(async () => (await chrome.storage.sync.get('ws:index'))['ws:index'] as string[]);
  const openYoutube = () =>
    ext.evaluate(async () => {
      const t = await chrome.tabs.create({ url: 'http://www.youtube.com/watch?v=1', active: true });
      return t.id!;
    });
  const urlOf = (id: number) => ext.evaluate(async (i) => (await chrome.tabs.get(i)).url ?? '', id);

  const allowed = await openYoutube();
  await expect.poll(() => urlOf(allowed)).toContain('youtube.com');

  await rpc(ext, 'switchTo', { workspaceId: ids[1] }); // Focus
  const blocked = await openYoutube();
  await expect.poll(() => urlOf(blocked), { timeout: 10_000 }).toContain(`chrome-extension://${extId}/blocked.html`);
});

test('UI pages render without errors', async ({ context, extId, ext }) => {
  const errors: string[] = [];
  for (const path of ['popup.html', 'sidepanel.html', 'options.html#workspaces', 'options.html#rules', 'options.html#automation', 'options.html#ai', 'options.html#general', 'options.html#data']) {
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${path}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${path}: ${m.text()}`));
    await page.goto(`chrome-extension://${extId}/${path}`);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `test-results/ui-${path.replace(/[^a-z]/g, '-')}.png`, fullPage: true });
    await page.close();
  }
  void ext;
  expect(errors).toEqual([]);
});

test('command palette finds tabs and runs actions', async ({ context, extId, ext }) => {
  void ext;
  const page = await context.newPage();
  await page.setViewportSize({ width: 620, height: 480 });
  await page.goto(`chrome-extension://${extId}/popup.html`);
  await page.locator('.q').fill('pr 2');
  await expect(page.locator('.item').first()).toContainText('pr.test/2');
  await page.locator('.q').fill('>undo');
  await expect(page.locator('.item').first()).toContainText('Undo');
  await page.locator('.q').fill('');
  await page.screenshot({ path: 'test-results/ui-palette.png' });
});
