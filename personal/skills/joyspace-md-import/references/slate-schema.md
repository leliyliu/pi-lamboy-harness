# JoySpace Slate 节点 Schema 参考

> 通过 React fiber 实测 `@jd/mf-doc-editor@1.9.8`（Slate.js + React 16.13.1）得到。
> 所有元素节点都需要 `id` 字段（6 字符随机串，字母数字下划线）。

## 顶层节点类型

| type | 说明 | 必需字段 | 示例 |
|---|---|---|---|
| `p` | 段落 | `children` | `{type:'p', children:[{text:'...'}]}` |
| `p` (标题) | 带 header 字段的段落 | `header`, `children` | `{type:'p', header:2, children:[{text:'H2'}]}` |
| `block-quote` | 引用块 | `children` | `{type:'block-quote', children:[{text:'...'}]}` |
| `list` | 列表项 | `value`, `children` | `{type:'list', value:'bullet', children:[...]}` |
| `table` | 表格 | `width`, `children` | 见下方 |
| `divider` | 分割线 | `children` | `{type:'divider', children:[{text:''}]}` |
| `block-code` | 代码块 | `lang`, `children` | 见下方 |
| `img` | 图片 | `url`, `width`, `height`, `children` | 见下方 |

## 标题层级

JoySpace **不支持正文 H1**——文档标题（页面顶部 `page-header-title-comp-title`）由正文第一个 `header:1` 段落自动提取。

```
# H1   → {type:'p', header:1, children:[...]}   // 自动成为文档标题
## H2  → {type:'p', header:2, children:[...]}
### H3 → {type:'p', header:3, children:[...]}
#### H4 → {type:'p', header:4, children:[...]}
```

## 列表

每个列表项是独立的 `list` 节点（不是嵌套 list 包含 items）：

```
- 项A      → {type:'list', value:'bullet',  children:[{text:'项A'}]}
- 项B      → {type:'list', value:'bullet',  children:[{text:'项B'}]}
1. 有序1   → {type:'list', value:'ordered', children:[{text:'有序1'}]}
```

## 表格

```
| a | b |
|---|---|
| 1 | 2 |

→ {
  type: 'table',
  width: [385, 385],                    // 列宽，总和约 770
  children: [
    { type: 'table-row', children: [
      { type: 'table-cell', children: [{ type:'p', children:[{text:'a'}] }] },
      { type: 'table-cell', children: [{ type:'p', children:[{text:'b'}] }] }
    ]},
    { type: 'table-row', children: [...] }
  ]
}
```

## 代码块

```
```bash
echo hi
```

→ {
  type: 'block-code',
  lang: 'bash',
  children: [
    { type:'block-code-line', children:[{text:'echo hi'}] }
  ]
}
```

## 图片

```
![alt](path)

→ {
  type: 'img',
  url: 'https://apijoyspace.jd.com/v1/files/XXXX/link',
  width: 770,        // 显示宽度，通常 770（编辑器内容区宽）
  height: 419,       // 按原始宽高比缩放
  children: [{ text: '' }]
}
```

url 必须先通过"粘贴图片到编辑器"上传到 JoySpace CDN 获得，不能用外部 URL。

## 行内节点（leaf）

leaf 节点在 `children` 数组中，是纯对象（无 type 字段）：

| 形式 | 结构 |
|---|---|
| 纯文本 | `{text:'...'}` |
| 粗体 | `{text:'...', bold:true}` |
| 斜体 | `{text:'...', italic:true}` |
| 行内代码 | `{text:'...', code:true}` |
| 链接 | `{type:'link', url:'...', children:[{text:'...'}]}` |

一个段落的 children 可以混合多个 leaf：
```
{type:'p', children:[
  {text:'前缀'},
  {type:'link', url:'x.md', children:[{text:'链接'}]},
  {text:'后缀', bold:true}
]}
```

## 写入机制（关键）

JoySpace 是**协同编辑器**，写入必须触发协同保存，否则刷新后丢失：

| 方法 | 是否协同保存 | 说明 |
|---|---|---|
| `editor.children = nodes; editor.onChange()` | ❌ | 仅本地状态，刷新丢失 |
| `editor.insertData(dataTransfer)` | ❌ | 不解析 markdown，原样插入文本 |
| 粘贴 markdown 文本（Meta+V） | ⚠️ | 会转换，但大段表格不可靠，光标难定位 |
| `editor.deleteFragment()` + `editor.insertFragment(nodes)` | ✅ | **推荐**，产生标准操作，协同保存 |

## 通过 React fiber 获取 editor 实例

JoySpace 不在 window 暴露 editor。需遍历 React fiber 树查找：

```js
function isEd(o) {
  return o && typeof o === 'object'
    && typeof o.insertData === 'function'
    && typeof o.apply === 'function'
    && 'children' in o && 'selection' in o;
}
const s = document.querySelector('.slate-editor');
const fk = Object.keys(s).find(k => k.startsWith('__react'));  // React 16: __reactInternalInstance$
let f = s[fk]; while (f.return) f = f.return;  // 走到 root
// BFS 整棵 fiber 树，检查每个 memoizedProps 的属性及二级属性
const q = [f], seen = new Set();
while (q.length) {
  const x = q.shift(); if (!x || seen.has(x)) continue; seen.add(x);
  const p = x.memoizedProps;
  if (p && typeof p === 'object') {
    for (const k of Object.keys(p)) {
      const v = p[k];
      if (v && typeof v === 'object' && !seen.has(v)) {
        if (isEd(v)) window.__E__ = v;
        for (const k2 of Object.keys(v)) { if (isEd(v[k2])) window.__E__ = v[k2]; }
      }
    }
  }
  if (x.child) q.push(x.child);
  if (x.sibling) q.push(x.sibling);
}
```
