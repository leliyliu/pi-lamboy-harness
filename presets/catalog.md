# Presets 目录 — 启用面版本化

> "装了什么"由 `~/.pi/agent/settings.json` 的 `packages` 数组决定；本目录把这份配置版本化进仓库。
> 物理安装（`~/.pi/agent/npm/`、`mcp.json`、本仓库源码）**永不删除**——切换只改变启用面。

## 文件

| 文件 | 作用 |
|---|---|
| `minimal.v0.1.json` | 最小单元 v0.1（清单见 `plans/minimal.v0.1.md`；harness 8/10 模块 + personal + 5 整包 + pie 3 扩展 + focus-bell） |
| `minimal.v0.2.json` | v0.1 + 加回 harness perf-lab（`90-perf.ts`）：方案 A 目标驱动并行优化探索面（goal + subagents 并行 lane + bench_run/profile_parse/metric_compare 裁决）。2026-09-09 本地 + quant02 双端实测：启动 EXIT 0、无工具冲突、perf 工具入面。注意 `source` 是本地绝对路径，quant02 应用前需改为其仓库路径 |
| `full.snapshot.2026-09-06.json` | 全量基线（原 13 包 + personal 包；personal 取代了散落的 image2.ts / joyspace skill，散落副本已入 `~/.pi/agent/disabled/`） |
| `switch.mjs` | 切换脚本（备份 → 原子替换 packages → 装饰层联动 → diff 报告） |
| `catalog.md` | 本文件：按需加回的菜单 |

## 用法

```bash
node presets/switch.mjs                     # 查看预设 + 当前状态
node presets/switch.mjs diff minimal.v0.1   # 预览变更（不动文件）
node presets/switch.mjs minimal.v0.1        # 切换到最小集
node presets/switch.mjs full                # 恢复全量
```

切换后**重启 pi** 生效。回滚：恢复 `settings.json.bak-<时间戳>` 或直接 `switch.mjs full`。

## 已实测验证（2026-09-06，minimal.v0.1）

- ✅ 本地路径 + object-form 过滤生效：harness 8 入口加载，perf/latex 被过滤
- ✅ pie 过滤生效：loop/files/powerline-footer 加载，其余 14 扩展缺席
- ✅ 工具面实测（模型自报）：`enter_plan_mode, create_goal, ask_user_question, todo_list, generate_image, subagent, web_search, research, mcp, signal_loop_success...`；`bench_run/latex_compile/ask_user/todo(workflow)` 缺席
- ✅ skills 实测：`joyspace-md-import`（personal 包）、`pi-subagents`、`council-mode`
- ⚠️ **get_goal/update_goal 撞名是致命错误**：harness Goal 与 pi-multiloop quick-goal 同名，共存时 pi 直接中止启动（stderr 实证）。两者不可同时启用——minimal 集不含 multiloop，正确。

## 已知规则

1. **工具名冲突 = 启动失败**（不是降级）。加回任何包前，核对其工具名与当前启用面是否冲突。已知冲突对：
   - harness `get_goal`/`update_goal` ↔ pi-multiloop quick goal
   - personal `generate_image` ↔ 散落的 `~/.pi/agent/extensions/image2.ts`（散落副本已被 switch.mjs 移入 disabled/，不会复发）
2. **object-form 过滤只认 manifest 入口路径**。上游包改名入口文件会使过滤条目静默失效（该扩展消失）。每次 `pi update` 后建议跑 `switch.mjs diff <preset>` 或新会话工具清单对比。
3. **npm 版本 pin（`npm:pkg@1.2.3`）会被 `pi update --extensions` 跳过**。如需冻结某包版本再议。
