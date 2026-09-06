---
name: joyspace-md-import
description: Use when needing to write Markdown content (with local images, tables, code blocks, headings) into a JD JoySpace online document (joyspace.jd.com). Covers JoySpace Slate editor automation, SSO login, image upload, and reliable collaborative write via Slate editor API.
---

# JoySpace Markdown 导入

## 概述

将本地 Markdown 文档（含图片、表格、代码块、标题）可靠地写入京东 JoySpace 在线文档。

JoySpace 是基于 Slate.js 的协同富文本编辑器，需京东 SSO 登录，**无公开写入 API**。本技能通过 Playwright 驱动浏览器，经 React fiber 取到 Slate editor 实例，用 `deleteFragment` + `insertFragment` 写入，确保内容协同保存到服务端。

## 何时使用

**适用：**
- 需要把本地 md 文档（含图片/表格）发布到 JoySpace 页面
- 需要批量、可复用地导入，而非手动复制粘贴
- md 含复杂结构（多表格、SVG 图、代码块、引用块）

**不适用：**
- 只需粘贴纯文本（直接手动粘贴即可）
- 目标是 JoySpace 的多维表格/思维导图/白板（本技能只处理标准文档）

## 解决思路（重点）

### 为什么不能简单粘贴？

实测发现 JoySpace 编辑器有三个关键特性，导致"常规自动化"全部失败：

1. **需 SSO 登录**：`curl` 目标页会被 302 重定向到 `authme.jd.com/login`。必须用真实浏览器 + 扫码登录，登录态需持久化复用。

2. **Slate 自定义选区，DOM selection 失效**：`Meta+A`、`document.execCommand('selectAll')`、shift+点击 全部 `selLen=0`，无法全选。键盘 `Backspace` 也删不掉内容。

3. **协同保存机制**：JoySpace 是协同编辑器，直接赋值 `editor.children = nodes; onChange()` 只改本地状态，**刷新后丢失**。必须用产生标准操作的 API（`deleteFragment`/`insertFragment`）才能触发协同保存。

### 为什么不能粘贴 markdown？

- `editor.insertData(dataTransfer)` **不解析 markdown**，原样插入文本
- 真实粘贴（Meta+V）会转换表格，但**大段表格转换不可靠**（39 个表只转出 2 个）
- 光标定位不可靠（`Meta+ArrowDown` 失效），文本粘贴会**覆盖已插入的图片**

### 最终方案：自建 Slate 节点 + editor API

核心思路：**绕过编辑器的粘贴解析，自己把 markdown 解析成 Slate 节点树，直接用 editor API 写入。**

```
Markdown ──解析──▶ Slate 节点树 ──insertFragment──▶ 协同保存到服务端
                  （自建解析器）      （editor API）
```

### 图片处理

JoySpace 不支持 SVG，外部图片 URL 也不能直接用。流程：

1. 提取 md 中所有 `![alt](path)` 引用，解析本地路径
2. SVG → PNG（Playwright 渲染截图，2x DPI 保证清晰）
3. **逐张粘贴上传**到 JoySpace，收集 CDN url（`https://apijoyspace.jd.com/v1/files/XXX/link`）
4. 将 url 填充到 Slate img 节点

### 获取 editor 实例

JoySpace 不在 `window` 暴露 editor。通过 **React fiber 树 BFS 查找**：从 `.slate-editor` 元素取 `__reactInternalInstance$` fiber，走到 root，遍历整棵树，在 `memoizedProps` 的属性中找到满足 `isEd(o)`（有 `insertData`/`apply`/`children`/`selection`）的对象。详见 [references/slate-schema.md](references/slate-schema.md)。

### Slate Schema

通过实测 `@jd/mf-doc-editor@1.9.8` 得到完整 schema：标题是 `{type:'p', header:N}`，表格是嵌套 `table/table-row/table-cell`，列表项各自独立，等。详见 [references/slate-schema.md](references/slate-schema.md)。

## 使用流程

### 前置准备（一次性）

```bash
cd ~/.pi/agent/skills/joyspace-md-import/scripts
npm install playwright          # 安装 playwright
npx playwright install chromium # 安装 chromium
```

### 首次使用（需扫码登录）

```bash
# 可见模式启动，扫码登录京东 SSO（登录态会持久化到 .userdata）
node ~/.pi/agent/skills/joyspace-md-import/scripts/import.js \
  --md /path/to/doc.md \
  --url https://joyspace.jd.com/h/personal/pages/XXXX
```

浏览器弹出后扫码登录，脚本自动完成后续导入。

### 后续使用（已登录）

```bash
# 可加 --headless 无头运行（已登录态可复用）
node ~/.pi/agent/skills/joyspace-md-import/scripts/import.js \
  --md /path/to/doc.md \
  --url https://joyspace.jd.com/h/personal/pages/XXXX \
  --headless
```

### 参数说明

| 参数 | 说明 | 默认值 |
|---|---|---|
| `--md <path>` | 源 markdown 文件（必需） | — |
| `--url <url>` | 目标 JoySpace 页面 URL（必需） | — |
| `--img-base <dir>` | 图片相对路径解析基础目录 | md 文件所在目录 |
| `--user-data <dir>` | 浏览器持久化目录（存登录态） | `<skill>/.userdata` |
| `--headless` | 无头模式（首次登录勿用） | 关 |
| `--no-verify` | 跳过刷新验证 | 关 |
| `--clear-only` | 仅清空目标文档 | 关 |

### 辅助工具：SVG 转 PNG

```bash
# 单个或多个
node scripts/svg2png.js a.svg b.svg --out ./pngs
# 批量
node scripts/svg2png.js --batch ./svgs --out ./pngs --scale 2
```

## 流程图

```
输入 md + url
      │
      ▼
[1] 解析 md 图片引用 ── SVG? ──是──▶ Playwright 渲染转 PNG
      │                                        │
      │◀───────────────────────────────────────┘
      ▼
[2] md → Slate 节点模板（img url 待填）
      │
      ▼
[3] 启动浏览器，访问 url，需登录则扫码
      │
      ▼
[4] 定位 Slate editor（React fiber BFS）
      │
      ▼
[5] 逐张粘贴图片上传 → 收集 CDN url → 填入节点 → 加 id
      │
      ▼
[6] deleteFragment 全选清空 + insertFragment 插入（协同保存）
      │
      ▼
[7] 刷新页面，从服务端重新加载验证一致性
```

## 验证标准

脚本自动对比"写入前"与"刷新后服务端"的 editor.children：

- 节点数一致
- 表格数、图片数、H2/H3 数一致
- 首节点文本匹配

只有刷新后服务端数据与写入一致，才算成功（`editor.children=nodes` 方式刷新会丢，本方案不会）。

## 常见错误

| 症状 | 原因 | 解决 |
|---|---|---|
| 重定向到 authme 登录页 | 未登录 | 首次用可见模式扫码，登录态持久化在 `.userdata` |
| `未找到 Slate editor` | 页面未加载完 / SPA 未挂载 | 增加等待时间，确认 `.slate-editor` 存在 |
| 刷新后内容丢失 | 用了 `children=nodes` 而非 `insertFragment` | 本脚本已用 `insertFragment`，勿改 |
| 表格未转换 | 用了粘贴而非 insertFragment | 本脚本自建节点，不依赖粘贴解析 |
| 图片上传失败 | 剪贴板权限/网络 | 检查 `permissions: ['clipboard-write']`，重试 |
| `Cannot find module 'playwright'` | 未安装依赖 | `cd scripts && npm install playwright` |
| npm install 清空了同目录数据 | npm 行为 | **数据文件不要放在 scripts 目录**，脚本已默认用 `.userdata`/`.tmp-png` 子目录隔离 |

## 实际效果

首次实战：将 722 行、含 39 个表格 + 7 张 SVG 图的 GLM-5.2 分析文档导入 JoySpace，刷新后服务端验证：表格 39 ✅、图片 7 ✅、H2 12 ✅、H3 50 ✅，文档标题自动从 H1 提取为"GLM-5.2 工作负载特征分析"。

## 文件结构

```
joyspace-md-import/
├── SKILL.md                      # 本文档
├── scripts/
│   ├── import.js                 # 主导入脚本（编排全流程）
│   └── svg2png.js                # SVG→PNG 辅助工具
├── references/
│   └── slate-schema.md           # Slate 节点 schema + fiber 定位方法
├── .userdata/                    # 浏览器持久化（登录态，gitignore）
└── .tmp-png/                     # SVG 转换缓存（gitignore）
```
