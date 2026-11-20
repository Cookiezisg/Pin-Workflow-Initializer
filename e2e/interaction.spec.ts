/**
 * Interaction audit: the UI must *behave* like Chrome, not only look like it.
 * Run: npx wxt build && AUDIT=1 npx playwright test interaction   → test-results/interaction-audit.json
 *
 * Generic checks on every screen:
 *   mouse-only   — something looks clickable (pointer cursor) but the keyboard cannot reach it
 *   no-focus     — a control reached with Tab shows no focus indicator
 *   no-hover     — a control gives no visual response to the mouse
 *   disabled-ptr — a disabled control still shows the pointer cursor
 * Behaviour checks: menus, tabs, palette and number fields follow the platform keyboard model.
 */
import { expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { patchSidePanelWindow, setup } from './demo';
import { test } from './fixtures';

test.skip(!process.env.AUDIT, 'set AUDIT=1 to run the interaction audit');
test.setTimeout(300_000);
test.use({ actionTimeout: 5000 });

type Issue = { screen: string; check: string; detail: string };
const issues: Issue[] = [];
const fail = (screen: string, check: string, detail: string) => issues.push({ screen, check, detail });

const FOCUSABLE = 'button:not(:disabled), a[href], input:not([type=hidden]):not(:disabled), select:not(:disabled), textarea, [tabindex]:not([tabindex="-1"])';

/** Static checks that need no input. */
function staticChecks(FOCUSABLE: string) {
  const out: { check: string; detail: string }[] = [];
  const describe = (el: Element) => `<${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}> ${(el.textContent ?? '').trim().slice(0, 30)}`;
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden';
  };
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.cursor === 'pointer') {
      const reachable = el.closest(`${FOCUSABLE}, label`) || el.querySelector('input, button');
      // Only report the outermost element of a pointer region.
      const parentPointer = el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer';
      if (!reachable && !parentPointer) out.push({ check: 'mouse-only', detail: describe(el) });
    }
    if ((el as HTMLButtonElement).disabled && cs.cursor === 'pointer') out.push({ check: 'disabled-ptr', detail: describe(el) });
  }
  return out;
}

const styleOf = (page: Page, sel: string, i: number) =>
  page.locator(sel).nth(i).evaluate((el) => {
    const cs = getComputedStyle(el);
    const b = getComputedStyle(el, '::before');
    const a = getComputedStyle(el, '::after');
    return [cs.backgroundColor, cs.color, cs.boxShadow, cs.borderColor, cs.outlineStyle + cs.outlineWidth + cs.outlineColor, cs.textDecorationLine, b.backgroundColor, b.borderColor, a.boxShadow].join('|');
  });

async function screen(page: Page, name: string) {
  await page.waitForTimeout(300);
  for (const i of await page.evaluate(staticChecks, FOCUSABLE)) fail(name, i.check, i.detail);

  // Focus: Tab through the page; every stop must look different from its unfocused self.
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const seen = new Set<string>();
  for (let n = 0; n < 60; n++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const sig = el.outerHTML.slice(0, 200);
      const look = () =>
        [el, el.parentElement]
          .filter((x): x is HTMLElement => !!x)
          .map((x) => {
            const cs = getComputedStyle(x);
            const b = getComputedStyle(x, '::before');
            return [cs.backgroundColor, cs.boxShadow, cs.borderColor, cs.outlineStyle + cs.outlineWidth, b.boxShadow, b.outlineStyle].join('|');
          })
          .join('||');
      const focused = look();
      el.setAttribute('data-probe', '');
      el.blur();
      const blurred = look();
      el.focus({ preventScroll: true });
      // Re-focusing by script may drop :focus-visible; the caller presses Tab again from here anyway.
      return { sig, visible: focused !== blurred, label: `<${el.tagName.toLowerCase()}.${el.className}> ${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}` };
    });
    if (!info || seen.has(info.sig)) break;
    seen.add(info.sig);
    if (!info.visible) fail(name, 'no-focus', info.label);
  }

  // Hover: one sample of each kind of control must respond to the mouse.
  const kinds = await page.evaluate(() => {
    const sig = (el: Element) => `${el.tagName}.${typeof el.className === 'string' ? el.className.split(/\s+/).filter((c) => !/^g-|^is-/.test(c)).sort().join('.') : ''}`;
    const out: Record<string, number> = {};
    // .row-main is the keyboard handle of a clickable row; the row itself is what responds to the mouse.
    const els = [...document.querySelectorAll('button:not(:disabled):not(.row-main), a[href], [role=button], [role=tab], .list-row')];
    els.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      if (r.width && r.height && getComputedStyle(el).visibility !== 'hidden' && r.bottom < innerHeight && !(sig(el) in out)) out[sig(el)] = i;
    });
    return out;
  });
  const all = 'button:not(:disabled):not(.row-main), a[href], [role=button], [role=tab], .list-row';
  for (const [kind, i] of Object.entries(kinds)) {
    await page.mouse.move(0, 0);
    const loc = page.locator(all).nth(i);
    const current = await loc.getAttribute('aria-current');
    if ((await loc.getAttribute('aria-selected')) === 'true' || (current && current !== 'false')) continue;
    const before = await styleOf(page, all, i);
    await loc.hover({ force: true, timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(200);
    const after = await styleOf(page, all, i);
    if (before === after) fail(name, 'no-hover', kind);
  }
  await page.mouse.move(0, 0);
}

/** Menus: Enter opens, focus goes in, arrows move, Esc closes and focus returns, menu stays on screen. */
async function menuBehaviour(page: Page, name: string, trigger: string) {
  const t = page.locator(trigger).first();
  await t.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  const menu = page.locator('.menu');
  if (!(await menu.count())) return fail(name, 'menu', 'Enter on the trigger did not open the menu');
  if ((await t.getAttribute('aria-expanded')) !== 'true') fail(name, 'menu', 'trigger lacks aria-expanded=true while open');
  const first = await page.evaluate(() => document.activeElement?.getAttribute('role'));
  if (first !== 'menuitem') fail(name, 'menu', 'focus did not move into the menu');
  const a = await page.evaluate(() => document.activeElement?.textContent);
  await page.keyboard.press('ArrowDown');
  const b = await page.evaluate(() => document.activeElement?.textContent);
  if (a === b) fail(name, 'menu', 'ArrowDown did not move to the next item');
  const box = await menu.boundingBox();
  const vp = page.viewportSize()!;
  if (box && (box.y + box.height > vp.height + 1 || box.x < 0 || box.x + box.width > vp.width + 1)) fail(name, 'menu', `menu off screen ${JSON.stringify(box)}`);
  await page.keyboard.press('Escape');
  if (await menu.count()) fail(name, 'menu', 'Escape did not close the menu');
  const back = await page.evaluate((sel) => document.activeElement === document.querySelector(sel), trigger);
  if (!back) fail(name, 'menu', 'focus did not return to the trigger');
}

test('interaction audit', async ({ context, extId, ext }) => {
  const errors: string[] = [];
  context.on('weberror', (e) => errors.push(e.error().message));
  await patchSidePanelWindow(context);
  await setup(ext);
  const base = `chrome-extension://${extId}`;
  const wsId = await ext.evaluate(async () => ((await chrome.storage.sync.get('ws:index'))['ws:index'] as string[])[0]!);
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  // ---------------- palette
  await page.setViewportSize({ width: 560, height: 460 });
  await page.goto(`${base}/popup.html`);
  await page.waitForTimeout(400);
  const focused = await page.evaluate(() => document.activeElement?.className);
  if (!String(focused).includes('q')) fail('palette', 'palette', 'search field is not focused on open');
  const sel = () => page.evaluate(() => document.querySelector('[aria-selected=true]')?.textContent);
  const s0 = await sel();
  await page.keyboard.press('ArrowDown');
  if ((await sel()) === s0) fail('palette', 'palette', 'ArrowDown does not move the selection');
  await page.keyboard.press('ArrowUp');
  if ((await sel()) !== s0) fail('palette', 'palette', 'ArrowUp does not move back');
  await page.locator('.q').fill('>');
  await screen(page, 'palette: actions');

  // ---------------- side panel
  for (const width of [320, 480]) {
    const n = `panel@${width}`;
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${base}/sidepanel.html`);
    await page.waitForTimeout(800);
    await screen(page, `${n} window`);
    await menuBehaviour(page, `${n} workspace picker`, '.ws-picker');
    await menuBehaviour(page, `${n} more menu`, '.toolbar .menu-anchor > .btn');
    // A tab row reached by keyboard reveals its actions.
    await page.locator('.tabrow .row-main').nth(3).focus();
    if (!(await page.locator('.tabrow').nth(3).locator('.row-actions').isVisible())) fail(n, 'row', 'focusing a tab row does not reveal its actions');
    // Tabs: arrow keys move between Window / Archive / Timeline.
    await page.locator('.tab').first().focus();
    await page.keyboard.press('ArrowRight');
    if ((await page.locator('.tab[aria-selected=true]').textContent()) !== (await page.locator('.tab').nth(1).textContent())) fail(n, 'tabs', 'ArrowRight does not select the next tab');
    await screen(page, `${n} archive`);
    await page.locator('.tab[aria-selected=true]').focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    await screen(page, `${n} timeline`);
    await page.locator('.snap .list-row').first().focus();
    await page.keyboard.press('Enter');
    if ((await page.locator('.snap .list-row').first().getAttribute('aria-expanded')) !== 'true') fail(n, 'timeline', 'Enter does not expand a moment');
  }

  // ---------------- settings
  for (const width of [1280, 760]) {
    await page.setViewportSize({ width, height: 900 });
    for (const hash of ['workspaces', `workspaces/${wsId}`, 'rules', 'automation', 'ai', 'general', 'data']) {
      await page.goto(`${base}/options.html#${hash}`);
      await page.waitForTimeout(400);
      await screen(page, `settings@${width} #${hash.split('/')[0]}${hash.includes('/') ? '/edit' : ''}`);
    }
    await page.goto(`${base}/options.html#workspaces/${wsId}`);
    await page.waitForTimeout(400);
    await menuBehaviour(page, `settings@${width} pin menu`, '.setting-row .menu-anchor > .btn');
  }

  // Number fields accept multi-digit values typed key by key, and clamp only when done.
  await page.goto(`${base}/options.html#automation`);
  const keep = page.locator('input[type=number]').nth(2);
  await keep.fill('');
  await keep.pressSequentially('250');
  await keep.press('Tab');
  await page.waitForTimeout(700); // past the 350 ms save debounce
  const stored = await ext.evaluate(async () => ((await chrome.storage.sync.get('settings')).settings as { snapshotLimit: number }).snapshotLimit);
  if (stored !== 250) fail('settings #automation', 'number', `typed 250, stored ${stored}`);
  await keep.fill('2');
  await keep.press('Enter');
  await page.waitForTimeout(300);
  if ((await keep.inputValue()) !== '5') fail('settings #automation', 'number', `below minimum shows ${await keep.inputValue()}, expected 5`);

  // A settings change survives a reload (auto-save, like chrome://settings).
  await page.goto(`${base}/options.html#general`);
  const theme = page.getByRole('combobox', { name: 'Theme' });
  await theme.selectOption('dark');
  await page.waitForTimeout(300);
  await page.reload();
  if ((await theme.inputValue()) !== 'dark') fail('settings #general', 'autosave', 'theme change did not persist');
  await theme.selectOption('auto');

  // ---------------- interstitial
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto(`${base}/blocked.html?url=${encodeURIComponent('https://youtube.com/')}&ws=Focus`);
  await screen(page, 'blocked page');

  for (const e of errors) fail('console', 'error', e);
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/interaction-audit.json', JSON.stringify(issues, null, 2));
  console.log(`Interaction audit: ${issues.length} issues`, Object.entries(issues.reduce<Record<string, number>>((m, i) => ((m[i.check] = (m[i.check] ?? 0) + 1), m), {})));
  expect(issues, 'see test-results/interaction-audit.json').toEqual([]);
});
