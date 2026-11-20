/**
 * UI audit: every screen and state, in light and dark, English and Chinese, at narrow and wide sizes.
 * Fails on accessibility violations (axe), clipped or overflowing text, overlapping controls,
 * misaligned control heights, native select arrows, tiny hit targets, emoji/uppercase in UI chrome,
 * horizontal scrolling and console errors.
 *
 * Run: npx wxt build && AUDIT=1 npx playwright test audit      (report: test-results/ui-audit.json)
 */
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { patchSidePanelWindow, setup } from './demo';
import { expect, test } from './fixtures';

test.skip(!process.env.AUDIT, 'set AUDIT=1 to run the UI audit');
test.setTimeout(600_000);

interface Issue {
  screen: string;
  check: string;
  detail: string;
}

/** Layout checks that run inside the page. Returns human-readable problems. */
function layoutChecks(): { check: string; detail: string }[] {
  const out: { check: string; detail: string }[] = [];
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
  };
  const describe = (el: Element) => {
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 50);
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : '';
    const label = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '';
    return `<${el.tagName.toLowerCase()}${cls}> ${text || label}`.trim();
  };

  // Page must never scroll sideways.
  if (document.documentElement.scrollWidth > window.innerWidth + 1) {
    out.push({ check: 'horizontal-scroll', detail: `page is ${document.documentElement.scrollWidth}px wide in a ${window.innerWidth}px viewport` });
  }

  const all = [...document.querySelectorAll('body *')].filter(visible);

  // Text that overflows its box without an intentional ellipsis.
  for (const el of all) {
    if (!(el instanceof HTMLElement) || el.children.length > 0 && !el.matches('button, a, label, .btn')) continue;
    if (['INPUT', 'SELECT', 'TEXTAREA', 'svg', 'IMG'].includes(el.tagName)) continue;
    const cs = getComputedStyle(el);
    if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue;
    if (el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis') {
      out.push({ check: 'text-overflow', detail: `${describe(el)} (${el.scrollWidth}px content in ${el.clientWidth}px)` });
    }
    // Text pushed outside the viewport.
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth + 1 && el.textContent?.trim()) out.push({ check: 'offscreen', detail: describe(el) });
  }

  // Interactive controls that overlap each other.
  const controls = all.filter((el) => el.matches('button, a[href], input:not([type=hidden]), select, textarea, [role=switch], [role=tab]'));
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i]!, b = controls[j]!;
      if (a.contains(b) || b.contains(a)) continue;
      // Floating menus sit above the page on purpose.
      if (!!a.closest('.menu') !== !!b.closest('.menu')) continue;
      // Archive rows stack a favicon and a checkbox on purpose.
      if (a.closest('.lead') && b.closest('.lead') && a.closest('.lead') === b.closest('.lead')) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (ox > 2 && oy > 2) out.push({ check: 'overlap', detail: `${describe(a)}  ×  ${describe(b)}` });
    }
  }

  // Controls in one row should share a height (buttons vs fields vs selects).
  const rows = new Map<Element, Element[]>();
  for (const el of all.filter((e) => e.matches('.input, .select, .btn:not(.icon), .choice'))) {
    const p = el.parentElement!;
    if (getComputedStyle(p).display.includes('flex') && getComputedStyle(p).flexDirection.startsWith('row')) {
      rows.set(p, [...(rows.get(p) ?? []), el]);
    }
  }
  for (const [p, els] of rows) {
    const heights = [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().height)))];
    if (heights.length > 1) out.push({ check: 'row-heights', detail: `${describe(p).slice(0, 60)} → heights ${heights.join('/')}px` });
  }

  // Native select arrows look foreign; every select must use the custom one.
  for (const el of all.filter((e) => e.tagName === 'SELECT')) {
    if (getComputedStyle(el).appearance !== 'none') out.push({ check: 'native-select', detail: describe(el) });
  }

  // Hit targets: at least 24×24 (WCAG 2.2), except checkboxes/radios inside a clickable row.
  for (const el of controls) {
    if (el.matches('input[type=checkbox], input[type=radio]') && el.closest('label, .list-row')) continue;
    if (el.matches('input, select, textarea')) continue;
    // A row's title button only carries keyboard focus; the click target is the whole row.
    if (el.matches('.row-main')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 24) out.push({ check: 'hit-target', detail: `${describe(el)} is ${Math.round(r.width)}×${Math.round(r.height)}` });
  }

  // DESIGN.md: no uppercase labels, no emoji in UI chrome, no bold weights.
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.textTransform === 'uppercase') out.push({ check: 'uppercase', detail: describe(el) });
    if (Number(cs.fontWeight) > 500 && el.textContent?.trim() && !el.closest('mark')) out.push({ check: 'bold', detail: `${describe(el)} (${cs.fontWeight})` });
  }
  const emoji = /\p{Extended_Pictographic}/u;
  for (const el of all) {
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && emoji.test(n.textContent ?? '')) out.push({ check: 'emoji', detail: describe(el) });
    }
  }

  // Every icon-only button needs an accessible name (tooltip).
  for (const el of controls.filter((e) => e.matches('button') && !e.textContent?.trim())) {
    if (!el.getAttribute('title') && !el.getAttribute('aria-label')) out.push({ check: 'unnamed-button', detail: describe(el) });
  }
  return out;
}

const issues: Issue[] = [];

async function audit(page: Page, screen: string) {
  await page.waitForTimeout(300);
  for (const p of await page.evaluate(layoutChecks)) issues.push({ screen, ...p });
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']);
  // An open menu covers the page on purpose; target-size would report everything under it.
  if (await page.locator('.menu').count()) builder = builder.disableRules(['target-size']);
  const axe = await builder.analyze();
  for (const v of axe.violations) {
    for (const n of v.nodes.slice(0, 5)) issues.push({ screen, check: `axe:${v.id}`, detail: `${n.target.join(' ')} — ${n.failureSummary?.split('\n')[1]?.trim() ?? v.help}` });
  }
}

async function setPrefs(ext: Page, prefs: { locale: string; provider?: string }) {
  await ext.evaluate(async ({ locale, provider }) => {
    const s = (await chrome.storage.sync.get('settings')).settings as Record<string, any>;
    const index = (await chrome.storage.sync.get('ws:index'))['ws:index'] as string[];
    await chrome.storage.sync.set({
      settings: {
        ...s,
        locale,
        ai: { ...s.ai, provider: provider ?? s.ai.provider },
        schedules: s.schedules.length ? s.schedules : [{ id: 'sc1', enabled: true, workspaceId: index[0], days: [1, 2, 3, 4, 5], time: '09:00' }],
        rules: [
          ...s.rules,
          { id: 'r-group', enabled: true, kind: 'glob', pattern: '*://github.com/*/pull/*', action: { type: 'group', title: 'Pull requests', color: 'green' }, workspaceIds: [] },
        ].filter((r, i, a) => a.findIndex((x) => x.id === r.id) === i),
      },
    });
  }, prefs);
}

test('ui audit', async ({ context, extId, ext }) => {
  const errors: string[] = [];
  context.on('weberror', (e) => errors.push(e.error().message));
  await patchSidePanelWindow(context);
  await setup(ext);
  const base = `chrome-extension://${extId}`;
  const wsId = await ext.evaluate(async () => ((await chrome.storage.sync.get('ws:index'))['ws:index'] as string[])[0]!);

  for (const locale of ['en', 'zh']) {
    for (const dark of [false, true]) {
      const tag = `${locale}/${dark ? 'dark' : 'light'}`;
      const page = await context.newPage();
      page.on('console', (m) => m.type() === 'error' && errors.push(`${tag}: ${m.text()}`));
      await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });

      // Palette
      await setPrefs(ext, { locale, provider: 'deepseek' });
      await page.setViewportSize({ width: 560, height: 460 });
      await page.goto(`${base}/popup.html`);
      await audit(page, `${tag} palette`);
      await page.locator('.q').fill('pull');
      await audit(page, `${tag} palette: search`);
      await page.locator('.q').fill('>');
      await audit(page, `${tag} palette: actions`);

      // Side panel at Chrome's narrowest and a wide width
      for (const width of [320, 480]) {
        const s = `${tag} panel@${width}`;
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`${base}/sidepanel.html`);
        await page.waitForTimeout(800);
        await audit(page, `${s} window`);
        await page.locator('.tabrow').nth(3).hover();
        await audit(page, `${s} row hover`);
        await page.locator('.ws-picker').click();
        await audit(page, `${s} workspace menu`);
        await page.keyboard.press('Escape');
        await page.locator('.toolbar .btn.icon').nth(1).click();
        await audit(page, `${s} more menu`);
        await page.keyboard.press('Escape');
        await page.locator('.tab').nth(1).click();
        await audit(page, `${s} archive`);
        await page.locator('.tab').nth(2).click();
        await page.locator('.snap .list-row').first().click();
        await audit(page, `${s} timeline`);
      }

      // Settings: every section, the workspace editor with custom matching open, every AI provider
      for (const width of [1280, 760]) {
        await page.setViewportSize({ width, height: 900 });
        for (const hash of ['workspaces', `workspaces/${wsId}`, 'rules', 'automation', 'ai', 'general', 'data', 'welcome']) {
          await page.goto(`${base}/options.html#${hash}`);
          await page.waitForTimeout(400);
          await audit(page, `${tag} settings@${width} #${hash.split('/')[0]}${hash.includes('/') ? '/edit' : ''}`);
        }
        await page.goto(`${base}/options.html#workspaces/${wsId}`);
        await page.locator('.setting-row .menu-anchor .btn').first().click();
        await audit(page, `${tag} settings@${width} pin menu`);
        await page.getByRole('menuitem').nth(2).click();
        await audit(page, `${tag} settings@${width} custom matching`);
        for (const provider of ['anthropic', 'openai', 'builtin']) {
          await setPrefs(ext, { locale, provider });
          await page.goto(`${base}/options.html#ai`);
          await audit(page, `${tag} settings@${width} ai:${provider}`);
        }
        await setPrefs(ext, { locale, provider: 'deepseek' });
      }

      // Interstitials
      await page.setViewportSize({ width: 900, height: 600 });
      await page.goto(`${base}/blocked.html?url=${encodeURIComponent('https://youtube.com/')}&ws=Focus`);
      await audit(page, `${tag} blocked page`);
      await page.goto(`${base}/suspended.html?url=${encodeURIComponent('about:blank')}&title=${encodeURIComponent('A long page title that should wrap nicely')}`);
      await audit(page, `${tag} placeholder page`);
      await page.close();
    }
  }

  for (const e of errors) issues.push({ screen: 'console', check: 'error', detail: e });
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/ui-audit.json', JSON.stringify(issues, null, 2));
  const summary = Object.entries(issues.reduce<Record<string, number>>((m, i) => ((m[i.check] = (m[i.check] ?? 0) + 1), m), {}));
  console.log(`UI audit: ${issues.length} issues`, summary);
  expect(issues, 'see test-results/ui-audit.json').toEqual([]);
});
