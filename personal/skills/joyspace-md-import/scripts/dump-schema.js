// 只读：dump 目标文档完整 Slate 节点 JSON（含 multi-column / highlight-block / img 全部字段）
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
(async () => {
  const userData = path.join(__dirname, '..', '.userdata');
  const browser = await chromium.launchPersistentContext(userData, { headless: true, viewport: { width: 1440, height: 900 } });
  const page = browser.pages()[0] || await browser.newPage();
  await page.goto('https://joyspace.jd.com/h/personal/pages/G3XIlH7sJT2Un9aJYFTZ', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(6000);
  await page.locator('text=稍后作答').first().click().catch(() => {});
  await page.waitForTimeout(300);
  const ok = await page.evaluate(() => {
    function isEd(o){return o&&typeof o==='object'&&typeof o.insertData==='function'&&typeof o.apply==='function'&&'children'in o&&'selection'in o}
    const s=document.querySelector('.slate-editor');if(!s)return false;
    const fk=Object.keys(s).find(k=>k.startsWith('__react'));if(!fk)return false;
    let f=s[fk];while(f.return)f=f.return;
    const q=[f],seen=new Set();
    while(q.length){const x=q.shift();if(!x||seen.has(x))continue;seen.add(x);
      const p=x.memoizedProps;if(p&&typeof p==='object'){for(const k of Object.keys(p)){const v=p[k];if(v&&typeof v==='object'&&!seen.has(v)){if(isEd(v))window.__E__=v;for(const k2 of Object.keys(v)){if(isEd(v[k2]))window.__E__=v[k2]}}}}
      if(x.child)q.push(x.child);if(x.sibling)q.push(x.sibling)}
    return !!window.__E__;
  });
  if (!ok) { console.error('未找到 editor'); await browser.close(); process.exit(1); }
  // dump 前 8 个节点的完整 JSON（含所有字段）
  const data = await page.evaluate(() => {
    const ed = window.__E__;
    // 清理函数，剥离 React 内部字段，只留数据字段
    function clean(n) {
      if (n === null || typeof n !== 'object') return n;
      if (Array.isArray(n)) return n.map(clean);
      const o = {};
      for (const k of Object.keys(n)) {
        // 跳过 React 内部字段
        if (k.startsWith('_') || k === '$type' || k === 'key') continue;
        o[k] = clean(n[k]);
      }
      return o;
    }
    return ed.children.slice(0, 9).map(clean);
  });
  fs.writeFileSync('/tmp/template_schema.json', JSON.stringify(data, null, 2));
  console.log('已 dump 前 ' + data.length + ' 个节点完整 JSON → /tmp/template_schema.json');
  // 打印每个节点的顶层字段 keys，快速看 schema
  for (const n of data) {
    const keys = Object.keys(n).filter(k => k !== 'children');
    const childTypes = Array.isArray(n.children) ? n.children.map(c => c.type || 'leaf').join(',') : '';
    console.log(`[${n.type}] fields={${keys.join(',')}} childTypes=[${childTypes}]`);
  }
  await browser.close();
})();
