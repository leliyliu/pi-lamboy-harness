#!/usr/bin/env node
/**
 * export.js — 导出 JoySpace 文档的 Slate 结构为 markdown 概览
 * 用法: node export.js --url <joyspaceURL> [--user-data <dir>] [--headless]
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

;(async () => {
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}
function flag(name) { return args.includes('--' + name); }

const url = arg('url');
const userData = arg('user-data', path.join(__dirname, '..', '.userdata'));
const headless = flag('headless');
const out = arg('out', path.join(__dirname, '..', 'export.md'));
if (!url) { console.error('需要 --url'); process.exit(2); }

console.log(`[export] url=${url}`);
console.log(`[export] userData=${userData}`);
const browser = await chromium.launchPersistentContext(userData, {
  headless, viewport: { width: 1440, height: 900 },
});
const page = browser.pages()[0] || await browser.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });
if (page.url().includes('authme') || page.url().includes('login')) {
  if (headless) { console.error('!! 需要登录但处于 headless 模式'); await browser.close(); process.exit(1); }
  console.log('>>> 请扫码登录...');
  await page.waitForURL('https://joyspace.jd.com/**', { timeout: 360000 });
}
await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(5000);
await page.locator('text=稍后作答').first().click().catch(() => {});
await page.waitForTimeout(300);

// 定位 editor（同 import.js）
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

// 导出为 markdown
const md = await page.evaluate(() => {
  const ed = window.__E__;
  const leafText = (n) => {
    if (typeof n.text === 'string') return n.text;
    if (Array.isArray(n.children)) return n.children.map(leafText).join('');
    return '';
  };
  const lines = [];
  let table = [];
  const flushTable = () => {
    if (table.length) {
      table.forEach((row, ri) => {
        lines.push('| ' + row.join(' | ') + ' |');
        if (ri === 0) lines.push('|' + row.map(() => '---').join('|') + '|');
      });
      table = [];
    }
  };
  for (const n of ed.children) {
    const t = leafText(n);
    if (n.type === 'p' && n.header) { flushTable(); lines.push('#'.repeat(n.header) + ' ' + t); continue; }
    if (n.type === 'table') {
      for (const row of n.children || []) {
        table.push((row.children || []).map(c => leafText(c).replace(/\n/g, ' ')));
      }
      flushTable();
      continue;
    }
    flushTable();
    if (n.type === 'img') { lines.push(`![img](${n.url || '?'})`); continue; }
    if (n.type === 'divider') { lines.push('---'); continue; }
    if (n.type === 'block-quote') { lines.push('> ' + t); continue; }
    if (n.type === 'list') { lines.push((n.value === 'ordered' ? '1. ' : '- ') + t); continue; }
    if (n.type === 'block-code') {
      lines.push('```' + (n.lang || ''));
      for (const l of n.children || []) lines.push(leafText(l));
      lines.push('```');
      continue;
    }
    lines.push(t);
  }
  flushTable();
  return lines.join('\n');
});
const docTitle = await page.locator('.page-header-title-comp-title').first().innerText().catch(() => '?');
const stats = await page.evaluate(() => {
  const ed = window.__E__;
  const tc = {}; ed.children.forEach(n => { tc[n.type] = (tc[n.type] || 0) + 1; });
  return { totalNodes: ed.children.length, typeCount: tc };
});
fs.writeFileSync(out, md);
console.log('\n文档标题: ' + docTitle.trim());
console.log('统计: ' + JSON.stringify(stats));
console.log('已导出到: ' + out + ` (${md.length} chars)`);

await page.screenshot({ path: path.join(path.dirname(out), 'export-preview.png'), fullPage: false }).catch(() => {});
await browser.close();
})();
