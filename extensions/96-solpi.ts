// ============================================================
// Extension entry: SoL-Pi (trimmed) — token-efficiency mechanisms
// vendored from NVlabs/SoL-Pi as a git submodule (pinned d7ecfc0).
//
// 裁剪决策（2026-09-12，详见调研笔记「SoL-Pi-调研报告-2026-09-12」）：
// 仅启用两个纯本地机制 — 不额外调用模型、不外发任何内容到远端：
//   1. Action Fusion   — edit/write 支持 then_run 参数：编辑 + 验证命令
//                        合并为一次工具调用，省掉中间一次模型往返
//   2. ObservationPack — 大工具结果归档到会话目录，上下文只保留稳定句柄，
//                        通过 obs_recall 工具按字节偏移分页召回，消除大
//                        结果在后续请求中的重复重放
//
// 刻意不启用（裁剪掉的部分）：
//   - Evidence-Preserving Reducer（tool_result 委派压缩）：需将诊断日志
//     外发给配置的 reducer 模型，且与 80-truncation.ts 的磁盘溢出功能
//     重叠 —— 二者取其一即可，本 harness 保留自己的 truncation
//   - Online Context Compact（子任务边界触发压缩）：依赖 agent_settled /
//     compact() 的精确语义，官方测试锁 0.84.2，当前运行时宿主为 0.85.1，
//     风险后置（待官方跟进新版本后再评估）
//
// 逃生开关：PI_LAMBOY_SOLPI=0 完全禁用本入口（不注册任何机制）。
// 加载顺序：96- 前缀保证在所有 lamboy 扩展之后加载——SoL-Pi 的 context
// transformer（ObservationPack 投影）要求后于第三方 transformer 注册，
// 这样它的 context-growth 观察才能覆盖先加载的扩展（见其
// docs/compatibility.md「Interactive TUI / Online Context Compact」章节）。
//
// 运行时依赖：@earendil-works/* 导入由 pi 的 jiti 别名解析到宿主 pi
// 安装（见 pi loader：dist/core/extensions/loader.js getAliases）；
// harness node_modules 中的 0.84.2 devDeps 仅用于 typecheck，与 SoL-Pi
// 官方测试基线一致。
//
// 与现有扩展的已知交互：
//   - 80-truncation.ts（tool_result）：互补——truncation 在首次插入时
//     溢出超大结果，ObservationPack 管理已入库结果的后续重放；截断后的
//     预览通常低于 pack 阈值，不冲突
//   - 30-permission.ts（tool_call）：Action Fusion 的 then_run 在 edit
//     工具内部执行命令，权限对话框看到的是 edit 而非 bash——auto 模式
//     下可接受；需要命令级审批时设 PI_LAMBOY_SOLPI=0 临时禁用
//   - 40-goal.ts（session_compact）：无交集（OCC 未启用）
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerActionFusion } from "../vendor/sol-pi/src/sol-pi/extensions/action-fusion/index.ts";
import { registerObservationPack } from "../vendor/sol-pi/src/sol-pi/extensions/observation-pack/index.ts";

export default function solPiTrimmed(pi: ExtensionAPI): void {
	if (process.env.PI_LAMBOY_SOLPI === "0") return;
	registerActionFusion(pi);
	registerObservationPack(pi);
}
