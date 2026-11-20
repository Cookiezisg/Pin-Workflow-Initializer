/**
 * UI preview gallery: every screen of the real extension, light and dark, on one local web page.
 * Run: npx wxt build && GALLERY=/some/dir npx playwright test gallery   → open /some/dir/index.html
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { patchSidePanelWindow, setup } from './demo';
import { rpc, test } from './fixtures';

const OUT = process.env.GALLERY ?? '';
test.skip(!OUT, 'set GALLERY=<output dir> to render the preview gallery');
test.setTimeout(180_000);

type Shot = { file: string; w: number; caption: string };
const sections: { title: string; note: string; shots: Shot[] }[] = [];
let current: Shot[] = [];
const section = (title: string, note: string) => {
  current = [];
  sections.push({ title, note, shots: current });
};

async function snap(page: Page, file: string, caption: string, fullPage = false) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${file}.png`, fullPage });
  current.push({ file: `${file}.png`, w: page.viewportSize()!.width, caption });
}

async function themed(page: Page, dark: boolean) {
  await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
}

test('gallery', async ({ context, extId, ext }) => {
  mkdirSync(OUT, { recursive: true });
  await patchSidePanelWindow(context);
  await setup(ext);
  const base = `chrome-extension://${extId}`;

  // ------------------------------------------------------------ palette
  section('Command palette', 'Opens from the toolbar icon or ⌥⇧K. Modelled on Chrome’s “Search tabs”.');
  for (const dark of [false, true]) {
    const p = await context.newPage();
    await themed(p, dark);
    await p.setViewportSize({ width: 560, height: 460 });
    await p.goto(`${base}/popup.html`);
    const mode = dark ? 'Dark' : 'Light';
    await snap(p, `palette-empty-${mode}`, `${mode} · just opened`);
    await p.locator('.q').fill('pull');
    await snap(p, `palette-query-${mode}`, `${mode} · searching “pull”`);
    await p.locator('.q').fill('>');
    await snap(p, `palette-actions-${mode}`, `${mode} · “>” lists actions`);
    await p.close();
  }

  // ------------------------------------------------------------ side panel
  section('Side panel', 'Opens with ⌥⇧S. Modelled on Chrome’s Reading list and Bookmarks panels.');
  for (const dark of [false, true]) {
    const mode = dark ? 'Dark' : 'Light';
    const p = await context.newPage();
    await themed(p, dark);
    await p.setViewportSize({ width: 360, height: 760 });
    await p.goto(`${base}/sidepanel.html`);
    await p.waitForTimeout(1000);
    await p.mouse.move(0, 0);
    await snap(p, `panel-window-${mode}`, `${mode} · this window`);
    await p.locator('.tabrow').nth(4).hover();
    await snap(p, `panel-hover-${mode}`, `${mode} · hovering a tab shows its actions`);
    await p.locator('.ws-picker').click();
    await snap(p, `panel-picker-${mode}`, `${mode} · workspace picker`);
    await p.keyboard.press('Escape');
    await p.locator('.toolbar .btn.icon').nth(1).click();
    await snap(p, `panel-menu-${mode}`, `${mode} · ⋮ more actions`);
    await p.keyboard.press('Escape');
    await p.close();
  }

  // ------------------------------------------------------------ settings
  section('Settings', 'Modelled on chrome://settings. Every change saves automatically.');
  const id = await ext.evaluate(async () => ((await chrome.storage.sync.get('ws:index'))['ws:index'] as string[])[0]!);
  const pages: [string, string][] = [
    ['workspaces', 'Workspaces'],
    [`workspaces/${id}`, 'Editing a workspace'],
    ['rules', 'Rules'],
    ['automation', 'Automation'],
    ['ai', 'AI (DeepSeek selected)'],
    ['general', 'General'],
    ['data', 'Data'],
  ];
  // Show the AI page with a provider chosen.
  await ext.evaluate(async () => {
    const s = (await chrome.storage.sync.get('settings')).settings as { ai: Record<string, unknown> };
    const index = (await chrome.storage.sync.get('ws:index'))['ws:index'] as string[];
    const settings = s as unknown as Record<string, any>;
    await chrome.storage.sync.set({
      settings: {
        ...settings,
        ai: { ...s.ai, provider: 'deepseek' },
        schedules: settings.schedules.length ? settings.schedules : [{ id: 'sc1', enabled: true, workspaceId: index[0], days: [1, 2, 3, 4, 5], time: '09:00' }],
        rules: [...settings.rules, { id: 'r-group', enabled: true, kind: 'glob', pattern: '*://github.com/*/pull/*', action: { type: 'group', title: 'Pull requests', color: 'green' }, workspaceIds: [] }],
      },
    });
  });
  for (const dark of [false, true]) {
    const mode = dark ? 'Dark' : 'Light';
    const p = await context.newPage();
    await themed(p, dark);
    await p.setViewportSize({ width: 1100, height: 760 });
    for (const [hash, name] of dark ? pages.slice(0, 3) : pages) {
      await p.goto(`${base}/options.html#${hash}`);
      await p.waitForTimeout(500);
      await snap(p, `settings-${hash.split('/')[0]}${hash.includes('/') ? '-edit' : ''}-${mode}`, `${mode} · ${name}`, true);
    }
    await p.close();
  }

  // ------------------------------------------------------------ after actions: toast, archive, timeline
  section('Undo, archive and timeline', 'Actions run immediately and offer Undo, like Chrome’s “Tab closed · Undo”.');
  await rpc(ext, 'apply');
  await ext.waitForTimeout(800);
  for (const dark of [false, true]) {
    const mode = dark ? 'Dark' : 'Light';
    const p = await context.newPage();
    await themed(p, dark);
    await p.setViewportSize({ width: 360, height: 640 });
    await p.goto(`${base}/sidepanel.html`);
    await p.waitForTimeout(1000);
    if (!dark) {
      // Initialize collapsed the groups; open the first one and archive a tab from it.
      await p.locator('.group-head').first().click();
      await p.waitForTimeout(500);
      const row = p.locator('.tabrow').first();
      await row.hover();
      await row.locator('.row-actions .btn').nth(1).click(); // Archive
      await p.waitForTimeout(600);
      await p.mouse.move(0, 0);
      await snap(p, `panel-toast-${mode}`, `${mode} · after archiving a tab: snackbar with Undo`);
    }
    await p.locator('.tab').nth(1).click();
    await p.mouse.move(0, 0);
    await snap(p, `panel-archive-${mode}`, `${mode} · archive`);
    await p.locator('.tab').nth(2).click();
    await p.locator('.snap .list-row').first().click();
    await p.mouse.move(0, 0);
    await snap(p, `panel-timeline-${mode}`, `${mode} · timeline, one moment expanded`);
    await p.close();
  }

  // ------------------------------------------------------------ interstitials
  section('Pages shown in a tab', 'A site blocked by a focus rule, and the placeholder that lazily restores a tab.');
  for (const dark of [false, true]) {
    const mode = dark ? 'Dark' : 'Light';
    const p = await context.newPage();
    await themed(p, dark);
    await p.setViewportSize({ width: 900, height: 560 });
    await p.goto(`${base}/blocked.html?url=${encodeURIComponent('https://youtube.com/')}&ws=Focus`);
    await snap(p, `blocked-${mode}`, `${mode} · blocked site`);
    await p.close();
  }

  writeFileSync(`${OUT}/index.html`, html());
});

function html(): string {
  const body = sections
    .map(
      (s) => `<section><h2>${s.title}</h2><p>${s.note}</p><div class="grid">${s.shots
        .map((x) => `<figure><img src="${x.file}" style="width:${x.w}px" loading="lazy"><figcaption>${x.caption}</figcaption></figure>`)
        .join('')}</div></section>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pin Workflow · UI preview</title>
<style>
  body{margin:0;font:14px/20px system-ui,-apple-system,sans-serif;color:#1f1f1f;background:#f8fafd}
  header{position:sticky;top:0;z-index:1;padding:16px 32px;background:#f8fafd;border-bottom:1px solid #e1e3e1}
  header h1{margin:0;font-size:20px;font-weight:400}
  nav{margin-top:8px;display:flex;gap:16px;flex-wrap:wrap}
  nav a{color:#0b57d0;text-decoration:none}
  section{padding:24px 32px 8px}
  h2{margin:0 0 4px;font-size:16px;font-weight:500}
  section>p{margin:0 0 16px;color:#474747}
  .grid{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start}
  figure{margin:0}
  img{display:block;max-width:calc(100vw - 64px);height:auto;border-radius:12px;border:1px solid #e1e3e1;box-shadow:0 1px 3px rgb(0 0 0/8%)}
  figcaption{margin-top:8px;color:#474747;font-size:12px}
</style></head><body>
<header><h1>Pin Workflow · UI preview</h1><nav>${sections.map((s, i) => `<a href="#s${i}">${s.title}</a>`).join('')}</nav></header>
${body.replace(/<section>/g, () => `<section id="s${sectionCounter++}">`)}
</body></html>`;
}
let sectionCounter = 0;
