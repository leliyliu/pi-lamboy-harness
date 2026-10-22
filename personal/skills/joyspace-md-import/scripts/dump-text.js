#!/usr/bin/env node
/**
 * dump-text.js — 展平节点树中所有 text 叶子（带路径），输出 {path, text} 列表
 * 用法: node dump-text.js <nodes.json> [out.json]
 */
const fs = require('fs');
const nodes = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = [];
nodes.forEach((n, ti) => {
  (function walk(node, path) {
    if (typeof node.text === 'string') { out.push({ path: `${ti}${path.length ? '/' + path.join('/') : ''}`, text: node.text }); return; }
    if (Array.isArray(node.children)) node.children.forEach((c, i) => walk(c, path.concat(i)));
  })(n, []);
});
const textAll = out.map(t => t.text).join('');
console.log(`text 叶子数: ${out.length}, 总字符: ${textAll.length}`);
if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
else out.forEach((t, i) => console.log(`[${i}] ${t.path}: ${JSON.stringify(t.text)}`));
