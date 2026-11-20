import { chromium, test as base, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

const EXT = path.resolve('.output/chrome-mv3');
/** Demo runs (store assets, gallery) use real-looking https hosts and render at 2×. */
const DEMO = !!(process.env.STORE_ASSETS || process.env.GALLERY);

/** Page titles by "host/path?query", for tests that want realistic tabs. */
export const fakeTitles = new Map<string, string>();

/** Fake web: every http:// host resolves to a local server that titles pages "host/path" (or `?title=`). */
function startFakeWeb(): Promise<Server> {
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const given = new URL(req.url ?? '/', 'http://x').searchParams.get('title');
    const title = (given ?? fakeTitles.get(`${req.headers.host}${req.url}`) ?? `${req.headers.host}${req.url}`).replace(/[<>&]/g, '');
    if (req.url === '/favicon.svg') {
      // A coloured letter per host, so screenshots have recognisable favicons.
      const host = req.headers.host ?? 'x';
      const hue = [...host].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
      const letter = host.replace(/^www\./, '')[0]!.toUpperCase();
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="hsl(${hue} 65% 48%)"/><text x="16" y="22.5" font-family="Arial,sans-serif" font-weight="700" font-size="18" fill="#fff" text-anchor="middle">${letter}</text></svg>`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><link rel="icon" href="/favicon.svg"><title>${title}</title><h1>${title}</h1>`);
  };
  // Store screenshots use real-looking hosts, many of which Chrome forces to https (HSTS preload).
  const server = DEMO ? createHttpsServer(selfSignedCert(), handler) : createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function selfSignedCert() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pwi-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=fake', '-keyout', `${dir}/key.pem`, '-out', `${dir}/cert.pem`], { stdio: 'ignore' });
  return { key: readFileSync(`${dir}/key.pem`), cert: readFileSync(`${dir}/cert.pem`) };
}

export const test = base.extend<{ context: BrowserContext; sw: Worker; extId: string; ext: Page }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const web = await startFakeWeb();
    const port = (web.address() as AddressInfo).port;
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: !process.env.HEADED,
      deviceScaleFactor: DEMO ? 2 : undefined,
      ignoreHTTPSErrors: DEMO,
      args: [
        `--disable-extensions-except=${EXT}`,
        `--load-extension=${EXT}`,
        `--host-resolver-rules=MAP * 127.0.0.1:${port}, EXCLUDE localhost`,
        ...(DEMO ? ['--ignore-certificate-errors', '--disable-features=CaptivePortalDetection'] : []),
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
