const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
(async () => {
  const userData = path.join(__dirname, '..', '.userdata');
  const browser = await chromium.launchPersistentContext(userData, { headless: true, viewport: { width: 1440, height: 900 } });
  const page = browser.pages()[0] || await browser.newPage();
  await page.goto('https://joyspace.jd.com/pages/qhWrNSjAMGWnjL3v7E8A', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(5000);
  await page.locator('text=稍后作答').first().click().catch(() => {});
  await page.waitForTimeout(300);
  await page.evaluate(() => {
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
  const nodes = await page.evaluate(() => {
    const ed = window.__E__;
    const lt = (n) => { if (typeof n.text === 'string') return n.text; if (Array.isArray(n.children)) return n.children.map(lt).join(''); return ''; };
    return ed.children.map((n, i) => {
      if (n.type === 'img') return { i, type: 'img', url: n.url, w: n.width, h: n.height };
      if (n.type === 'divider') return { i, type: 'divider' };
      if (n.type === 'block-quote') return { i, type: 'quote', text: lt(n) };
      if (n.type === 'block-code') return { i, type: 'code', lang: n.lang, lines: (n.children||[]).map(c => lt(c)) };
      if (n.type === 'list') return { i, type: 'list', value: n.value, text: lt(n) };
      if (n.type === 'table') return { i, type: 'table', rows: (n.children||[]).map(r => (r.children||[]).map(c => lt(c).replace(/\n/g,' '))) };
      if (n.type === 'p' && n.header) return { i, type: 'h'+n.header, text: lt(n) };
      if (n.type === 'p') return { i, type: 'p', text: lt(n) };
      return { i, type: n.type || 'unknown', text: lt(n) };
    });
  });
  fs.writeFileSync('/tmp/nodes-full.json', JSON.stringify(nodes, null, 2));
  console.log('共 ' + nodes.length + ' 节点，已写入 /tmp/nodes-full.json');
  await browser.close();
})();
