// Renders assets/icon*.svg to public/icon-*.png (and an optional preview sheet). Usage: node scripts/render-icons.mjs [outDir] [--preview]
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const out = resolve(process.argv[2] ?? 'public');
const big = readFileSync('assets/icon.svg', 'utf8');
const small = readFileSync('assets/icon-16.svg', 'utf8');
const b = await chromium.launch();
const p = await b.newPage();
const png = {};
for (const [size, svg] of [[16, small], [32, big], [48, big], [128, big]]) {
  await p.setViewportSize({ width: size, height: size });
  await p.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`);
  png[size] = await p.screenshot({ path: `${out}/icon-${size}.png`, omitBackground: true });
}
if (process.argv.includes('--preview')) {
  const src = (s) => `data:image/png;base64,${png[s].toString('base64')}`;
  await p.setViewportSize({ width: 640, height: 200 });
  await p.setContent(`<body style="margin:0;display:flex;gap:24px;align-items:center;padding:24px;background:#f3f3f5">
  <img src="${src(128)}"><img src="${src(48)}"><img src="${src(32)}"><img src="${src(16)}"><img src="${src(16)}" width=64 style="image-rendering:pixelated">
  <div style="background:#202124;padding:16px;display:flex;gap:16px;align-items:center"><img src="${src(48)}"><img src="${src(16)}"></div></body>`);
  await p.screenshot({ path: `${out}/preview.png` });
}
await b.close();
