const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
(async () => {
  const userData = path.join(__dirname, '..', '.userdata');
  const browser = await chromium.launchPersistentContext(userData, { headless: true, viewport: { width: 1440, height: 900 } });
  const page = browser.pages()[0] || await browser.newPage();
  await page.goto('https://joyspace.jd.com/pages/qhWrNSjAMGWnjL3v7E8A', { waitUntil: 'domcontentloaded' });
  if (page.url().includes('authme') || page.url().includes('login')) { console.error('需登录'); await browser.close(); process.exit(1); }
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
  if (!ok) { console.error('未找到 editor'); await browser.close(); process.exit(1); }
  // 读出所有节点，带图片位置（前后文本上下文）
  const data = await page.evaluate(() => {
    const ed = window.__E__;
    const result = [];
    ed.children.forEach((n, i) => {
      const leafText = (n) => { if (typeof n.text === 'string') return n.text; if (Array.isArray(n.children)) return n.children.map(leafText).join(''); return ''; };
      if (n.type === 'img') {
        result.push({ idx: i, type: 'img', url: n.url, width: n.width, height: n.height });
      } else if (n.type === 'p' && n.header) {
        result.push({ idx: i, type: 'h'+n.header, text: leafText(n) });
      } else if (n.type === 'p') {
        const t = leafText(n).slice(0, 40);
        if (t) result.push({ idx: i, type: 'p', text: t });
      }
    });
    return result;
  });
  // 只输出图片 + 其前后最近的标题，便于定位
  console.log('=== 所有图片 ===');
  data.filter(d => d.type === 'img').forEach(d => console.log(JSON.stringify(d)));
  console.log('\n=== 所有标题（定位用）===');
  data.filter(d => d.type.startsWith('h')).forEach(d => console.log(`  [${d.idx}] ${d.type}: ${d.text}`));
  await browser.close();
})();
