#!/usr/bin/env node
/**
 * write-liulian.js — 将刘炼的「云上人物」内容写入 JoySpace 文档
 * 复刻模板版式（multi-column / highlight-block），复用模板原图 CDN url，仅替换文本。
 * 机制：fiber 定位 editor → deleteFragment 清空 → insertFragment 写入 → reload 验证
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const URL = 'https://joyspace.jd.com/h/personal/pages/G3XIlH7sJT2Un9aJYFTZ';
const userData = path.join(__dirname, '..', '.userdata');

// ---------- 文本内容 ----------
const TITLE = '【云上人物-榜样来了】深耕推理缓存命中率，释放大模型服务效能-2026年第xx期-AI Infra研发部-刘炼';
const MAIN_TITLE = '深耕推理缓存命中率，释放大模型服务效能';
const SUB_TITLE = '深耕缓存命中底层逻辑，建立精细化推理优化体系';
const INTRO = '刘炼，京东集团-京东科技-京东云事业部-AI Infra研发部-推理平台部。聚焦大模型推理框架缓存优化，围绕 KV 缓存命中率核心指标，参与推进流量特征分析、理论命中率量化与瓶颈诊断工具建设，并协助完善推理服务缓存策略体系。通过命中率量化与驱逐策略优化，推动大模型推理服务在效能和成本方面持续优化。';

// 模板原图 CDN url（复用，不重新上传）
const BANNER_URL = 'https://apijoyspace.jd.com/v1/files/xvns3ZmOWLHqEkkpeJQK/link';   // 刊头 351x206
const PORTRAIT_URL = 'https://apijoyspace.jd.com/v1/files/KlHONRxdCmPUYgOH1HnM/link'; // 人物 750x750

// 署名行空格对齐（复刻模板原样）
const SIGN_SPACES = '                                                                                                           ';

// ---------- 构造 Slate 节点树（复刻模板 schema）----------
function buildNodes() {
  return [
    // 0. 大标题段（普通 p，模板首段；页面标题或从此提取）
    { type:'p', children:[{text: TITLE}] },
    // 1. 重复标题段（模板特性）
    { type:'p', children:[{text: TITLE}] },
    // 2. 刊头两列 50:50
    { type:'multi-column', ratios:[50,50], children:[
      { type:'multi-column-item', children:[
        { type:'img', url:BANNER_URL, width:351, height:206, children:[{text:''}] }
      ]},
      { type:'multi-column-item', children:[
        { type:'p', align:'center', children:[{text:''}] },
        { type:'p', align:'center', children:[{fontSize:18, bold:true, text:'京东云事业部云上人物周刊'}] },
        { type:'p', align:'center', children:[{fontSize:18, bold:true, text:'2026年第xx期'}] },
        { type:'p', align:'center', children:[{fontSize:18, bold:true, text:'AI Infra研发部'}] },
        { type:'p', align:'center', children:[{bold:true, fontSize:18, text:'刘炼'}] },
        { type:'p', align:'center', children:[{text:''}] },
        { type:'p', align:'center', children:[{text:''}] },
      ]}
    ]},
    // 3. 空段
    { type:'p', children:[{text:''}] },
    // 4. 署名块
    { type:'highlight-block', bgColor:'#D9D9D9', emoji:'🙋', children:[
      { type:'p', children:[
        {bold:true, text:'人物介绍      '},
        {text: SIGN_SPACES + '文 | 刘芳'}
      ]},
      { type:'p', align:'right', children:[{text:'编辑 | 董作鹏、孙恒'}] }
    ]},
    // 5. 空段
    { type:'p', children:[{text:''}] },
    // 6. 人物介绍两列 35:65
    { type:'multi-column', ratios:[35,65], children:[
      { type:'multi-column-item', children:[
        { type:'img', url:PORTRAIT_URL, width:750, height:750, children:[{text:''}] }
      ]},
      { type:'multi-column-item', bgColor:'#F5F5F5', children:[
        { type:'p', children:[{fontSize:18, text:'    '}] },
        { type:'p', children:[{fontSize:18, text:' ' + INTRO}] }
      ]}
    ]},
    // 7. 主标题（居中红色22px粗体）
    { type:'p', align:'center', children:[{fontSize:22, fontColor:'#F5222D', bold:true, text:MAIN_TITLE}] },
    // 8. 空段
    { type:'p', children:[{text:''}] },
    // 9. 第一段总述（场景化开头）
    { type:'p', children:[{text:'做大模型推理优化越久，我越确信一件事：缓存命中率，是衡量推理服务效能最诚实的那把尺子。命中一次，省下的是一整段重复计算；少命中一次，多的是用户多等的几百毫秒和白白烧掉的 GPU 算力。我以这把尺子为抓手，统筹上游算力供给、中游引擎调度、下游业务真实负载三方，搭建起覆盖"流量诊断—理论量化—瓶颈验证"的推理缓存优化体系。'}] },
    // 10. 第一段总述2
    { type:'p', children:[{text:'对内与产研、运营、业务方协同，把复杂的命中率指标翻译成可量化、可对比的效能标尺，破除"凭感觉调参"的盲区，为大模型服务规模化放量筑牢效能与成本基础。'}] },
    // 11. 空段
    { type:'p', children:[{text:''}] },
    // 12. 第二段标题
    { type:'p', align:'center', children:[{fontSize:22, fontColor:'#F5222D', bold:true, text:SUB_TITLE}] },
    // 13. 第二段引入
    { type:'p', children:[{text:'大模型推理缓存优化的核心，是持续平衡"理论命中上限、引擎实际表现、业务真实负载"三方价值，搭建可持续运转的缓存命中生态。优化的关键不在"调参"，而在穿透"命中率黑盒"——把模糊的直觉变成精确的可量化空间。'}] },
    // 14. 空段
    { type:'p', children:[{text:''}] },
    // 15. 准则引出
    { type:'p', children:[{text:'作为推理缓存优化方向工程师，我始终坚守三项工作底层准则：'}] },
    // 16. 业务一·故事A（agent把缓存聊漂了）
    { type:'p', children:[
      {bold:true, text:'第一件事，是从一条"不该出现的曲线"开始的。'},
      {text:' 我盯过一块 agent（智能体）服务的命中率——明明是同一个 agent 在持续对话，前缀缓存（prefix cache，复用已算过的请求开头部分）却怎么都命中不上。顺着这条曲线往下挖，撞见一个反直觉的真相：agent 每多聊一轮，prompt 就悄悄"漂移"一点，系统提示词、工具描述、历史消息的顺序都在变，原本该复用的前缀，就这样被一轮轮聊"没了"。'}
    ]},
    // 16b. 业务一·后续
    { type:'p', children:[{text:'这让我意识到，"命中率偏低"从来不是一句话能概括的指标，背后是一个个具体的"为什么"：是 prompt 在漂移，是预热没做完整，还是某些请求天生只来一次。把模糊的"偏低"拆解成一张张可修复的工程缺陷清单——不放过任何一个"本该命中却没命中"的请求，这就是流量分析的真正价值。'}] },
    // 17. 空段
    { type:'p', children:[{text:''}] },
    // 18. 业务二·故事D（给能多高造一把尺子）
    { type:'p', children:[
      {bold:true, text:'第二件事，是给"命中率到底能多高"这件说不清的事，造一把尺子。'},
      {text:' 过去论证缓存方案收益，常陷入"理论上能提升不少"的模糊地带。我拉通相关方对齐命中率定义口径与计算链路，搭出理论命中率面板：先算出每个模型的理论上限，再与实测值对比，两者之间的 gap（差距）直接标定出还能优化多少空间。'}
    ]},
    // 18b. 业务二·后续
    { type:'p', children:[{text:'印象最深的是逐模型对齐的过程——GLM 侧率先收敛，deepseek-v4-pro 等模型却总是对不上，挖下去发现是预热不完整、长上下文 CPU 开销等"测量口径"在作祟。当全部模型终于对齐的那一刻，优化空间从"不确定性"变成了"精确的标尺"，此后每一次策略收益都能被量化定价、可复验、可对比。'}] },
    // 19. 空段
    { type:'p', children:[{text:''}] },
    // 20. 业务三·故事B+C（一次反转加一场攻关）
    { type:'p', children:[
      {bold:true, text:'第三件事，是两个反转加一次攻关。'},
      {text:' 先说反转：研究驱逐策略（缓存满了该踢谁）时，我梳理了"频次×新近度"的五种融合范式，本以为要精雕"踢人"逻辑，却被数据结结实实打了一巴掌——KV 前缀负载里，只来一次就再也不来的请求（one-hit-wonder）占比高得惊人。这些"客人"根本没机会复用，优化"踢谁"纯属白费力气。真正的杠杆在另一头：准入比驱逐更重要——"什么该进缓存"往往比"什么该被踢出"更关键，且频率信号必须带时间衰减，否则历史高频会话会永久霸占缓存。'}
    ]},
    // 20b. 业务三·simulator攻关
    { type:'p', children:[{text:'要验证这类策略又不能每次都占 GPU 集群，于是我搭了 sglang-simulator 定制树，复用真实调度器与缓存代码，让策略实验从 GPU 搬到 CPU 快速迭代。攻关并不轻松：补齐 6 处版本兼容缺口，其中 HiCache 缓存注册与 UnifiedRadixCache 的 hook 错配，直接导致调度死锁，卡住整个进度。逐个排除、跑通全部 8 个官方测试的那一刻，这套无 GPU 依赖的实验基础设施终于立住了——后续驱逐、刷新策略迭代，都有了统一载体。'}] },
    // 20c. 业务三·故事3精简版（异构attention的命中语义差异）
    { type:'p', children:[{text:'工具立住后，我拿它啃的第一块硬骨头，是 kimi-k3、deepseek-v4 这类模型命中率怎么都上不去。挖下去才发现，这些模型用的是异构 attention，命中机制和标准全注意力根本不是一套逻辑：标准模型里前缀匹配就是匹配，可 SWA（滑动窗口注意力）模型里，一条缓存前缀要被命中，链尾必须还留着整整一个滑动窗口的原始 KV——FULL 池存“全书”，SWA 池只给“每条书签附近的一页半”留位置；kimi-k3 的 linear attention（线性注意力）又是另一套，命中后还得拷贝一份状态槽。三种架构三种命中语义，“命中”两个字在不同模型里根本不是同一个意思，同一套缓存策略丢进去，命中率自然天差地别——优化必须因“构”制宜。'}] },
    // 20d. 空段
    { type:'p', children:[{text:''}] },
    // 22. 结尾展望
    { type:'p', children:[{text:'后续我将持续推进命中率缺陷分析与驱逐策略落地上线，打造覆盖全模型、可量化、可复验的大模型推理缓存优化基础设施；沉淀可复用的命中率量化方法论与瓶颈诊断体系，赋能内部各推理服务线的效能与成本优化落地。'}] },
    // 22b. 结尾金句（守门员比喻）
    { type:'p', children:[{text:'做缓存优化越久，我越觉得这活儿像守门员——命中率每高一格，是替用户省下的等待、替公司省下的算力；而每一次"本该命中却没命中"，都是值得追到底的损失。我想做的，不只是发现这些损失，而是把它们变成可量化、可修复、可预防的体系，以精准的命中率标尺，护航大模型推理服务行稳致远。'}] },
    // 尾部空段
    { type:'p', children:[{text:''}] },
    { type:'p', children:[{text:''}] },
  ];
}

;(async () => {
const headless = !process.argv.includes('--show');
console.log(`[配置] url=${URL}`);
console.log(`[配置] userData=${userData}`);
console.log(`[配置] headless=${headless}`);

const finalNodes = buildNodes();
// 加 id（6字符随机串）
const idChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_';
const genId = () => { let s = ''; for (let i = 0; i < 6; i++) s += idChars[Math.floor(Math.random() * idChars.length)]; return s; };
const addId = (n) => { if (n && typeof n === 'object') { if (n.type) n.id = genId(); if (Array.isArray(n.children)) n.children.forEach(addId); } return n; };
finalNodes.forEach(addId);

const tc = {}; finalNodes.forEach(n => { tc[n.type] = (tc[n.type] || 0) + 1; });
console.log(`\n[节点] 共 ${finalNodes.length} 个顶层节点，类型: ${JSON.stringify(tc)}`);
console.log(`[节点] 首段: ${JSON.stringify(finalNodes[0]).slice(0,90)}...`);

// ---------- 启动浏览器 ----------
console.log(`\n[1/4] 启动浏览器`);
const browser = await chromium.launchPersistentContext(userData, {
  headless, viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'],
});
const page = browser.pages()[0] || await browser.newPage();
page.on('console', m => { const t = m.text(); if (/error|fail/i.test(t) && t.length < 150) console.log('[BW]', t); });

await page.goto(URL, { waitUntil: 'domcontentloaded' });
if (page.url().includes('authme') || page.url().includes('login')) {
  if (headless) { console.error('!! 需要登录但处于 headless 模式'); await browser.close(); process.exit(1); }
  console.log('>>> 请扫码登录...');
  await page.waitForURL('https://joyspace.jd.com/**', { timeout: 360000 });
}
await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(5000);
await page.locator('text=稍后作答').first().click().catch(() => {});
await page.locator('text=不再提醒').first().click().catch(() => {});
await page.waitForTimeout(300);

// ---------- 定位 editor ----------
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

// ---------- 2. 清空（apply remove_node 循环，不依赖 selection，对 void 节点可靠）----------
console.log(`\n[2/4] 清空原文档`);
const clearR = await page.evaluate(() => {
  const ed = window.__E__;
  try {
    let guard = 0;
    while (ed.children.length > 0 && guard < 500) { const i = ed.children.length - 1; ed.apply({ type: 'remove_node', path: [i], node: ed.children[i] }); guard++; }
    // 插入一个空 p 占位（insertFragment 需要锚点）
    ed.apply({ type: 'insert_node', path: [0], node: { type: 'p', children: [{ text: '' }] } });
    ed.selection = { anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 0 } };
    return { ok: true, c: ed.children.length, guard };
  } catch (e) { return { ok: false, err: e.message }; }
});
console.log('  清空: ' + JSON.stringify(clearR));
if (!clearR.ok || clearR.c !== 1) { console.error('!! 清空失败或未清空'); await browser.close(); process.exit(1); }
await page.waitForTimeout(2500);

// ---------- 3. 插入（insertFragment）----------
console.log(`\n[3/4] 写入刘炼内容`);
await locateEditor();
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
  return { c: ed.children.length, tc, first: JSON.stringify(ed.children[0]).slice(0, 100) };
});
console.log('  当前会话: ' + JSON.stringify(v1));

// ---------- 4. 刷新验证服务端 ----------
console.log(`\n[4/4] 刷新验证服务端保存`);
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
  // 取关键文本节点
  const txt = (n) => { if (typeof n.text === 'string') return n.text; if (Array.isArray(n.children)) return n.children.map(txt).join(''); return ''; };
  const first = ed.children[0] ? txt(ed.children[0]).slice(0, 80) : '';
  // 找含"刘炼"的节点
  const hasLiuLian = ed.children.some(n => txt(n).includes('刘炼'));
  const hasTitle = ed.children.some(n => txt(n).includes('深耕推理缓存命中率'));
  return { c: ed.children.length, tc, first, hasLiuLian, hasTitle };
});
const docTitle = await page.locator('.page-header-title-comp-title').first().innerText().catch(() => '?');
console.log('  刷新后(服务端): ' + JSON.stringify(v2, null, 2));
console.log('  文档标题: ' + docTitle.trim());
const match = v1.c === v2.c && JSON.stringify(v1.tc) === JSON.stringify(v2.tc);
console.log(match && v2.hasLiuLian ? '\n✅ 验证通过：服务端数据与写入一致，含刘炼内容' : '\n⚠️ 验证异常，请人工检查');
await page.screenshot({ path: path.join(userData, '..', 'write-liulian-result.png'), fullPage: true });
await browser.close();
console.log('\n完成。');
})();
