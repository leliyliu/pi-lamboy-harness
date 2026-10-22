#!/usr/bin/env node
/**
 * fetch-nodes.js — 从 JoySpace 文档读取完整原始 Slate 节点树（保留全部格式），存为 JSON
 * 用法: node fetch-nodes.js --url <doc-url> --out <out.json>
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const getArg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const URL = getArg('--url');
const OUT = getArg('--out');
if (!URL || !OUT) { console.error('用法: node fetch-nodes.js --url <url> --out <file.json>'); process.exit(1); }

const userData = path.join(__dirname, '..', '.userdata');

(async () => {
  const browser = await chromium.launchPersistentContext(userData, { headless: true, viewport: { width: 1440, height: 900 } });
  const page = browser.pages()[0] || await browser.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('authme') || page.url().includes('login')) {
    console.error('!! 需要登录（headless 模式无法扫码）'); await browser.close(); process.exit(1);
  }
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(5000);
  await page.locator('text=稍后作答').first().click().catch(() => {});
  await page.waitForTimeout(300);

  const ok = await page.evaluate(() => {
    function isEd(o) { return o && typeof o === 'object' && typeof o.insertData === 'function' && typeof o.apply === 'function' && 'children' in o && 'selection' in o; }
    const s = document.querySelector('.slate-editor'); if (!s) return false;
    const fk = Object.keys(s).find(k => k.startsWith('__react')); if (!fk) return false;
    let f = s[fk]; while (f.return) f = f.return;
    const q = [f], seen = new Set();
    while (q.length) { const x = q.shift(); if (!x || seen.has(x)) continue; seen.add(x);
      const p = x.memoizedProps; if (p && typeof p === 'object') { for (const k of Object.keys(p)) { const v = p[k]; if (v && typeof v === 'object' && !seen.has(v)) { if (isEd(v)) window.__E__ = v; for (const k2 of Object.keys(v)) { if (isEd(v[k2])) window.__E__ = v[k2]; } } } }
      if (x.child) q.push(x.child); if (x.sibling) q.push(x.sibling); }
    return !!window.__E__;
  });
  if (!ok) { console.error('!! 未找到 Slate editor'); await browser.close(); process.exit(1); }

  const nodes = await page.evaluate(() => JSON.parse(JSON.stringify(window.__E__.children)));
  fs.writeFileSync(OUT, JSON.stringify(nodes, null, 1));
  const tc = {}; nodes.forEach(n => { tc[n.type] = (tc[n.type] || 0) + 1; });
  console.log(`共 ${nodes.length} 个顶层节点，类型: ${JSON.stringify(tc)}`);
  console.log(`已写入 ${OUT}`);
  await browser.close();
})();
