# 2026-10-10 quant02 pi 配置同步方案

## 目标

将 Mac 本地 pi 配置（`~/.pi/agent/*`）与当前仓库（`pi-lamboy-harness`）工作区状态同步到 quant02，使两侧 pi 运行环境一致。

## 调查结论（证据）

### 双侧基线一致项

| 项目 | Mac 本地 | quant02 | 结论 |
|---|---|---|---|
| pi 版本 | 1.1.0 (`/opt/homebrew/bin/pi`) | 1.1.0 (`~/.nvm/.../v22.23.2/bin/pi`) | 一致 |
| 仓库 HEAD | bc8fde3 | bc8fde3 | 一致 |
| models.json | md5 56a4ac80… | md5 56a4ac80… | 一致 |
| permissions.json | yolo | yolo | 一致 |
| pi-lifeline.json | 内容相同（仅尾换行差 350/349B） | 同左 | 微差，同步字节 |
| disabled/extensions/image2.ts | md5 eca9ab69… | md5 eca9ab69… | 一致，不动 |
| settings.json packages 列表 | 同 quant02（仅路径前缀 /Users vs /home） | — | 结构一致，路径保留远端 |

### 需同步项（Mac → quant02）

1. **仓库工作区未提交变更**（git status 差异，9/29 Goal 预算规范工作）：
   - `CHANGELOG.md`、`README.zh-CN.md`、`extensions/20-plan.ts`、`packages/core/goal/budget.ts`、`packages/core/goal/tools.ts`、`tests/goal.test.mjs`（6 个 modified）
   - `plans/2026-09-29-goal-token-budget-policy.md`（untracked 新文件）
   - 不同步：`personal/skills/joyspace-md-import/.tmp-png/`（临时垃圾）
2. **AGENTS.md**：quant02 为 9/13 版本（4034B），缺 9/29「Goal 预算规范」章节 → 用本地版（4672B）覆盖，备份 `AGENTS.md.bak-20261010-sync`
3. **settings.json**：`defaultThinkingLevel` xhigh → high（对齐本地；对默认模型 GLM-5.3 两者映射同为 max，行为等价），备份 `settings.json.bak-20261010-sync`
4. **npm 扩展包版本**（本地 vs quant02 落后）：
   - pi-mcp-adapter 5.2.0 vs 2.35.0
   - pi-subagents 0.76.1 vs 0.70.1
   - pi-web-access 0.38.0 vs 0.30.0
   - @lincoln504/pi-research 1.7.10 vs 1.6.19
   - 同步 `~/.pi/agent/npm/package.json` + `package-lock.json`（备份到 `npm/bak-20261010/`），随后在 quant02 `npm install`
5. **MCP 配置文件名**：adapter 5.x 读 `mcp-adapter.json`（Mac 现状：有 mcp-adapter.json、无 mcp.json）；quant02 2.x 读 `mcp.json`。升级成功后将 `mcp.json` 改名 `mcp-adapter.json`（内容一致），镜像 Mac 状态；失败则保持 2.x + mcp.json 不破坏现状
6. **杂项文档/状态**：`MCP-ZOTERO.md`、`QUANT02-MCP-ZOTERO.md`、`jdcloud-modelservice.md`、`mcp-onboarding.json`（piBuiltinMcpHandledVersion 5.2.0）

### 保留 quant02 本地化项（不覆盖，避免破坏）

- `image2.json`：多 `proxy: 127.0.0.1:17893` 字段（quant02 出网必需）
- `trust.json`：远端专属路径（/export/liulian/...）
- `~/.pi/web-search.json`（toolNames 重命名）、`skills/eli5`、`models-store.json`（自刷新缓存）
- `~/.npmrc` proxy=17893
- `disabled/skills/joyspace-md-import`（Mac 侧禁用副本，含 playwright/node_modules 垃圾，无同步价值）

### 网络障碍与修复

- quant02 直连 registry.npmjs.org / registry.npmmirror.com 超时，经 17893 隧道 reset——根因：**Mac 的 FlClash 代理未运行**（7890 无监听）
- 修复：`open -a FlClash` 拉起代理，恢复既有 autossh 隧道（RemoteForward 17893 → Mac:7890）

## 执行顺序

1. ✅ 调查与差异清单（本文档）
2. 拉起 FlClash，恢复 quant02 出网
3. rsync 仓库 7 个变更文件（git-status 派生清单）
4. 同步 ~/.pi/agent 配置（先备份）
5. quant02 `npm install`（npm 升级）→ mcp.json 改名 mcp-adapter.json
6. 验证：`pi list`、`pi -p` 冒烟、zotero 23120、git status 对齐、npm 版本对齐、仓库测试 `npm test`

## 执行记录

| # | 步骤 | 结果 |
|---|---|---|
| 1 | `open -a FlClash` 拉起代理 | core 运行但无监听端口（GUI 开关未开），7893 链路仍断 |
| 2 | 自建临时链路：Mac `python3 /tmp/pi-sync-proxy.py 8899`（HTTP CONNECT 代理）+ `ssh -f -N -R 17895:127.0.0.1:8899 quant02` | quant02 经 17895 访问 registry.npmjs.org → 200（修复了脚本里漏 `t.start()` 的 bug） |
| 3 | rsync 仓库 7 个变更文件（git-status 派生清单） | quant02 git status 与本地完全一致：6 M + 1 ??（见下） |
| 4 | 备份并同步 ~/.pi/agent 配置：AGENTS.md、MCP-ZOTERO.md、QUANT02-MCP-ZOTERO.md、jdcloud-modelservice.md、pi-lifeline.json、mcp-onboarding.json；settings.json thinkingLevel xhigh→high | 备份：AGENTS.md/settings.json/mcp.json→*.bak-20261010*；npm/bak-20261010/ 存 package.json+lock |
| 5 | rsync npm package.json + package-lock.json（含会话内自动升级的 pi-subagents 0.77.0） | 声明一致 |
| 6 | quant02 `npm install`（--proxy 17895 覆盖 .npmrc 失效的 17893） | 6 分钟，25 added / 193 removed / 220 changed |
| 7 | `mv mcp.json mcp-adapter.json`（镜像 Mac 5.x 布局，原文件已备份） | 完成 |

注：JD 内网镜像（mirrors.tools.jd.com 等）全部不可达（000），Mac 直连 npmjs 为 200，quant02 仅能经隧道出网。

## 验证结果（全部通过）

| 验证项 | 命令 | 结果 |
|---|---|---|
| 仓库工作区对齐 | quant02 `git status --short` | 与本地完全一致：`M CHANGELOG.md / README.zh-CN.md / extensions/20-plan.ts / packages/core/goal/budget.ts / packages/core/goal/tools.ts / tests/goal.test.mjs` + `?? plans/2026-09-29-goal-token-budget-policy.md` |
| AGENTS.md 对齐 | md5 比对 | 双侧 `68d6acc301efc531e0d58eb197b317a1` 一致 |
| npm 版本对齐 | lockfile 查询 | pi-mcp-adapter 5.2.0 / pi-subagents 0.77.0 / pi-web-access 0.38.0 / pi-research 1.7.10 / pi-agent-extensions 0.5.4 / pi-focus-bell 0.1.0 / grill-with-docs 0.3.0，与本地相同 |
| 扩展加载 | quant02 `pi list` | 全部 8 个包正常加载，无错误 |
| 模型调用冒烟 | quant02 `pi -p --model jdcloud/kimi-k3` | 回复「正常」（首次 GLM-5.3 遇 429 分钟限流，换 kimi-k3 后通过；扩展均加载成功） |
| Zotero MCP | mcp-cache.json mtime + 模型自报工具 | 缓存刷新为 10-10 15:29（同步前 10-08），含 zotero；模型确认 `mcp__zotero` 工具在列；23120 隧道端口活（HTTP 404 = 服务可达） |
| 仓库测试 | quant02 `npm test` | 36 passed, 0 failed — all suites passed（9/29 goal 预算改动在 Linux 上跑通） |

### 遗留事项（10-10 16:00 更新）

1. ~~FlClash GUI 开关未开~~ → **已解决**：用户手动开启后验证 Mac 7890 → 200，quant02 常驻 17893 隧道 → 200；quant02 经 17893 访问 modelservice.jdcloud.com 可达（HTTP 400 = 端点响应、仅缺鉴权，预期行为）。image2 生图代理、`.npmrc` 默认 proxy 均恢复可用。（注：Mac 上非 sudo `lsof` 看不到 7890 监听，因 FlClash core 以 root 运行，功能验证为准）
2. ~~临时链路~~ → **已清理**：`ssh -R 17895` 与 Mac `/tmp/pi-sync-proxy.py` 均已停止，quant02 上仅余常驻 17893 监听。
3. 本地 pi-subagents 在会话内自动升级 0.76.1→0.77.0（package.json+lock+node_modules 均已更新），两侧现均为 0.77.0。
4. 双侧仓库工作区均为未提交状态（6 M + 2 ?? + 含本文档），提交由用户决定后两侧再同步。
5. 保留 quant02 本地化配置未覆盖（见「保留 quant02 本地化项」）。
