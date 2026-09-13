# Paseo worktree scripts 配置说明

> 日期：2026-09-13 · 对应任务：「设置 worktree scripts —— 添加 setup 命令，让新的 worktree 自动安装依赖并完成准备」
> 结论先行：**配置已存在且已通过端到端验证**（`paseo workspace create --isolation worktree` → 自动 setup → worktree 内 `npm test` 36/36 通过）。本文解释这套配置的作用、机制、用法与可选项。

## 0. TL;DR

- **是什么**：仓库根目录的 `paseo.json` 中 `worktree.setup` 字段，是一组在**每个新 worktree 工作区创建时自动执行**的 shell 命令（Paseo daemon 负责执行）。
- **解决什么问题**：`git worktree add` 只签出 git 跟踪的文件——新 worktree 里**没有 `node_modules`、没有 `vendor/sol-pi` 子模块内容、没有未跟踪的 `paseo.json`**，agent 进去连 `npm test` 都跑不了。setup 钩子让每个新 worktree 开箱即用。
- **当前配置做了两件事**：① 从主 checkout 本地克隆 `vendor/sol-pi` 子模块并锁定到 HEAD 记录的 pin 提交（离线、秒级）；② `npm install --prefer-offline`（走 npm 本地缓存）。
- **验证状态**：2026-09-13 实测——`paseo workspace create --isolation worktree` 创建工作区后约 60 秒自动完成 setup，worktree 内 `npm test` **36 passed, 0 failed**。

## 1. 背景：Paseo 与 worktree 工作区

Paseo（`/Applications/Paseo.app`，CLI 0.8.0 + daemon，本机监听 `127.0.0.1:6767`）是 AI coding agent 的工作区管理器：每个任务/agent 跑在一个 workspace 里，隔离级别二选一：

| 隔离 | 含义 |
|------|------|
| `local` | 直接在源 checkout（主仓库目录）里干活 |
| `worktree` | daemon 在 `~/.paseo/worktrees/<项目哈希>/<slug>` 下 `git worktree add` 一个独立目录，配独立分支（默认 branch-off 模式），agent 在里面随便改，不污染主 checkout |

创建 worktree 工作区的入口：

```bash
# CLI：直接创建
paseo workspace create --isolation worktree --project <id> --worktree-slug <slug>
# CLI：创建并启动 agent（还会自动生成标题/分支名等）
paseo run --new-workspace worktree "<任务描述>"
```

桌面 App 里新建 agent 时选 worktree 隔离同理。

**痛点**：worktree 是从 git 对象库签出来的「裸」目录。对本仓库而言缺三样东西：

1. `node_modules/` —— 跑 `npm test` / `tsc` 必需（devDependencies：pi-coding-agent、jiti、typescript 等）
2. `vendor/sol-pi/` 的**工作副本** —— 子模块内容不属于父仓库的 git 索引，`git worktree add` 后该目录为空；`npm test` 中的 `solpi-entry.test.mjs` 依赖它
3. `paseo.json` 本身未提交（untracked）—— 不会随 worktree 签出

没有 setup 钩子，每个新 worktree 都要 agent 或人手动跑一遍 `npm install` + 子模块初始化，且 agent 很可能不知道要装，直接在坏环境里干活。

## 2. 机制：命令何时、如何被执行（源码证据）

证据来源：`/Applications/Paseo.app/Contents/Resources/app.asar` 内 `node_modules/@getpaseo/server/dist/server/utils/worktree.js` 等（通过 `strings` 提取核对）。

### 2.1 配置 schema（`@getpaseo/protocol` 的 `PaseoConfigSchema`）

```js
export const PaseoConfigSchema = z.object({
    worktree: z.object({
        setup:      string | string[],          // ← 本文主角；单条可直接写字符串
        teardown:   string | string[],           // 归档/删除工作区时执行
        terminals:  [{ name?, command }],       // setup 完成后自动开的终端
        servicePorts: { range? | portScript? }, // worktree 端口分配策略
    }).optional(),
    scripts: { [name]: { type?: "service", command, port? } },  // paseo script start/stop 的受监管服务
    metadataGeneration: { title / branchName / commitMessage / pullRequest: { instructions } },
}).passthrough().catch({});
```

- `normalizeLifecycleCommands`：字符串→`[字符串]`，数组会过滤掉空白项。
- 解析失败时（`readPaseoConfig` 返回 `ok:false`）：工作区按「无脚本」处理并记 warn 日志，**不会**让工作区创建失败。

### 2.2 执行流程（`worktree-session.js` / `utils/worktree.js`）

```
workspace create --isolation worktree
  ├─ git worktree add（branch-off：从 base ref 建新分支；checkout-branch/checkout-pr 模式另有语义）
  ├─ seedPaseoConfigFile：把源 checkout 的 paseo.json 复制进 worktree（COPYFILE_EXCL，已存在则跳过）
  │    → 这就是为什么 paseo.json 不提交进 git 也能出现在新 worktree 里（已实测 diff 一致）
  ├─ getWorktreeSetupCommands(worktreePath)   ← 读的是 worktree 里的 paseo.json
  │    为空 → 直接标记 completed（零配置 = 零开销）
  ├─ resolveWorktreeRuntimeEnv：注入运行时环境变量（见 2.3）
  ├─ runWorktreeSetupCommands：逐条、按序执行
  │    cwd = worktreePath；经 shell 包装执行；stdout/stderr 实时流式上报
  │    （workspace_setup_progress 事件 → App UI / daemon.log 可见 command_started/output/command_completed）
  │    某条 exitCode ≠ 0 → 抛 WorktreeSetupError；
  │      - 后台 bootstrap 路径：标记 failed，若 setup 尚未开始过则归档工作区记录
  │      - 前台创建路径（cleanupOnFailure）：git worktree remove --force 直接回收
  └─ setup 全部成功 → runWorktreeAutoTerminals（worktree.terminals 配置的自动终端）
```

### 2.3 注入给 setup 命令的环境变量（`resolveWorktreeRuntimeEnv`）

| 变量 | 值 | 用途 |
|------|----|----|
| `PASEO_SOURCE_CHECKOUT_PATH` | 主 checkout（共享 git 对象库的原始仓库根，**不是** worktree） | setup 脚本从源目录借本地文件（子模块、.env、缓存） |
| `PASEO_ROOT_PATH` | 同上 | 向后兼容别名 |
| `PASEO_WORKTREE_PATH` | 本 worktree 绝对路径 | 自引用 |
| `PASEO_BRANCH_NAME` | worktree 的分支名 | 日志/命名 |
| `PASEO_WORKTREE_PORT` | daemon 预分配的空闲端口（持久化在 worktree 元数据里，重建复用并 assertPortAvailable） | worktree 内起 dev server 不撞端口 |

### 2.4 安全边界

- setup 是 **shell 命令**，执行的是 worktree 里那份 `paseo.json` 的内容。对 `checkout-pr` 模式（拉取外部 fork PR）daemon 有拦截：*"Workspace setup is blocked pending approval of code from a fork pull request"*，需人工批准（`paseo workspace setup <id>`）后才跑。
- `paseo workspace setup <id>`：对已存在的工作区「允许并运行 setup」，也是 setup 失败后手动重跑的入口。

## 3. 当前 `paseo.json` 逐行解读

```json
{
  "worktree": {
    "setup": [
      "if [ -n \"$PASEO_SOURCE_CHECKOUT_PATH\" ] && [ -d \"$PASEO_SOURCE_CHECKOUT_PATH/vendor/sol-pi\" ]; then git clone --quiet \"$PASEO_SOURCE_CHECKOUT_PATH/vendor/sol-pi\" vendor/sol-pi && git -C vendor/sol-pi checkout --quiet \"$(git ls-tree HEAD vendor/sol-pi | awk '{print $3}')\"; else git submodule update --init --recursive; fi",
      "npm install --prefer-offline"
    ]
  }
}
```

**命令 1 —— 子模块本地化**：
- 主分支：若源 checkout 里 `vendor/sol-pi` 已初始化，则 `git clone` **本地路径**（秒级、零网络），随后 checkout 到 `git ls-tree HEAD vendor/sol-pi` 取出的 **pin 提交**（当前 `d7ecfc0`）——保证与父仓库 HEAD 记录的子模块版本严格一致，而不是主 checkout 当前检出的版本。
- 兜底分支：源 checkout 没有子模块时退回 `git submodule update --init --recursive`（走 GitHub 远程，慢但保底）。
- 为什么不直接用 `git submodule update`：在 worktree 里它默认从远程 fetch NVlabs/SoL-Pi，网络慢/不稳；本地克隆方案把网络依赖消掉了。

**命令 2 —— 依赖安装**：`npm install --prefer-offline` 优先命中 npm 本地缓存，新 worktree 免下载大部分包。（替代方案 `npm ci`：严格按 lockfile、但每次全量装更慢；个人仓库迭代场景下 `--prefer-offline` 更实用。）

**没配的**：`teardown`（本仓库无 worktree 外部资源需要回收，daemon 删 worktree 目录即可）、`terminals`（无常驻 watch 任务需求）、顶层 `scripts`（无 dev server 型服务）。

## 4. 使用方式（日常怎么用）

```bash
# 给一个并行任务开隔离工作区（推荐 slug 语义化）
paseo workspace create --isolation worktree --project prj_f3612030f72fd724 --worktree-slug fix-ask-dialog

# 或者一句话直接派 agent 进 worktree 干活
paseo run --new-workspace worktree "修复 ask/dialog.ts 的空指针问题，跑通测试"

# 查看/管理
paseo workspace ls                       # 列工作区（含 worktree 类型）
paseo inspect <agent-id>                 # agent 详情
paseo workspace setup wks_xxx            # setup 失败后允许/重跑 setup
paseo workspace archive wks_xxx          # 归档：触发 teardown（若有）→ 删 worktree → 删分支
```

注意 `paseo script ls` 等命令在本仓库会报 *"Multiple workspaces use ... Pass --workspace"*——因为当前有多个工作区指向主 checkout，需 `--workspace <id>` 指定；这是 CLI 的多工作区消歧行为，不是配置问题。

## 5. 端到端验证记录（2026-09-13，本次会话实测）

| 步骤 | 命令/证据 | 结果 |
|------|-----------|------|
| 1. 创建 | `paseo workspace create --isolation worktree --project prj_f3612030f72fd724 --worktree-slug verify-wt-setup` | 工作区 `wks_8787507cecad3bb8`，路径 `~/.paseo/worktrees/1imxhu9i/verify-wt-setup`，分支 `verify-wt-setup` |
| 2. 自动 setup | daemon 后台执行（~60s 完成：本地克隆 sol-pi + npm install） | `node_modules` 55 个包、`vendor/sol-pi/` 有完整工作副本；daemon.log 有 `workspace_setup_progress` 事件 |
| 3. paseo.json 种子 | `diff worktree/paseo.json 主仓库/paseo.json` | 完全一致（untracked 文件由 `seedPaseoConfigFile` 复制） |
| 4. 子模块版本 | `git -C vendor/sol-pi rev-parse --short HEAD` vs `git ls-tree HEAD vendor/sol-pi` | 两者均为 `d7ecfc0`（锁定 pin 生效） |
| 5. 测试 | worktree 内 `npm test` | **36 passed, 0 failed** |
| 6. 回收 | `paseo workspace archive wks_8787507cecad3bb8` | worktree 目录与分支被删除 |
| 7. 历史遗留清理 | `git worktree remove /tmp/paseo-wt-hR0f --force`、`/tmp/paseo-wt2-3x5I`、`git branch -D test/paseo-setup` | 上个会话验证遗留的 /tmp worktree 与分支已全部清除 |

（背景：`paseo.json` 由 2026-09-13 早些时候的会话写入并手工验证过，该会话曾因 GLM-5.3 400/1210 错误中断、修复后完成——见 `plans/2026-09-13-glm53-jdcloud-1210-error-analysis.md`。本次是首次走 **daemon 全自动路径** 验证。）

## 6. 可选配置全景（备忘，当前均不需要）

```jsonc
{
  "worktree": {
    "setup":    [ "..." ],            // 已启用
    "teardown": [ "..." ],            // 例：清理全局缓存、停外部服务（cwd 必须在 worktree 内）
    "terminals": [                    // setup 成功后自动开的终端（App 内可见）
    //   { "name": "watch", "command": "npm test --watch" }
    ],
    "servicePorts": { "range": "12000-13000" }  // worktree 服务端口段（默认自动分配单端口）
  },
  "scripts": {                        // paseo script start/stop 管理；type=service 带 port 的受监管重启
  //  "dev": { "type": "service", "command": "vite --port $PASEO_WORKTREE_PORT", "port": 5173 }
  },
  "metadataGeneration": {            // App 生成标题/分支名/commit message 的提示词（本机已配 GLM-5.3）
  //  "branchName": { "instructions": "kebab-case, 带任务语义" }
  }
}
```

**本仓库建议保持现状**：扩展（pi extensions）无 dev server、无 watch 任务；`personal/skills/joyspace-md-import/scripts` 的独立 npm 依赖只在真的要用该技能时再装（README 已注明），塞进全局 setup 会拖慢每个 worktree 的创建。

## 7. 决策记录（已定，2026-09-13 21:39）

1. **paseo.json 已提交进 git**（用户拍板）——提交 `c75a439`「chore(paseo): add worktree setup script — auto deps + submodule bootstrap」，仅含 paseo.json 单文件。提交后新 worktree 直接从 git 检出该文件（已实测：`git worktree add` 检出内容与 HEAD 一致；`seedPaseoConfigFile` 因 EEXIST 跳过）。任何机器/克隆仓库后开 worktree 即自动生效；fork PR 场景 Paseo 有安全门（需人工批准才跑 setup）。
2. **保持最小配置**（用户拍板）——不加 teardown / terminals / scripts；本仓库无 dev server、无 watch 任务、无 worktree 外部资源需要回收，setup 保持最小集（子模块本地化 + npm install）。

### 7.1 事故记录：并发 agent 改写 paseo.json（已恢复）

- 21:44/21:47 两次：另一 Paseo agent（`27d562c`，sanitize 扩展调试会话，同目录 local 隔离）在用「继续执行」重放修复后的会话副本做端到端测试，而该会话原始任务就是写 paseo.json → 重放中的模型把**旧版草稿**（`git submodule update` + `npm install`）写回了主仓库工作区（evidence：`stat` mtime 21:44→21:47 连续变化；`diff` 显示旧草稿内容）。
- 危害有限：git HEAD `c75a439` 内的新版不受影响；其他文件 mtime 均为 16:2x–16:3x，未被误伤。
- 处置：`git checkout -- paseo.json` 恢复工作区（21:49:29，diff 与 HEAD 一致）。若该 agent 继续重放测试，可能再次改写——恢复动作需在其测试循环结束后再做，或让该 agent 停止/改到隔离目录重放。

## 8. 关键文件

| 文件 | 说明 |
|------|------|
| `paseo.json` | 本仓库的 Paseo worktree 配置（untracked，待决策是否提交） |
| `/Applications/Paseo.app/.../app.asar` → `@getpaseo/server` `utils/worktree.js`、`session/worktree-session.js` | 机制源码（setup 执行、seed、runtime env、teardown） |
| `~/.paseo/worktrees/` | daemon 管理的 worktree 根（`<项目哈希>/<slug>`） |
| `plans/2026-09-13-glm53-jdcloud-1210-error-analysis.md` | 前史：paseo.json 的诞生与首次手工验证记录 |
