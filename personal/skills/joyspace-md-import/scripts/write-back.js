#!/usr/bin/env node
/**
 * write-back.js — 将修改后的 Slate 节点树写回 JoySpace 文档（保格式的全量回写）
 * 用法: node write-back.js --url <url> --orig <orig.json> --new <new.json> [--show] [--shot <png>]
 *
 * 机制（源自 write-liulian.js 实战验证）:
 *   [1/5] 基线校验：服务端当前内容必须与 orig 一致（防并发编辑），不一致则中止
 *   [2/5] apply remove_node 循环清空 + 插入占位空段
 *   [3/5] insertFragment 写入新节点树（协同保存）；会话内校验；失败则回滚 orig
 *   [4/5] 刷新页面，从服务端重新加载并逐节点校验 == new
 *   [5/5] 全页截图
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const getArg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const URL = getArg('--url');
const ORIG = getArg('--orig');
const NEW = getArg('--new');
const SHOT = getArg('--shot');
const SHOW = args.includes('--show');
if (!URL || !ORIG || !NEW) { console.error('用法: node write-back.js --url <url> --orig <o.json> --new <n.json> [--show] [--shot <png>]'); process.exit(1); }

const origNodes = JSON.parse(fs.readFileSync(ORIG, 'utf8'));
const newNodes = JSON.parse(fs.readFileSync(NEW, 'utf8'));

const flatTxt = (n) => { if (typeof n.text === 'string') return n.text; if (Array.isArray(n.children)) return n.children.map(flatTxt).join(''); return ''; };
const summarize = (nodes) => {
  const tc = {}; nodes.forEach(n => { tc[n.type] = (tc[n.type] || 0) + 1; });
  return { c: nodes.length, tc, f: nodes.map(n => ({ t: n.type + (n.header ? '#' + n.header : ''), x: flatTxt(n) })) };
};
const sumOrig = summarize(origNodes);
const sumNew = summarize(newNodes);
const diffSummary = (a, b) => {
  if (!a) return ['无法获取服务端内容'];
  const errs = [];
  if (a.c !== b.c) errs.push(`节点数 ${a.c} vs 期望 ${b.c}`);
  for (let i = 0; i < Math.min(a.f.length, b.f.length); i++) {
    if (a.f[i].t !== b.f[i].t) { errs.push(`#${i} 类型 ${JSON.stringify(a.f[i].t)} vs 期望 ${JSON.stringify(b.f[i].t)}`); continue; }
    if (a.f[i].x !== b.f[i].x) errs.push(`#${i}(${a.f[i].t}) 文本 ${JSON.stringify(a.f[i].x.slice(0, 50))} vs 期望 ${JSON.stringify(b.f[i].x.slice(0, 50))}`);
    if (errs.length >= 8) break;
  }
  return errs;
};

const userData = path.join(__dirname, '..', '.userdata');

(async () => {
  const browser = await chromium.launchPersistentContext(userData, { headless: !SHOW, viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = browser.pages()[0] || await browser.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('authme') || page.url().includes('login')) { console.error('!! 需要登录（用 --show 扫码）'); await browser.close(); process.exit(1); }
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(5000);
  await page.locator('text=稍后作答').first().click().catch(() => {});
  await page.locator('text=不再提醒').first().click().catch(() => {});
  await page.waitForTimeout(300);

  const locateEditor = () => page.evaluate(() => {
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

  const getServerSum = () => page.evaluate(() => {
    const ed = window.__E__; if (!ed) return null;
    const txt = (n) => { if (typeof n.text === 'string') return n.text; if (Array.isArray(n.children)) return n.children.map(txt).join(''); return ''; };
    const tc = {}; ed.children.forEach(n => { tc[n.type] = (tc[n.type] || 0) + 1; });
    return { c: ed.children.length, tc, f: ed.children.map(n => ({ t: n.type + (n.header ? '#' + n.header : ''), x: txt(n) })) };
  });

  // 回滚：清空 + 插入 orig
  const rollback = (nodesJson) => page.evaluate((nj) => {
    const ed = window.__E__; const ns = JSON.parse(nj);
    try {
      let guard = 0;
      while (ed.children.length > 0 && guard < 500) { const i = ed.children.length - 1; ed.apply({ type: 'remove_node', path: [i], node: ed.children[i] }); guard++; }
      ed.apply({ type: 'insert_node', path: [0], node: { type: 'p', children: [{ text: '' }] } });
      ed.selection = { anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 0 } };
      ed.insertFragment(ns);
      return { ok: true, c: ed.children.length };
    } catch (e) { return { ok: false, err: e.message }; }
  }, nodesJson).catch(e => ({ ok: false, err: 'evaluate失败: ' + e.message }));

  if (!(await locateEditor())) { console.error('!! 未找到 Slate editor'); await browser.close(); process.exit(1); }

  // [1/5] 基线校验：服务端 == orig（正常）或全空段（恢复模式，上次中断遗留）
  const cur = await getServerSum();
  const errs0 = diffSummary(cur, sumOrig);
  const emptyDoc = cur && cur.f.every(x => x.x === '');
  if (errs0.length && !emptyDoc) { console.error('!! 服务端内容与基线不一致且非空文档，中止（可能被并发编辑）:'); errs0.forEach(e => console.error('  ' + e)); await browser.close(); process.exit(1); }
  console.log(`[1/5] 基线校验${errs0.length ? '（恢复模式：检测到空文档）' : '通过'}（服务端 ${cur.c} 节点）`);

  // [2/5] 清空
  const clearR = await page.evaluate(() => {
    const ed = window.__E__;
    try {
      let guard = 0;
      while (ed.children.length > 0 && guard < 500) { const i = ed.children.length - 1; ed.apply({ type: 'remove_node', path: [i], node: ed.children[i] }); guard++; }
      ed.apply({ type: 'insert_node', path: [0], node: { type: 'p', children: [{ text: '' }] } });
      ed.selection = { anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 0 } };
      return { ok: true, c: ed.children.length, guard };
    } catch (e) { return { ok: false, err: e.message }; }
  });
  if (!clearR.ok || clearR.c !== 1) { console.error('!! 清空失败: ' + JSON.stringify(clearR)); await browser.close(); process.exit(1); }
  console.log(`[2/5] 已清空（${clearR.guard} 个 remove_node + 占位空段）`);
  await page.waitForTimeout(2500);

  // [3/5] 插入新节点树 + 会话内校验
  if (!(await locateEditor())) { console.error('!! 清空后丢失 editor'); await browser.close(); process.exit(1); }
  const insR = await page.evaluate(({ nj, expCount, expFlat }) => {
    const ed = window.__E__; const ns = JSON.parse(nj);
    const txt = (n) => { if (typeof n.text === 'string') return n.text; if (Array.isArray(n.children)) return n.children.map(txt).join(''); return ''; };
    const flatOf = (arr) => arr.map(n => n.type + (n.header ? '#' + n.header : '') + '\u0000' + txt(n));
    const exp = JSON.parse(expFlat);
    const eq = (arr) => { const f = flatOf(arr); return f.length === exp.length && f.every((v, i) => v === exp[i]); };
    try {
      ed.selection = { anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 0 } };
      ed.insertFragment(ns);
      // 清理 insertFragment 残留的空段：删头或删尾使序列与预期一致
      let extra = ed.children.length - expCount;
      let guard = 0;
      while (extra > 0 && guard < 10) {
        const last = ed.children.length - 1;
        if (eq(ed.children.slice(1))) { ed.apply({ type: 'remove_node', path: [0], node: ed.children[0] }); }
        else if (eq(ed.children.slice(0, last))) { ed.apply({ type: 'remove_node', path: [last], node: ed.children[last] }); }
        else break;
        extra--; guard++;
      }
      return { ok: true, c: ed.children.length, eqFinal: eq(ed.children) };
    } catch (e) { return { ok: false, err: e.message }; }
  }, { nj: JSON.stringify(newNodes), expCount: newNodes.length, expFlat: JSON.stringify(sumNew.f.map(x => x.t + '\u0000' + x.x)) });
  console.log('[3/5] 插入: ' + JSON.stringify(insR));
  let sessionOk = false;
  if (!insR.ok) {
    console.error('!! 插入失败，回滚 orig ...');
  } else {
    const s1 = await getServerSum();
    const e1 = diffSummary(s1, sumNew);
    if (e1.length === 0) { console.log('[3/5] 会话内校验 ✅ 与预期一致'); sessionOk = true; }
    else { console.error('[3/5] 会话内校验 ❌:'); e1.forEach(x => console.error('  ' + x)); }
  }
  if (!sessionOk) {
    const rb = await rollback(JSON.stringify(origNodes));
    console.error('    回滚 orig: ' + JSON.stringify(rb));
    await browser.close(); process.exit(1);
  }
  await page.waitForTimeout(3000);

  // [4/5] 刷新验证服务端
  await page.waitForTimeout(2000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(6000);
  await page.locator('text=稍后作答').first().click().catch(() => {});
  await page.waitForTimeout(2000);
  if (!(await locateEditor())) { console.error('!! 刷新后未找到 editor'); await browser.close(); process.exit(1); }
  const s2 = await getServerSum();
  const e2 = diffSummary(s2, sumNew);
  const docTitle = await page.locator('.page-header-title-comp-title').first().innerText().catch(() => '?');
  console.log(`[4/5] 刷新后服务端校验: ${e2.length === 0 ? '✅ 逐节点与预期完全一致（协同保存成功）' : '❌ 不一致'}`);
  if (e2.length) e2.forEach(x => console.error('  ' + x));
  console.log('    文档标题: ' + docTitle.trim());

  // [5/5] 截图
  if (SHOT) { await page.screenshot({ path: SHOT, fullPage: true }); console.log(`[5/5] 截图已存: ${SHOT}`); }
  await browser.close();
  process.exit(e2.length === 0 ? 0 : 2);
})();
