// 只读：递归 dump 目标文档完整 Slate 节点树（含 multi-column / highlight-block 内部结构）
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
  // 递归描述节点
  const tree = await page.evaluate(() => {
    const ed = window.__E__;
    const lt = (n) => { if (typeof n.text === 'string') return n.text; if (Array.isArray(n.children)) return n.children.map(lt).join(''); return ''; };
    function desc(n, depth) {
      const pad = '  '.repeat(depth);
      const t = n.type || 'unknown';
      const text = lt(n).replace(/\s+/g,' ').trim();
      let extra = [];
      if (n.header) extra.push('header='+n.header);
      if (n.value) extra.push('value='+n.value);
      if (n.url) extra.push('url='+ (n.url.slice(0,40)));
      if (n.lang) extra.push('lang='+n.lang);
      if (n.width) extra.push('w='+n.width);
      // multi-column 列数
      if (n.type === 'multi-column' && Array.isArray(n.children)) extra.push('cols='+n.children.length);
      const line = pad + '- ['+t+']' + (extra.length?(' {'+extra.join(', ')+'}'):'') + (text?(' "'+text.slice(0,120)+(text.length>120?'…':'')+'"'):'');
      const out = [line];
      if (Array.isArray(n.children)) {
        for (const c of n.children) out.push(...desc(c, depth+1));
      }
      return out;
    }
    return ed.children.map(n => desc(n, 0)).flat().join('\n');
  });
  fs.writeFileSync('/tmp/template_tree.txt', tree);
  console.log(tree);
  await browser.close();
})();
