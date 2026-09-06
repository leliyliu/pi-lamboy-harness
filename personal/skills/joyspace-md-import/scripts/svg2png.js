#!/usr/bin/env node
/**
 * svg2png.js — 将 SVG 文件渲染为 PNG（使用 Playwright Chromium，2x DPI）
 *
 * 用法：
 *   node svg2png.js <input.svg> [input2.svg ...] [--out <dir>] [--scale 2]
 *   node svg2png.js --batch <dir-with-svgs> [--out <dir>] [--scale 2]
 *
 * 输出：同名 .png 文件，尺寸来自 SVG viewBox × scale。
 * 退出码：0 成功；非 0 有失败。
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const scale = parseFloat(args.find((_, i, a) => a[i - 1] === '--scale') || '2') || 2;
const outIdx = args.indexOf('--out');
const outDir = outIdx !== -1 ? args[outIdx + 1] : null;
const batchIdx = args.indexOf('--batch');

let files = [];
if (batchIdx !== -1) {
  const dir = args[batchIdx + 1];
  files = fs.readdirSync(dir).filter(f => f.endsWith('.svg')).map(f => path.join(dir, f));
} else {
  files = args.filter(a => !a.startsWith('--') && !['--out', '--scale', '--batch'].includes(a));
}

if (!files.length) {
  console.error('用法: node svg2png.js <input.svg ...> | --batch <dir> [--out <dir>] [--scale 2]');
  process.exit(2);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1200 },
    deviceScaleFactor: scale,
  });
  const page = await ctx.newPage();
  let fail = 0;
  for (const f of files) {
    if (!fs.existsSync(f)) { console.error('!! 不存在: ' + f); fail++; continue; }
    const svg = fs.readFileSync(f, 'utf8');
    let w = 1100, h = 600;
    const m = svg.match(/viewBox=["']0 0 ([\d.]+) ([\d.]+)["']/);
    if (m) { w = parseFloat(m[1]); h = parseFloat(m[2]); }
    const html = `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:#fff}svg{display:block}</style></head><body>${svg}</body></html>`;
    await page.setContent(html, { waitUntil: 'load' });
    await page.setViewportSize({ width: Math.ceil(w), height: Math.ceil(h) });
    const base = path.basename(f, '.svg') + '.png';
    const out = outDir ? path.join(outDir, base) : f.replace(/\.svg$/, '.png');
    if (outDir) fs.mkdirSync(outDir, { recursive: true });
    await page.screenshot({ path: out, fullPage: false, clip: { x: 0, y: 0, width: w, height: h } });
    console.log(`${path.basename(f)} -> ${out} (${w}x${h}@${scale}x, ${fs.statSync(out).size}B)`);
  }
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
