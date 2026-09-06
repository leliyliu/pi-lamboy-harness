#!/usr/bin/env node
/**
 * import.js — 将 Markdown 文档（含本地图片）导入京东 JoySpace 文档
 *
 * 用法：
 *   node import.js --md <markdown文件> --url <joyspace页面URL> [选项]
 *
 * 选项：
 *   --img-base <dir>     图片相对路径的解析基础目录（默认：md 文件所在目录）
 *   --user-data <dir>    浏览器持久化目录（默认：<skill>/.userdata，复用登录态）
 *   --headless           无头模式（首次登录时不要用，需扫码）
 *   --no-verify          跳过刷新验证
 *   --clear-only         仅清空目标文档，不插入内容（调试用）
 *
 * 前置条件：
 *   - 当前目录或上级已安装 playwright（npm install playwright）
 *   - 已安装 chromium（npx playwright install chromium）
 *
 * 原理（详见 SKILL.md）：
 *   JoySpace 是 Slate.js 协同富文本编辑器，需 SSO 登录，无公开 API。
 *   本脚本通过 Playwright 驱动浏览器，经 React fiber 取到 Slate editor 实例，
 *   用 deleteFragment + insertFragment 写入（确保协同保存到服务端）。
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

;(async () => {
// ---------- 参数解析 ----------
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}
function flag(name) { return args.includes('--' + name); }

const mdPath = arg('md');
const url = arg('url');
const imgBase = arg('img-base', mdPath ? path.dirname(path.resolve(mdPath)) : '.');
const userData = arg('user-data', path.join(__dirname, '..', '.userdata'));
const headless = flag('headless');
const noVerify = flag('no-verify');
const clearOnly = flag('clear-only');

if (!mdPath || !url) {
  console.error('用法: node import.js --md <md文件> --url <joyspaceURL> [--img-base <dir>] [--headless] [--no-verify]');
  process.exit(2);
}
if (!fs.existsSync(mdPath)) { console.error('!! md 文件不存在: ' + mdPath); process.exit(1); }

const md = fs.readFileSync(mdPath, 'utf8');
console.log(`[配置] md=${path.resolve(mdPath)} (${md.length} 字符)`);
console.log(`[配置] url=${url}`);
console.log(`[配置] img-base=${imgBase}`);
console.log(`[配置] userData=${userData}`);

// ---------- 1. 提取并准备图片 ----------
// 支持 ![alt](相对/绝对路径) 形式；SVG 会被转成 PNG
const imgRe = /!\[([^\]]*)\]\(([^)]+)\)/g;
const imgRefs = [];
let m;
while ((m = imgRe.exec(md)) !== null) {
  imgRefs.push({ alt: m[1], raw: m[2], path: path.resolve(imgBase, m[2]) });
}
console.log(`\n[1/6] 发现 ${imgRefs.length} 张图片引用`);
imgRefs.forEach((r, i) => console.log(`  [${i + 1}] ${r.raw} -> ${r.path} (${fs.existsSync(r.path) ? '存在' : '缺失!'})`));

// 收集需要 SVG→PNG 转换的文件
const pngPaths = {}; // raw -> 实际要上传的 png 路径
const tmpDir = path.join(userData, '..', '.tmp-png');
fs.mkdirSync(tmpDir, { recursive: true });
for (const r of imgRefs) {
  if (!fs.existsSync(r.path)) { console.error('!! 图片缺失: ' + r.path); process.exit(1); }
  if (r.path.endsWith('.svg')) {
    const png = path.join(tmpDir, path.basename(r.path, '.svg') + '.png');
    pngPaths[r.raw] = { png, svg: r.path };
  } else {
    pngPaths[r.raw] = { png: r.path };
  }
}
const svgsToConvert = Object.values(pngPaths).filter(p => p.svg);
if (svgsToConvert.length) {
  console.log(`\n[1b/6] 转换 ${svgsToConvert.length} 张 SVG → PNG`);
  // 用 playwright 渲染 SVG
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 2 });
  const pg = await ctx.newPage();
  for (const item of svgsToConvert) {
    const svg = fs.readFileSync(item.svg, 'utf8');
    let w = 1100, h = 600;
    const mm = svg.match(/viewBox=["']0 0 ([\d.]+) ([\d.]+)["']/);
    if (mm) { w = parseFloat(mm[1]); h = parseFloat(mm[2]); }
    await pg.setContent(`<!doctype html><html><head><style>html,body{margin:0;padding:0;background:#fff}svg{display:block}</style></head><body>${svg}</body></html>`, { waitUntil: 'load' });
    await pg.setViewportSize({ width: Math.ceil(w), height: Math.ceil(h) });
    await pg.screenshot({ path: item.png, fullPage: false, clip: { x: 0, y: 0, width: w, height: h } });
    console.log(`  ${path.basename(item.svg)} -> ${path.basename(item.png)} (${w}x${h})`);
  }
  await b.close();
}

// ---------- 2. markdown → Slate 节点 ----------
// Schema 见 references/slate-schema.md
function parseInlineSimple(text) {
  const parts = []; let buf = '', i = 0;
  const flush = (mk = {}) => { if (buf) { parts.push({ text: buf, ...mk }); buf = ''; } };
  while (i < text.length) {
    if (text[i] === '`') {
      const e = text.indexOf('`', i + 1);
      if (e !== -1) { flush(); parts.push({ text: text.slice(i + 1, e), code: true }); i = e + 1; continue; }
    }
    if (text[i] === '*' && text[i + 1] === '*') {
      const e = text.indexOf('**', i + 2);
      if (e !== -1) { flush(); parts.push(...parseInlineSimple(text.slice(i + 2, e)).map(p => ({ ...p, bold: true }))); i = e + 2; continue; }
    }
    if (text[i] === '*' && text[i + 1] !== '*') {
      const e = text.indexOf('*', i + 1);
      if (e !== -1 && text[e + 1] !== '*') { flush(); parts.push(...parseInlineSimple(text.slice(i + 1, e)).map(p => ({ ...p, italic: true }))); i = e + 1; continue; }
    }
    buf += text[i]; i++;
  }
  flush();
  return parts.length ? parts : [{ text: '' }];
}
function parseInline(text) {
  const leaves = []; const tokens = []; let last = 0;
  const re = /(!?)\[([^\]]*)\]\(([^)]+)\)/g; let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) tokens.push({ t: 'text', v: text.slice(last, m.index) });
    if (m[1] === '!') tokens.push({ t: 'text', v: '' }); // 块级图片另行处理
    else tokens.push({ t: 'link', text: m[2], url: m[3] });
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push({ t: 'text', v: text.slice(last) });
  if (!tokens.length) tokens.push({ t: 'text', v: text });
  for (const tk of tokens) {
    if (tk.t === 'link') leaves.push({ type: 'link', url: tk.url, children: parseInlineSimple(tk.text) });
    else leaves.push(...parseInlineSimple(tk.v));
  }
  return leaves.length ? leaves : [{ text: '' }];
}
function splitRow(l) { let s = l.trim(); if (s[0] === '|') s = s.slice(1); if (s.endsWith('|')) s = s.slice(0, -1); return s.split('|'); }
function parseTable(lines, i) {
  const header = splitRow(lines[i]); const rows = [header]; let j = i + 2;
  while (j < lines.length && lines[j].trim().startsWith('|')) { rows.push(splitRow(lines[j])); j++; }
  const w = Array(header.length).fill(Math.floor(770 / header.length));
  return { node: { type: 'table', width: w, children: rows.map(r => ({ type: 'table-row', children: r.map(c => ({ type: 'table-cell', children: [{ type: 'p', children: parseInline(c.trim()) }] })) })) }, next: j };
}
function buildNodes(mdText, imgUrlMap) {
  const lines = mdText.split('\n'); const nodes = []; let i = 0;
  while (i < lines.length) {
    const line = lines[i], tr = line.trim();
    if (tr === '') { i++; continue; }
    if (tr.startsWith('```')) {
      const lang = tr.slice(3).trim() || 'plain'; const cl = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { cl.push(lines[i]); i++; }
      i++; nodes.push({ type: 'block-code', lang, children: cl.map(c => ({ type: 'block-code-line', children: [{ text: c }] })) }); continue;
    }
    const im = tr.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (im) { const u = imgUrlMap[im[2]]; nodes.push({ type: 'img', url: u ? u.url : null, width: u ? u.width : 770, height: u ? u.height : 400, children: [{ text: '' }] }); i++; continue; }
    if (tr.startsWith('|') && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) { const r = parseTable(lines, i); nodes.push(r.node); i = r.next; continue; }
    const h = tr.match(/^(#{1,6})\s+(.*)$/);
    if (h) { nodes.push({ type: 'p', header: h[1].length, children: parseInline(h[2]) }); i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(tr)) { nodes.push({ type: 'divider', children: [{ text: '' }] }); i++; continue; }
    if (tr.startsWith('>')) { const q = []; while (i < lines.length && lines[i].trim().startsWith('>')) { q.push(lines[i].trim().replace(/^>\s?/, '')); i++; } nodes.push({ type: 'block-quote', children: parseInline(q.join(' ')) }); continue; }
    if (tr.match(/^[-*+]\s+/)) { while (i < lines.length && lines[i].trim().match(/^[-*+]\s+/)) { nodes.push({ type: 'list', value: 'bullet', children: parseInline(lines[i].trim().replace(/^[-*+]\s+/, '')) }); i++; } continue; }
    if (tr.match(/^\d+\.\s+/)) { while (i < lines.length && lines[i].trim().match(/^\d+\.\s+/)) { nodes.push({ type: 'list', value: 'ordered', children: parseInline(lines[i].trim().replace(/^\d+\.\s+/, '')) }); i++; } continue; }
    const pl = [];
    while (i < lines.length && lines[i].trim() !== '' && !'|`#>-'.includes((lines[i].trim()[0] || '')) && !lines[i].trim().match(/^(!\[|\d+\.\s|[-*+]\s)/) && !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim())) { pl.push(lines[i]); i++; }
    // 防死循环：行首字符在禁用列表（| ` # > -）但不匹配任何前置分支时，
    // 强制作为段落文本消费至少一行，否则外层 while 会永远卡在同一行
    if (pl.length === 0 && i < lines.length) { pl.push(lines[i]); i++; }
    if (pl.length) nodes.push({ type: 'p', children: parseInline(pl.join(' ')) });
  }
  return nodes;
}
// 先构建一次拿到模板（img url 待填）
const nodesTemplate = buildNodes(md, {});
const typeCount = {};
nodesTemplate.forEach(n => { typeCount[n.type] = (typeCount[n.type] || 0) + 1; });
console.log(`\n[2/6] 解析 markdown → ${nodesTemplate.length} 个 Slate 节点`);
console.log('  类型: ' + JSON.stringify(typeCount));

// ---------- 3. 启动浏览器，登录 ----------
console.log(`\n[3/6] 启动浏览器 (headless=${headless})`);
fs.mkdirSync(userData, { recursive: true });
const browser = await chromium.launchPersistentContext(userData, {
  headless, viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'],
});
const page = browser.pages()[0] || await browser.newPage();
page.on('console', m => { const t = m.text(); if (/error|fail/i.test(t) && t.length < 150) console.log('[BW]', t); });

await page.goto(url, { waitUntil: 'domcontentloaded' });
if (page.url().includes('authme') || page.url().includes('login')) {
  if (headless) { console.error('!! 需要登录但处于 headless 模式，请用可见模式先登录一次'); await browser.close(); process.exit(1); }
  console.log('>>> 需要登录，请在浏览器扫码登录京东（最长等待 6 分钟）...');
  try { await page.waitForURL('https://joyspace.jd.com/**', { timeout: 360000 }); console.log('登录成功'); }
  catch (e) { console.error('!! 登录超时'); await browser.close(); process.exit(1); }
}
await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(4000);
// 关掉问卷弹窗
await page.locator('text=稍后作答').first().click().catch(() => {});
await page.locator('text=不再提醒').first().click().catch(() => {});
await page.waitForTimeout(300);

// 定位 Slate editor 实例（通过 React fiber）
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
if (!(await locateEditor())) { console.error('!! 未找到 Slate editor'); await browser.close(); process.exit(1); }
console.log('  editor 已定位');

if (clearOnly) {
  // 仅清空
  await page.evaluate(() => {
    const ed = window.__E__;
    ed.children = [{ type: 'p', children: [{ text: '' }] }];
    ed.selection = { anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 0 } };
    ed.onChange();
  });
  await page.waitForTimeout(1500);
  console.log('已清空（clear-only）');
  await browser.close(); process.exit(0);
}

// ---------- 4. 上传图片，收集 CDN url ----------
console.log(`\n[4/6] 上传 ${imgRefs.length} 张图片`);
const mainEd = page.locator('.slate-editor').first();
const box = await mainEd.boundingBox();
const clearForUpload = async () => {
  await page.evaluate(() => {
    const ed = window.__E__;
    ed.children = [{ type: 'p', children: [{ text: '' }] }];
    ed.selection = { anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 0 } };
    ed.marks = null; ed.onChange();
  });
  await page.waitForTimeout(700);
};
const imgUrlMap = {};
for (const r of imgRefs) {
  const item = pngPaths[r.raw];
  await clearForUpload();
  await mainEd.click({ position: { x: box.width / 2, y: 40 } });
  await page.waitForTimeout(250);
  const b64 = fs.readFileSync(item.png).toString('base64');
  await page.evaluate(async (b) => {
    const blob = await (await fetch('data:image/png;base64,' + b)).blob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }, b64);
  await page.waitForTimeout(200);
  await page.keyboard.press('Meta+V');
  try {
    await page.waitForFunction(() => { const ed = window.__E__; return ed.children.some(c => c.type === 'img' && c.url); }, { timeout: 30000 });
    await page.waitForTimeout(1200);
    const u = await page.evaluate(() => { const ed = window.__E__; const im = ed.children.find(c => c.type === 'img'); return im ? { url: im.url, width: im.width, height: im.height } : null; });
    imgUrlMap[r.raw] = u;
    console.log(`  [✓] ${r.raw} -> ${u ? u.url.slice(-30) : 'NULL'}`);
  } catch (e) {
    console.error(`  [✗] ${r.raw} 上传失败: ${e.message}`);
    await browser.close(); process.exit(1);
  }
}

// 上传图片阶段用非协同方式清空，破坏了 editor 真实状态。
// 必须 reload 页面恢复服务端真实内容，deleteFragment 才能选中全部旧内容。
console.log(`  [reload] 恢复服务端真实状态`);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(4000);
await page.locator('text=稍后作答').first().click().catch(() => {});
await page.waitForTimeout(500);
if (!(await locateEditor())) { console.error('!! reload 后未找到 editor'); await browser.close(); process.exit(1); }

// ---------- 5. 填充 url + 加 id，写入 ----------
console.log(`\n[5/6] 写入文档`);
const finalNodes = buildNodes(md, imgUrlMap);
// 校验所有 img 有 url
const missUrl = finalNodes.filter(n => n.type === 'img' && !n.url);
if (missUrl.length) { console.error(`!! ${missUrl.length} 张图片缺少 url`); await browser.close(); process.exit(1); }
// 加 id
const idChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_';
const genId = () => { let s = ''; for (let i = 0; i < 6; i++) s += idChars[Math.floor(Math.random() * idChars.length)]; return s; };
const addId = (n) => { if (n && typeof n === 'object') { if (n.type) n.id = genId(); if (Array.isArray(n.children)) n.children.forEach(addId); } return n; };
finalNodes.forEach(addId);

// 重新定位 editor（可能因上传操作失焦）
await locateEditor();
// 清空：deleteFragment 全选删除（协同保存）
const clearR = await page.evaluate(() => {
  const ed = window.__E__;
  const firstLeaf = (ns, pre) => { for (let i = 0; i < ns.length; i++) { const n = ns[i], p = [...pre, i]; if (typeof n.text === 'string') return p; if (n.children?.length) { const r = firstLeaf(n.children, p); if (r) return r; } if (ed.isVoid(n)) return p; } return null; };
  const lastLeaf = (ns, pre) => { for (let i = ns.length - 1; i >= 0; i--) { const n = ns[i], p = [...pre, i]; if (typeof n.text === 'string') return p; if (n.children?.length) { const r = lastLeaf(n.children, p); if (r) return r; } if (ed.isVoid(n)) return p; } return null; };
  try {
    const a = firstLeaf(ed.children, []) || [0, 0];
    const f = lastLeaf(ed.children, []) || [ed.children.length - 1, 0];
    ed.selection = { anchor: { path: a, offset: 0 }, focus: { path: f, offset: 1 } };
    ed.deleteFragment();
    // 二次确保
    if (ed.children.length > 1 || JSON.stringify(ed.children[0]).length > 30) {
      ed.selection = { anchor: { path: [0, 0], offset: 0 }, focus: { path: [ed.children.length - 1, 0], offset: 1 } };
      ed.deleteFragment();
    }
    return { ok: true, c: ed.children.length };
  } catch (e) { return { ok: false, err: e.message }; }
});
console.log('  清空: ' + JSON.stringify(clearR));
await page.waitForTimeout(2000);

// 插入：insertFragment（协同保存）
const insR = await page.evaluate((nj) => {
  const ed = window.__E__; const ns = JSON.parse(nj);
  try { ed.selection = { anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 0 } }; ed.insertFragment(ns); return { ok: true, c: ed.children.length }; }
  catch (e) { return { ok: false, err: e.message }; }
}, JSON.stringify(finalNodes));
console.log('  插入: ' + JSON.stringify(insR));
if (!insR.ok) { console.error('!! 插入失败'); await browser.close(); process.exit(1); }
await page.waitForTimeout(3000);

// 当前会话验证
const v1 = await page.evaluate(() => {
  const ed = window.__E__; const tc = {}; ed.children.forEach(n => { tc[n.type] = (tc[n.type] || 0) + 1; });
  let h2 = 0, h3 = 0; ed.children.forEach(n => { if (n.header === 2) h2++; if (n.header === 3) h3++; });
  return { c: ed.children.length, tc, h2, h3, first: JSON.stringify(ed.children[0]).slice(0, 80) };
});
console.log('  当前会话: ' + JSON.stringify(v1));

// ---------- 6. 刷新验证服务端 ----------
if (!noVerify) {
  console.log(`\n[6/6] 刷新验证服务端保存`);
  await page.waitForTimeout(2000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(6000);
  await page.locator('text=稍后作答').first().click().catch(() => {});
  await page.waitForTimeout(2000);
  await locateEditor();
  const v2 = await page.evaluate(() => {
    const ed = window.__E__; if (!ed) return { noEd: true };
    const tc = {}; ed.children.forEach(n => { tc[n.type] = (tc[n.type] || 0) + 1; });
    let h2 = 0, h3 = 0; ed.children.forEach(n => { if (n.header === 2) h2++; if (n.header === 3) h3++; });
    return { c: ed.children.length, tc, h2, h3, first: JSON.stringify(ed.children[0]).slice(0, 100) };
  });
  const docTitle = await page.locator('.page-header-title-comp-title').first().innerText().catch(() => '?');
  console.log('  刷新后(服务端): ' + JSON.stringify(v2, null, 2));
  console.log('  文档标题: ' + docTitle.trim());
  // 对比 v1 v2
  const match = v1.c === v2.c && v1.tc.table === v2.tc.table && v1.tc.img === v2.tc.img;
  console.log(match ? '\n✅ 验证通过：服务端数据与写入一致' : '\n⚠️ 验证不一致，请人工检查');
  await page.screenshot({ path: path.join(userData, '..', 'import-result.png'), fullPage: true });
} else {
  console.log('\n[6/6] 跳过刷新验证（--no-verify）');
}

await browser.close();
console.log('\n完成。');
})();
