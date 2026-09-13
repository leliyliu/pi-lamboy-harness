#!/usr/bin/env node
/**
 * inspect.js — 打印 JoySpace 文档的详细节点结构（前 N 个节点）
 */
const { chromium } = require('playwright');
const path = require('path');

;(async () => {
const args = process.argv.slice(2);
function arg(name, def) { const i = args.indexOf('--' + name); return i !== -1 && args[i + 1] ? args[i + 1] : def; }
const url = arg('url');
const userData = arg('user-data', path.join(__dirname, '..', '.userdata'));
const n = parseInt(arg('n', '12'), 10);
const titleSel = arg('title-sel', '.page-header-title-comp-title');

const browser = await chromium.launchPersistentContext(userData, { headless: true, viewport: { width: 1440, height: 900 } });
const page = browser.pages()[0] || await browser.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(5000);
await page.locator('text=稍后作答').first().click().catch(() => {});

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
if (!ok) { console.error('!! 未找到 editor'); await browser.close(); process.exit(1); }

const info = await page.evaluate((n) => {
  const ed = window.__E__;
  const leafText = (nd) => { if (typeof nd.text === 'string') return nd.text; if (Array.isArray(nd.children)) return nd.children.map(leafText).join(''); return ''; };
  const out = [];
  for (let i = 0; i < Math.min(n, ed.children.length); i++) {
    const nd = ed.children[i];
    const t = leafText(nd).slice(0, 60);
    out.push(`[${i}] ${nd.type}${nd.header ? ' H' + nd.header : ''} "${t}"${nd.url ? ' url=' + nd.url.slice(-16) : ''}`);
  }
  return { total: ed.children.length, nodes: out };
}, n);

console.log(`总节点数: ${info.total}`);
info.nodes.forEach(l => console.log(l));
const title = await page.locator(titleSel).first().innerText().catch(() => '(无)');
console.log('页面标题: ' + title.trim());
// 也尝试其他标题 selector
const t2 = await page.evaluate(() => document.title);
console.log('document.title: ' + t2);
await browser.close();
})();
