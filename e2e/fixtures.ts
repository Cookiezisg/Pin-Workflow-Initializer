import { chromium, test as base, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

const EXT = path.resolve('.output/chrome-mv3');

/** Fake web: every http:// host resolves to a local server that titles pages "host/path". */
function startFakeWeb(): Promise<Server> {
  const server = createServer((req, res) => {
    const title = `${req.headers.host}${req.url}`.replace(/[<>&]/g, '');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>${title}</title><h1>${title}</h1>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

export const test = base.extend<{ context: BrowserContext; sw: Worker; extId: string; ext: Page }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const web = await startFakeWeb();
    const port = (web.address() as AddressInfo).port;
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: !process.env.HEADED,
      args: [
        `--disable-extensions-except=${EXT}`,
        `--load-extension=${EXT}`,
        `--host-resolver-rules=MAP * 127.0.0.1:${port}, EXCLUDE localhost`,
      ],
    });
    await use(context);
    await context.close();
    web.close();
  },
  sw: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(sw);
  },
  extId: async ({ sw }, use) => use(new URL(sw.url()).host),
  /** An extension page we can run chrome.* and RPC calls from. */
  ext: async ({ context, extId, sw }, use) => {
    // Wait for first-run initialisation.
    await sw.evaluate(async () => {
      for (let i = 0; i < 50; i++) {
        const s = await chrome.storage.sync.get('ws:index');
        if ((s['ws:index'] as string[] | undefined)?.length) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('extension did not initialise');
    });
    // Drive the extension from a popup-type window: the engine only manages normal windows, so the
    // controller page is never tidied away by the actions under test.
    const pagePromise = context.waitForEvent('page', (p) => p.url().includes('/blocked.html?controller'));
    await sw.evaluate((url) => chrome.windows.create({ type: 'popup', url, focused: false }), `chrome-extension://${extId}/blocked.html?controller`);
    const page = await pagePromise;
    await page.waitForLoadState();
    await use(page);
  },
});

export const expect = test.expect;

export type Strip = { url: string; pinned: boolean; group: string | null; active: boolean }[];

/** Tab strip of the window `page` lives in, minus extension pages we opened ourselves. */
export async function strip(page: Page): Promise<Strip> {
  return page.evaluate(async () => {
    const win = await chrome.windows.getLastFocused({ populate: true, windowTypes: ['normal'] });
    const groups = await chrome.tabGroups.query({ windowId: win.id });
    return (win.tabs ?? [])
      .map((t) => ({
        url: t.url || t.pendingUrl || '',
        pinned: t.pinned,
        group: groups.find((g) => g.id === t.groupId)?.title ?? null,
        active: t.active,
      }));
  });
}

export async function rpc<T = unknown>(page: Page, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await page.evaluate(([rpc, a]) => chrome.runtime.sendMessage({ rpc, args: a }), [name, args] as const);
  const r = res as { ok: boolean; result?: T; error?: string };
  if (!r.ok) throw new Error(r.error);
  return r.result as T;
}
