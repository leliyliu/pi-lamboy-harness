# perf-lab 设计文档

> 日期：2026-08-14 · 状态：**设计已批准**（2026-08-14 用户确认"符合预期"）
> 阶段：roadmap Phase 3 · 设计依据：plans/personal-harness-roadmap.md §6.2
> 裁定记录（问询 2026-08-14）：Q1=a 远程 GPU 执行 / Q2=b 框架基准格式 / Q3=a PyTorch profiler 优先 / Q4=a 松耦合

---

## 1. 定位与边界

**perf-lab = 测量层**，补全个人生态中"循环决策"（pi-multiloop）与"目标预算"（Goal）之外的测量缺口：

```
Goal（跑多久/预算）→ multiloop（编辑→测量→keep/revert）→ perf-lab（怎么测得准）
                                                              ↑ 本设计
```

**做**：远程执行基准、统计稳定化（P50/P95/MAD）、torch profiler 解析、A/B 显著性判定。

**不做**（松耦合裁定 Q4=a）：不驱动循环、不管理 lane、不做代码编辑——这些归 multiloop/worker。perf-lab 是独立工具集，multiloop 通过 verify command 消费其 JSON 输出，两边可独立演进。

## 2. 架构与模块结构

延续 core/adapter 分层（参照 truncation 最小模块模式）：

```
packages/core/perf/           纯逻辑，零 pi 依赖
├── types.ts                  RunSpec/BenchStats/ProfileReport/CompareResult 类型
├── stats.ts                  统计：P50/P95/P99、MAD 离群剔除、显著性判定（Mann-Whitney U 或 bootstrap）
├── parsers.ts                torch profiler JSON → 结构化热点表；stdout 抽取器（do_bench / pytest-benchmark 已知输出格式）
└── remote.ts                 ssh 命令构造（纯字符串/参数组装，不执行）

perf/                         adapter 层
└── index.ts                  3 个工具注册 + ssh 实际执行（child_process）
```

## 3. 三个工具

| 工具 | 输入 | 输出 | 要点 |
|---|---|---|---|
| `bench_run` | host（ssh 别名，如 kunshan-quant）、workdir、command、runs/预热轮、env | BenchStats JSON + 环境快照（GPU 型号/驱动/时钟） | 单次调用完成 N 轮统计；结果落盘 `.perf/<run-id>.json` |
| `profile_parse` | host、trace 文件路径（远端）、top N | 热点表：op 名/形状/耗时占比/calls/带宽利用率（有则） | LLM 可直接推理的紧凑 Markdown + JSON 双形态输出 |
| `metric_compare` | 两次 bench_run 的结果（或落盘文件路径） | 显著性结论 + 建议判定（improve/regress/noise） | 与 multiloop MAD 语义对齐；噪声大时建议加测而非误判 |

## 4. 关键设计决策

1. **ssh 执行走 Permission 权限链**：bench_run 内部生成的 ssh 命令经过策略链审批（Phase 2 修复后的守卫顺序对远端命令同样生效），不绕过审批。
2. **结果落盘 `.perf/<run-id>.json`**（项目目录）：multiloop 的 verify command 直接读文件消费——松耦合的实体接口。
3. **环境快照必采**（nvidia-smi 摘要 + 时钟锁定状态）：长周期探索中"今天比昨天慢"的首要原因是环境漂移。
4. **统计原则**：默认 MAD 剔除离群 + 报告 P50/P95 而非均值（GPU 计时噪声重）。

## 5. 测试与验收

- **纯逻辑全 TDD**：stats（构造数据验证分位数/显著性）、parsers（真实 do_bench / torch profiler 样例文件）、remote（命令组装快照测试）
- **adapter**：mock ssh 执行
- **验收场景**：在 kunshan-quant（H20 96G）上对一段真实量化 kernel：
  1. bench_run（20 轮）→ 改一行 → metric_compare 判定显著改善
  2. torch profiler trace 导出 → profile_parse 出热点表
- **规模预估**：core ~500 行 + adapter ~250 行 + 测试 ~300 行

## 6. 明确的非目标（YAGNI）

- 不做 ncu/nsys 解析（Phase 3+ 视使用痛点追加——Q3 裁定 torch profiler 优先）
- 不做本机 macOS 基准（Q1 裁定远端为主）
- 不做 UI 面板/图表渲染（输出即 Markdown+JSON）
- 不做循环编排（multiloop 领域）
