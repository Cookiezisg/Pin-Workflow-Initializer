/**
 * Chrome Web Store screenshots (1280×800) and promo tile (440×280), rendered from the real extension.
 * Run: STORE_ASSETS=1 npx playwright test store-assets   → writes to store/
 */
import { mkdirSync, readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { patchSidePanelWindow, setup, shot } from './demo';
import { rpc, test } from './fixtures';

test.skip(!process.env.STORE_ASSETS, 'set STORE_ASSETS=1 to render store assets');
test.setTimeout(120_000);

const OUT = 'store';
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
  await patchSidePanelWindow(context);
  await setup(ext);
  const base = `chrome-extension://${extId}`;

  // 1. Palette
  const palette = await context.newPage();
  await palette.setViewportSize({ width: 560, height: 460 });
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
  await frame(canvas, '1-palette', 'Find any tab in <em>one keystroke</em>', 'Fuzzy search across every window, every workspace and everything you ever archived. Press <kbd>⌥⇧K</kbd>, type, done.', [{ src: paletteImg, w: 560 }]);
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
