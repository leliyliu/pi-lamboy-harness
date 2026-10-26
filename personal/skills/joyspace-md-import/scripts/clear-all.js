#!/usr/bin/env node
/**
 * clear-all.js — 用 remove_node 全量清空文档（deleteFragment 在嵌套 blockquote 页面上可能失效）
 * 保留 1 个 p 作为首段（Slate 要求至少一个节点），并可指定其文本（页面标题从首段提取）。
 *   node clear-all.js --url <url> [--text "标题"]
 */
const { chromium } = require('playwright');
const path = require('path');

;(async () => {
  const args = process.argv.slice(2);
  function arg(name, def) { const i = args.indexOf('--' + name); return i !== -1 && args[i + 1] ? args[i + 1] : def; }
  const url = arg('url');
  const text = arg('text', '26-10-23 KV全链路');
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

  const r = await page.evaluate((text) => {
    const ed = window.__E__;
    const before = ed.children.length;
    let guard = 0;
    while (ed.children.length > 1 && guard++ < 500) {
      const idx = ed.children.length - 1;
      try { ed.apply({ type: 'remove_node', path: [idx], node: ed.children[idx] }); }
      catch (e) { return { err: 'remove@' + idx + ':' + e.message, left: ed.children.length }; }
    }
    // 首段整理为单个文本节点
    const first = ed.children[0];
    const cur = (first.children || []).map(c => c.text || '').join('');
    if (cur !== text) {
      try {
        if ((first.children || []).length > 1) {
          for (let i = first.children.length - 1; i >= 1; i--) {
            ed.apply({ type: 'remove_node', path: [0, i], node: first.children[i] });
          }
        }
        if (first.children[0] && first.children[0].text) {
          ed.apply({ type: 'remove_text', path: [0, 0], text: first.children[0].text });
        }
        ed.apply({ type: 'insert_text', path: [0, 0], offset: 0, text });
      } catch (e) { return { err: 'first:' + e.message, left: ed.children.length }; }
    }
    return { before, after: ed.children.length, first: (ed.children[0].children || []).map(c => c.text || '').join('') };
  }, text);
  console.log('清空结果:', JSON.stringify(r));

  await page.waitForTimeout(5000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  const after = await page.evaluate(() => {
    function isEd(o) { return o && typeof o === 'object' && typeof o.insertData === 'function' && typeof o.apply === 'function' && 'children' in o && 'selection' in o; }
    const s = document.querySelector('.slate-editor'); if (!s) return null;
    const fk = Object.keys(s).find(k => k.startsWith('__react')); if (!fk) return null;
    let f = s[fk]; while (f.return) f = f.return;
    const q = [f], seen = new Set(); let ed = null;
    while (q.length) { const x = q.shift(); if (!x || seen.has(x)) continue; seen.add(x);
      const p = x.memoizedProps; if (p && typeof p === 'object') { for (const k of Object.keys(p)) { const v = p[k]; if (v && typeof v === 'object' && !seen.has(v)) { if (isEd(v)) ed = v; for (const k2 of Object.keys(v)) { if (isEd(v[k2])) ed = v[k2]; } } } }
      if (x.child) q.push(x.child); if (x.sibling) q.push(x.sibling); }
    if (!ed) return null;
    return { c: ed.children.length, first: (ed.children[0].children || []).map(c => c.text || '').join('') };
  });
  console.log('刷新后服务端:', JSON.stringify(after));
  await browser.close();
})();
