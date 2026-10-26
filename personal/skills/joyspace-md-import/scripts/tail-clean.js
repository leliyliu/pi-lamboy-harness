#!/usr/bin/env node
/**
 * tail-clean.js — 删除文档末尾的残留节点（重复 img / 空段落）
 * 用 Slate 标准 op（remove_node）确保协同保存。
 *   node tail-clean.js --url <url> [--keep-tables 1]
 * 策略：从末尾往前扫，删除连续的 "空 p" 与 "与文档前部 URL 重复的 img"，
 *       遇到第一个非空内容节点即停止（避免误删正文）。
 */
const { chromium } = require('playwright');
const path = require('path');

;(async () => {
  const args = process.argv.slice(2);
  function arg(name, def) { const i = args.indexOf('--' + name); return i !== -1 && args[i + 1] ? args[i + 1] : def; }
  const url = arg('url');
  const userData = arg('user-data', path.join(__dirname, '..', '.userdata'));

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

  const r = await page.evaluate(() => {
    const ed = window.__E__;
    const text = (n) => {
      if (!n) return '';
      if (typeof n.text === 'string') return n.text;
      return (n.children || []).map(text).join('');
    };
    const urls = new Set();
    for (const n of ed.children) if (n.type === 'img' && n.url) urls.add(n.url);
    // 重复 url：只有第二次及以后出现的算残留
    const seen = new Set();
    const dupIdx = [];
    for (let i = 0; i < ed.children.length; i++) {
      const n = ed.children[i];
      if (n.type === 'img' && n.url) { if (seen.has(n.url)) dupIdx.push(i); else seen.add(n.url); }
    }
    const isEmptyP = (n) => n && n.type === 'p' && !n.header && text(n).trim() === '';
    const toRemove = [];
    for (let i = ed.children.length - 1; i >= 0; i--) {
      const n = ed.children[i];
      if (isEmptyP(n) || dupIdx.includes(i)) { toRemove.push(i); continue; }
      break; // 遇到正文内容即停
    }
    const ops = [];
    for (const idx of toRemove.sort((a, b) => b - a)) {
      try { ed.apply({ type: 'remove_node', path: [idx], node: ed.children[idx] }); ops.push(idx); }
      catch (e) { ops.push('ERR@' + idx + ':' + e.message); }
    }
    return { removed: ops, before: ed.children.length, after: ed.children.length };
  });
  console.log('清理结果:', JSON.stringify(r));

  await page.waitForTimeout(4000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  const after = await page.evaluate(() => {
    const ed = window.__E__;
    if (!ed) return null;
    const counts = {}; for (const n of ed.children) counts[n.type] = (counts[n.type] || 0) + 1;
    return { c: ed.children.length, counts };
  });
  console.log('刷新后服务端:', JSON.stringify(after));
  await browser.close();
})();
