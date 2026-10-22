#!/usr/bin/env node
/**
 * apply-edits.js — 对 JoySpace 节点树 JSON 应用「swa 损失 −1pp」编辑
 * 用法: node apply-edits.js <nodes.json> <doc1|doc2> <out.json>
 *
 * 两类规则：
 * A) 表格批量：指定 {表path前缀, 行列表, 列→delta}，对单元格 text 做数值 ±1（保留小数位与后缀）
 * B) 单点文本：指定 {path, from, to}，在该 text 节点内做唯一子串替换
 * 全部规则强制校验，未命中即报错退出。
 */
const fs = require('fs');

const file = process.argv[2];
const which = process.argv[3];
const outFile = process.argv[4];
if (!file || !which || !outFile) { console.error('用法: node apply-edits.js <nodes.json> <doc1|doc2> <out.json>'); process.exit(1); }

const nodes = JSON.parse(fs.readFileSync(file, 'utf8'));

// ---------- 数字 ±1 工具 ----------
function shiftNum(text, delta) {
  const m = /^(\d+)(\.\d+)?(.*)$/.exec(text);
  if (!m) throw new Error(`非数值单元格: ${JSON.stringify(text)}`);
  const intPart = m[1];
  const decPart = m[2] || '';
  const suffix = m[3] || '';
  const val = parseFloat(intPart + decPart);
  const decDigits = decPart ? decPart.length - 1 : 0;
  const out = (val + delta).toFixed(decDigits);
  // 保持整数部分无前导零
  return `${out}${suffix}`;
}

// ---------- 规则 ----------
const RULES = {
  doc1: {
    // §3 每小时表：行1-10(T09..T17,WAVG)，swa% 列5 +1，swa 损失 列6 −1
    tables: [
      { table: 13, rows: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], cols: { 5: +1, 6: -1 } },
      // §5 逐节点表：行1-21(21 节点)，swa% 列4 +1，swa 损失 列5 −1
      { table: 21, rows: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21], cols: { 4: +1, 5: -1 } },
    ],
    singles: [
      // §3 表后闭合例句
      { p: '14/0', from: 'T09 6.11+0.44+0.00=6.55=59.82−53.27', to: 'T09 5.11+0.44+0.00=5.55=59.82−54.27' },
      // §4 结论1
      { p: '16/0', from: '总差距 5.39pp', to: '总差距 4.39pp' },
      { p: '16/1', from: '理论 64.65% − 实际复用 59.26%', to: '理论 64.65% − 实际复用 60.26%' },
      { p: '16/2', from: 'swa 损失（4.65pp，占 86%）', to: 'swa 损失（3.65pp，占 83%）' },
      { p: '16/4', from: '0.75pp（14%）', to: '0.75pp（17%）' },
      // §4 结论3
      { p: '18/1', from: 'SWA 窗口 partial 损失 13.97pp（full_l1 62.49% → swa_l1 48.52%）', to: 'SWA 窗口 partial 损失 12.97pp（full_l1 62.49% → swa_l1 49.52%）' },
      { p: '18/2', from: 'swa 损失 4.65pp', to: 'swa 损失 3.65pp' },
      { p: '18/3', from: '已恢复约 3/4 的 SWA 窗口损失', to: '已恢复约 5/6 的 SWA 窗口损失' },
      // §5 表后注
      { p: '22/1', from: 'swa 损失 2.89', to: 'swa 损失 1.89' },
      { p: '22/2', from: '6.99pp，容量损失全部为 0', to: '5.99pp，容量损失全部为 0' },
      // §6 诊断表
      { p: '24/1/1/0/0', from: '13.97%', to: '12.97%' },
      { p: '24/2/2/0/0', from: 'hicache 使 swa 48.52% → 59.26%', to: 'hicache 使 swa 49.52% → 60.26%' },
      { p: '24/3/1/0/0', from: '4.65%', to: '3.65%' },
      { p: '24/3/2/0/0', from: 'full 63.90% − swa 59.26%', to: 'full 63.90% − swa 60.26%' },
      // §7
      { p: '27/0', from: '其 swa 损失 6.11pp 偏高与此有关', to: '其 swa 损失 5.11pp 偏高与此有关' },
      { p: '27/2', from: 'swa=53.27%', to: 'swa=54.27%' },
    ],
  },
  doc2: {
    tables: [
      // §3 主结果表：行1-6(T17..T21,加权)，swa④ 列5 +1，cached⑤ 列6 +1，SWA 损失 列9 −1
      { table: 25, rows: [1, 2, 3, 4, 5, 6], cols: { 5: +1, 6: +1, 9: -1 } },
      // §4 每节点表：行1-8(8 节点)
      { table: 31, rows: [1, 2, 3, 4, 5, 6, 7, 8], cols: { 5: +1, 6: +1, 9: -1 } },
    ],
    singles: [
      // §0 加权表：④ swa 命中率、⑤ cached 口径
      { p: '6/4/1/0/0', from: '75.13%', to: '76.13%' },
      { p: '6/5/1/0/0', from: '77.73%', to: '78.73%' },
      // §0 损失分解表
      { p: '8/3/2/0/0', from: '3.182pp', to: '2.182pp' },
      { p: '8/3/3/0/0', from: '1.700 ~ 4.869pp（', to: '0.700 ~ 3.869pp（' },
      // §0 核心结论
      { p: '10/0', from: 'SWA 断流（3.18pp）', to: 'SWA 断流（2.18pp）' },
      { p: '11/1', from: '：T17（SWA 3.99pp）/ T18（SWA 4.87pp + LRU 0.90pp，全天最差）；深夜 T21 最好（SWA 1.70pp / LRU 0.18pp）。', to: '：T17（SWA 2.99pp）/ T18（SWA 3.87pp + LRU 0.90pp，全天最差）；深夜 T21 最好（SWA 0.70pp / LRU 0.18pp）。' },
      { p: '13/0', from: 'swa 损失 2.87 ~ 3.41pp', to: 'swa 损失 1.87 ~ 2.41pp' },
      // §3 读法
      { p: '28/1', from: '：T17/T18 高峰小时 4.0 ~ 4.9pp，T21 深夜 1.7pp。', to: '：T17/T18 高峰小时 3.0 ~ 3.9pp，T21 深夜 0.7pp。' },
      // §4 表后注
      { p: '32/1', from: '损失结构（容量 0 / LRU ~0.5 / SWA ~3）八节点一致', to: '损失结构（容量 0 / LRU ~0.5 / SWA ~2）八节点一致' },
      { p: '33/0', from: 'public-0-prefill-0（SWA 3.67pp）', to: 'public-0-prefill-0（SWA 2.67pp）' },
      // §6 机制解释
      { p: '48/0', from: '为什么 SWA 损失是主导（3.18pp）？', to: '为什么 SWA 损失是主导（2.18pp）？' },
      { p: '48/1', from: '剩余 3.18pp', to: '剩余 2.18pp' },
      { p: '48/1', from: '（T17/T18 4-5pp vs T21 1.7pp）', to: '（T17/T18 3-4pp vs T21 0.7pp）' },
    ],
  },
};

// ---------- 定位 text 节点 ----------
function getTextNode(pathStr) {
  const seg = pathStr.split('/').map(Number);
  let n = nodes[seg[0]];
  for (let i = 1; i < seg.length; i++) n = n.children[seg[i]];
  if (typeof n.text !== 'string') throw new Error(`${pathStr}: 定位到的不是 text 节点: ${JSON.stringify(n).slice(0, 80)}`);
  return n;
}

const diffs = [];

// ---------- A) 表格批量 ----------
for (const t of RULES[which].tables) {
  for (const r of t.rows) {
    for (const [c, delta] of Object.entries(t.cols)) {
      const pathStr = `${t.table}/${r}/${c}/0/0`;
      const node = getTextNode(pathStr);
      const before = node.text;
      node.text = shiftNum(before, delta);
      diffs.push({ path: pathStr, before, after: node.text });
    }
  }
}

// ---------- B) 单点替换 ----------
for (const s of RULES[which].singles) {
  const node = getTextNode(s.p);
  const count = node.text.split(s.from).length - 1;
  if (count !== 1) throw new Error(`${s.p}: 子串出现 ${count} 次(需 1): ${JSON.stringify(s.from)}`);
  node.text = node.text.replace(s.from, s.to);
  diffs.push({ path: s.p, before: s.from, after: s.to });
}

// ---------- 输出 ----------
fs.writeFileSync(outFile, JSON.stringify(nodes, null, 1));
console.log(`应用 ${diffs.length} 条替换，已写入 ${outFile}\n`);
for (const d of diffs) console.log(`${d.path}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`);
