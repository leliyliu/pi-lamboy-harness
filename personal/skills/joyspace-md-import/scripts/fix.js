#!/usr/bin/env node
/**
 * fix.js — 修复追加导入后的残留：
 *   1) 删除文档头部残留的 N 张 img 节点（上传流程遗留）
 *   2) 恢复首段标题文本（被上传流程清空）
 * 用 Slate 标准 op（remove_node / insert_text）确保协同保存。
 */
const { chromium } = require('playwright');
const path = require('path');

;(async () => {
const args = process.argv.slice(2);
function arg(name, def) { const i = args.indexOf('--' + name); return i !== -1 && args[i + 1] ? args[i + 1] : def; }
const url = arg('url');
const userData = arg('user-data', path.join(__dirname, '..', '.userdata'));
const removeImgCount = parseInt(arg('remove-imgs', '0'), 10); // 头部要删的 img 数
const restoreText = arg('restore-text', '');                   // 首段要恢复的文本

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

// 修复
const r = await page.evaluate(({ removeImgCount, restoreText }) => {
  const ed = window.__E__;
  const ops = [];
  // 找到第一个 divider（正文开始）之前的所有 img 节点 index
  const headImgs = [];
  for (let i = 0; i < ed.children.length; i++) {
    const nd = ed.children[i];
    if (nd.type === 'divider') break;
    if (nd.type === 'img') headImgs.push(i);
  }
  // 首段必须是 p 且文本为空才恢复
  const first = ed.children[0];
  const firstText = first && typeof first.children[0]?.text === 'string' ? first.children[0].text : '';
  const doRestore = restoreText && first && first.type === 'p' && firstText === '' && !first.header;
  const toRemove = Math.min(removeImgCount, headImgs.length);
  try {
    // 从后往前删，避免 index 偏移
    for (let i = toRemove - 1; i >= 0; i--) {
      const idx = headImgs[i];
      ed.apply({ type: 'remove_node', path: [idx], node: ed.children[idx] });
      ops.push('remove_node@' + idx);
    }
    if (doRestore) {
      ed.apply({ type: 'insert_text', path: [0, 0], offset: 0, text: restoreText });
      ops.push('insert_text');
    }
    return { ok: true, ops, headImgs, before: null, after: ed.children.length };
  } catch (e) { return { ok: false, err: e.message, ops }; }
}, { removeImgCount, restoreText });

console.log('修复结果: ' + JSON.stringify(r));
await page.waitForTimeout(4000);

// 刷新验证
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(6000);
await page.locator('text=稍后作答').first().click().catch(() => {});

const ok2 = await page.evaluate(() => {
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
const v = await page.evaluate(() => {
  const ed = window.__E__;
  const leafText = (nd) => { if (typeof nd.text === 'string') return nd.text; if (Array.isArray(nd.children)) return nd.children.map(leafText).join(''); return ''; };
  const first5 = [];
  for (let i = 0; i < Math.min(5, ed.children.length); i++) {
    const nd = ed.children[i];
    first5.push(`[${i}] ${nd.type}${nd.header ? ' H' + nd.header : ''} "${leafText(nd).slice(0, 40)}"${nd.url ? ' img' : ''}`);
  }
  const tc = {}; ed.children.forEach(n => { tc[n.type] = (tc[n.type] || 0) + 1; });
  return { total: ed.children.length, imgCount: tc.img || 0, first5 };
});
console.log('刷新后验证: ' + JSON.stringify(v, null, 2));
const title = await page.locator('.page-header-title-comp-title').first().innerText().catch(() => '(无)');
console.log('页面标题: ' + title.trim());
await browser.close();
})();
