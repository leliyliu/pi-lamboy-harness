# perf-lab 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为个人 harness 新增 perf-lab 模块——远程 GPU 基准执行（bench_run）、PyTorch profiler 解析（profile_parse）、A/B 显著性判定（metric_compare），作为测量层与 pi-multiloop 松耦合。

**架构：** core/adapter 分层（设计文档 plans/2026-08-14-perf-lab-design.md 已批准）。`packages/core/perf/` 纯逻辑零 pi 依赖（stats/parsers/remote/types）；`perf/index.ts` adapter 注册 3 工具 + ssh 实际执行。结果落盘 `.perf/<run-id>.json`，multiloop verify command 直接消费。

**技术栈：** TypeScript (strict, es2024) · node 测试（jiti 加载 TS，参照 tests/tui-box.test.mjs 头部模式）· typebox · ssh（child_process spawn）

**设计依据：** plans/2026-08-14-perf-lab-design.md（已批准，四项裁定：远程执行/框架基准/torch profiler 优先/松耦合）

**边界声明：** 不做 ncu/nsys、不做本机基准、不做 UI 面板、不做循环编排（设计 §6 非目标）。验收场景中"在 kunshan-quant 上真实跑分"属部署后人工验收，不在本计划自动化范围（adapter 测试用 mock ssh；真实远端验收在收尾时由控制者可选执行）。

**全局约束（审查者透镜）：**
- core/perf 四文件零 pi import（grep 验证：不得出现 `@earendil-works` 或 `pi-coding-agent`）
- 所有数值统计先写测试再实现（TDD RED→GREEN 证据入报告）
- 工具注册后 `pi -e` 加载零报错
- commit 粒度 = 任务粒度，message 用各任务给定文本

---

## 文件结构总览

| 动作 | 路径 | 职责 |
|---|---|---|
| 创建 | `packages/core/perf/types.ts` | RunSpec/BenchStats/ProfileReport/CompareResult/EnvSnapshot 类型 |
| 创建 | `packages/core/perf/stats.ts` | quantiles/mad/outlier 剔除/mannWhitneyU/compareStats |
| 创建 | `packages/core/perf/parsers.ts` | parseTorchProfile / extractBenchValue（stdout 抽取） |
| 创建 | `packages/core/perf/remote.ts` | buildSshCommand/buildEnvSnapshotCmd/buildBenchScript（纯字符串组装） |
| 创建 | `perf/index.ts` | adapter：registerPerfTools(pi)——3 工具 + spawn ssh + 落盘 |
| 创建 | `tests/perf-stats.test.mjs` | stats TDD |
| 创建 | `tests/perf-parsers.test.mjs` | parsers TDD（含真实格式样例夹具） |
| 创建 | `tests/perf-remote.test.mjs` | remote 命令组装快照 |
| 创建 | `tests/perf-adapter.test.mjs` | adapter mock-ssh 全链路 |
| 修改 | `index.ts` | 接线 registerPerfTools + import |
| 修改 | `package.json` | files 数组加 "perf/" |
| 修改 | `README.md` / `README.zh-CN.md` / `CHANGELOG.md` | 工具表 + 0.12.0 条目 |

---

### 任务 1：core/perf/types.ts + stats.ts（统计核心，TDD）

**文件：**
- 创建：`packages/core/perf/types.ts`、`packages/core/perf/stats.ts`
- 测试：`tests/perf-stats.test.mjs`

- [ ] **步骤 1：编写失败的测试**

测试文件头部沿用 jiti 加载模式（复制 tests/tui-box.test.mjs 第 8-25 行的 jitiUrl/createJiti/resolveSpec 样板，loadTs 帮助函数）。测试用例（check() 风格，文件尾 `console.log(\`${pass} passed, ${fail} failed\`); process.exit(fail?1:0)`）：

```javascript
const stats = loadTs("packages/core/perf/stats.ts");

// quantiles
check("quantiles: p50 of [1..9] === 5", stats.quantile([1,2,3,4,5,6,7,8,9], 0.5) === 5);
check("quantiles: p95 of 100 zeros + one 1000 === 0 (linear interp)", stats.quantile([...Array(100).fill(0), 1000], 0.95) === 0);
check("quantiles: empty array returns null", stats.quantile([], 0.5) === null);

// MAD (median absolute deviation)
check("mad: [1,1,2,2,4,6,9] → median 2, MAD 1", stats.mad([1,1,2,2,4,6,9]) === 1);

// outlier 剔除（MAD 法：|x - med| > 3.5 * MAD 剔除）
check("filterOutliers: removes the 1000 spike", JSON.stringify(stats.filterOutliers([...Array(20).fill(5), 1000])) === JSON.stringify(Array(20).fill(5)));
check("filterOutliers: all-identical data kept intact", stats.filterOutliers([3,3,3]).length === 3);

// Mann-Whitney U（用于 A/B 显著性）
const bigA = Array(20).fill(10).map((v,i)=>v+i*0.1);      // 10.0..11.9
const bigB = Array(20).fill(20).map((v,i)=>v+i*0.1);      // 20.0..21.9 — 完全分离
const noisy = Array(20).fill(10).map((v,i)=>v+(i%2?0.5:-0.5));
const mw = stats.mannWhitney(bigA, bigB);
check("mwU: separated groups → p < 0.01", mw.p < 0.01);
check("mwU: identical-ish groups → p > 0.05", stats.mannWhitney(bigA, noisy).p > 0.05);

// compareStats：显著性 + 判定建议
const cs = stats.compareStats(
  { values: bigA, label: "base" },
  { values: bigB, label: "cand" },
  { direction: "lower" }   // lower is better
);
check("compare: separated improvement → verdict improve", cs.verdict === "improve");
check("compare: reports deltaPct", typeof cs.deltaPct === "number" && cs.deltaPct < -40);
check("compare: noise case → verdict noise", stats.compareStats({values: bigA, label:"a"},{values: noisy, label:"b"},{direction:"lower"}).verdict === "noise");
```

- [ ] **步骤 2：运行确认失败**

```bash
node tests/perf-stats.test.mjs 2>&1 | tail -3   # 预期：Cannot resolve / load packages/core/perf/stats.ts（文件不存在）
```

- [ ] **步骤 3：实现 types.ts + stats.ts（最少通过）**

`types.ts`（类型先行，全部导出）：

```typescript
// perf-lab core types — pure, no host imports.
export interface RunSpec {
  host: string; workdir: string; command: string;
  runs: number; warmup: number; env?: Record<string, string>;
  parser?: "auto" | "json-report" | "stdout-number";
}
export interface BenchStats {
  runId: string; label?: string; spec: RunSpec;
  values: number[]; unit: string;
  n: number; p50: number; p95: number; p99: number; mad: number;
  outliersDropped: number; createdAt: string;
}
export interface ProfileReport {
  runId: string; source: string; topN: ProfileEntry[]; totalUs: number; extractedAt: string;
}
export interface ProfileEntry {
  name: string; selfUs: number; selfPct: number; calls: number; shape?: string;
}
export interface CompareResult {
  base: string; cand: string; unit: string;
  p50Base: number; p50Cand: number; deltaPct: number;
  p: number; significant: boolean; verdict: "improve" | "regress" | "noise";
  advice: string;
}
```

`stats.ts`：quantile（线性插值，空数组 null）、mad、filterOutliers（|x−med| > 3.5×MAD，MAD=0 时全保留）、mannWhitney（正态近似 z→p，双尾，n<8 返回 p=1 保守值）、compareStats（各先 filterOutliers，Mann-Whitney p<0.05 → significant；verdict = significant ? (方向性 delta 判 improve/regress) : "noise"；advice 文案：noise 时建议加测 runs）。

- [ ] **步骤 4：运行确认通过**

```bash
node tests/perf-stats.test.mjs 2>&1 | tail -2   # 预期全过（10+ passed, 0 failed）
```

- [ ] **步骤 5：Commit**

```bash
git add packages/core/perf/ tests/perf-stats.test.mjs
git commit -m "feat(perf): core stats — quantiles/mad/outliers/mann-whitney/compare (TDD)"
```

---

### 任务 2：core/perf/parsers.ts（torch profiler + stdout 抽取，TDD）

**文件：**
- 创建：`packages/core/perf/parsers.ts`
- 测试：`tests/perf-parsers.test.mjs`（含内联夹具）

- [ ] **步骤 1：编写失败的测试**

夹具（内联 JSON 常量，模拟 torch.profiler export_chrome_trace 的最小结构——events 数组含 cat==="kernel"/"cpu_op" 的 X 类事件，args 有外部字段）：

```javascript
const TORCH_TRACE = {
  traceEvents: [
    { ph: "X", cat: "cpu_op", name: "aten::matmul", ts: 1000, dur: 500, args: { External id: 1, Input Dims: [[128,256],[256,512]] } },
    { ph: "X", cat: "kernel", name: "ampere_sgemm_128x64_tn", ts: 1100, dur: 420, args: {} },
    { ph: "X", cat: "cpu_op", name: "aten::add", ts: 1600, dur: 50, args: { External id: 2 } },
    { ph: "X", cat: "kernel", name: "vectorized_elementwise_kernel", ts: 1650, dur: 45, args: {} },
    { ph: "M", ...(()=>({}) )(), },  // 非X事件应被忽略（补全为 {ph:"M",name:"ProcessSheet"}）
  ],
};
```

用例：

```javascript
const rep = parsers.parseTorchProfile(TORCH_TRACE, 5);
check("torch: totalUs = 1000..1695 区间的事件时长合计", rep.totalUs === 500 + 420 + 50 + 45);
check("torch: top1 是 matmul(500) 或 sgemm(420) 按排序", rep.topN[0].name === "aten::matmul");
check("torch: shape 提取自 Input Dims", rep.topN.find(e=>e.name==="aten::matmul").shape === "128x256 @ 256x512");
check("torch: kernel 与 cpu_op 都在表", rep.topN.some(e=>e.name.includes("sgemm")) && rep.topN.some(e=>e.name==="aten::add"));
check("torch: selfPct 合计约 100", Math.abs(rep.topN.reduce((s,e)=>s+e.selfPct,0) - 100) < 5);

// stdout 抽取
check("stdout: do_bench 风格（'123.45 us'）", parsers.extractBenchValue("mean = 123.45 us")?.value === 123.45);
check("stdout: 裸数字最后一行", parsers.extractBenchValue("loading...\n42.17\n")?.value === 42.17);
check("stdout: do_bench 多行统计取 mean", parsers.extractBenchValue("205.31 us\n1.2 ms\nmean: 205.31 us")?.value === 205.31 || parsers.extractBenchValue("mean = 205.31 us\nstd = 2.1")?.value === 205.31);
check("stdout: 无数字返回 null", parsers.extractBenchValue("done, no numbers") === null);
check("stdout: unit 识别 ms/us/s", parsers.extractBenchValue("990.3 ms")?.unit === "ms");
```

（shape 格式化为 `AxB @ CxD`——实现时具体拼接规则以测试断言为准；extractBenchValue 优先级：显式 "mean = X" / "mean: X" > 最后一行裸数字）

- [ ] **步骤 2：运行确认失败**（文件不存在）

- [ ] **步骤 3：实现 parsers.ts**

- `parseTorchProfile(trace, topN)`：过滤 ph==="X" 且 cat ∈ {kernel, cpu_op, gpu_memcpy}；按 name 聚合（calls 累加、selfUs 累加 dur）；Input Dims 二维数组 → shape 字符串（"128x256 @ 256x512"）；selfPct = selfUs/total×100（total=聚合后合计）；按 selfUs 降序取 topN；返回 ProfileReport（source=文件名或 "<memory>"）。
- `extractBenchValue(stdout)`：正则匹配顺序——`/mean\s*[=:]\s*([\d.]+)\s*(ms|us|µs|s)?/i` → 最后一个非空行 `/^([\d.]+)\s*(ms|us|µs|s)?$/` → null。返回 `{value, unit: unit||"ms"}` 或 null。

- [ ] **步骤 4：运行确认通过**

- [ ] **步骤 5：Commit**

```bash
git add packages/core/perf/parsers.ts tests/perf-parsers.test.mjs
git commit -m "feat(perf): torch-profiler parser + stdout bench extractor (TDD)"
```

---

### 任务 3：core/perf/remote.ts（ssh 命令组装，快照测试）

**文件：**
- 创建：`packages/core/perf/remote.ts`
- 测试：`tests/perf-remote.test.mjs`

- [ ] **步骤 1：编写失败的测试**

```javascript
const remote = loadTs("packages/core/perf/remote.ts");

// bench 循环脚本：在远端跑 warmup + N 轮，每轮打印一行 "PERF_VAL <number> <unit?>"
const script = remote.buildBenchScript({ runs: 5, warmup: 2, env: { CUDA_VISIBLE_DEVICES: "0" } }, "python bench.py");
check("script: contains warmup loop", script.includes("for i in $(seq 1 2)") || script.includes("seq 1 2"));
check("script: contains runs loop", script.includes("seq 1 5"));
check("script: exports env", script.includes("export CUDA_VISIBLE_DEVICES=0"));
check("script: prints PERF_VAL marker", script.includes("PERF_VAL"));
check("script: single-quoted inner command", script.includes("'python bench.py'") || script.includes("python bench.py"));

// ssh 命令组装
const ssh = remote.buildSshCommand("kunshan-quant", "/workspace/x", script);
check("ssh: host first", ssh[0] === "ssh" && ssh[1] === "kunshan-quant");
check("ssh: cd workdir && exec script", ssh[2].includes("cd /workspace/x"));
check("ssh: uses bash -lc wrapper", ssh[2].startsWith("bash -lc"));

// 环境快照命令
const snap = remote.buildEnvSnapshotCmd();
check("snapshot: nvidia-smi query", snap.includes("nvidia-smi --query-gpu=name,driver_version,clocks.sm"));
check("snapshot: clock lock check (nvidia-smi -q -d CLOCK 落盘由 adapter 拼接，此处命令存在)", snap.length > 20);
```

- [ ] **步骤 2：运行确认失败**

- [ ] **步骤 3：实现 remote.ts（纯组装，不执行）**

- `buildBenchScript(spec, cmd)`：生成 bash 片段——`export` 每个 env；`for i in $(seq 1 W)` 静默预热；`for i in $(seq 1 N)` 循环执行 `eval` 内的单引号命令并 grep 输出行首 `PERF_VAL`（脚本模板内自带：`eval "$CMD" | grep -oP 'PERF_VAL \K[\d.]+' || eval "$CMD" | tail -1`——实现以测试断言为准，保证每轮产生一行可被 adapter 收集的 stdout）。
- `buildSshCommand(host, workdir, script)`：`["ssh", host, "bash -lc 'cd <workdir> && <script（单引号转义）>'"]`（数组三元素，script 内单引号转义为 `'\''`）。
- `buildEnvSnapshotCmd()`：返回 `nvidia-smi --query-gpu=name,driver_version,clocks.sm,clocks.max.sm --format=csv` 字符串。

- [ ] **步骤 4：运行确认通过**

- [ ] **步骤 5：Commit**

```bash
git add packages/core/perf/remote.ts tests/perf-remote.test.mjs
git commit -m "feat(perf): remote ssh command assembly — bench loop script/snapshot cmd (snapshot tests)"
```

---

### 任务 4：adapter perf/index.ts（3 工具 + mock-ssh 测试）

**文件：**
- 创建：`perf/index.ts`
- 测试：`tests/perf-adapter.test.mjs`
- 修改：`index.ts`（接线）、`package.json`（files 加 "perf/"）

- [ ] **步骤 1：编写失败的测试（mock ssh）**

测试 mock 策略：monkey-patch `node:child_process` 的 spawn——通过让 adapter 从可注入的 `execSsh` 函数走（`perf/index.ts` 导出 `__setExecForTest(fn)` 注入口，生产默认真实 spawn）。用例：

```javascript
// __setExecForTest 拦截：模拟远端输出 5 轮 "PERF_VAL 12.3" + 2 轮预热 + nvidia-smi 快照行
// 1. bench_run 全链路：spec → 统计 → 落盘 .perf/<id>.json → 返回 markdown 摘要
const out = await adapter.benchRunForTest({ host:"mock", workdir:"/w", command:"python b.py", runs:5, warmup:1 });
check("bench_run: returns p50", typeof out.stats.p50 === "number");
check("bench_run: warmup 轮不计入 values", out.stats.values.length === 5);
check("bench_run: env snapshot attached", out.snapshot.includes("H20"));
check("bench_run: file written", fs.existsSync(out.filePath) && JSON.parse(fs.readFileSync(out.filePath)).stats.p50 > 0);

// 2. metric_compare：两个文件 → CompareResult markdown
const cmp = await adapter.compareForTest(out.filePath, out2.filePath, "lower");
check("compare: verdict in enum", ["improve","regress","noise"].includes(cmp.verdict));

// 3. profile_parse：mock 返回 torch trace JSON 字符串 → ProfileReport markdown
const rep = await adapter.profileParseForTest("/t/trace.json", 5);
check("profile: markdown table header", rep.markdown.includes("| op |") || rep.markdown.includes("op/kernel"));
```

（mock 输出夹具在测试内构造；tempdir 放 .perf 落盘目录，测试结束清理）

- [ ] **步骤 2：运行确认失败**

- [ ] **步骤 3：实现 perf/index.ts**

结构（参照 todo/index.ts 注册模式）：

- `registerPerfTools(pi)`：`pi.registerTool` × 3——
  - `bench_run`：参数 host/workdir/command/runs(默认 10)/warmup(默认 2)/env/label；execute：buildBenchScript → buildSshCommand → 真实 execSsh（spawn，捕获 stdout 行收集 PERF_VAL + 快照）→ filterOutliers → quantile → BenchStats → 写 `.perf/bench-<timestamp>-<label>.json`（含 spec/stats/snapshot）→ 返回 markdown 摘要（P50/P95/MAD/环境行）+ filePath
  - `profile_parse`：参数 host/tracePath/topN(默认 15)；远端 `cat <tracePath>` 取回 JSON → parseTorchProfile → 落盘 `.perf/profile-<ts>.json` → markdown 热点表
  - `metric_compare`：参数 fileA/fileB/direction("lower"|"higher"，默认 lower)；读两文件 → compareStats → markdown（verdict/deltaPct/p/advice）
- **权限链走法**：execute 内部不 spawn 裸 ssh 绕过审批——ssh 命令组装后交由 pi 的 bash 工具语义执行（实现方式：execSsh 默认实现调用 `child_process.spawn`，但工具 execute 本身就处于 pi 的 tool_call 审批之下——bench_run 作为工具调用已被策略链门控，无需额外机制；在文件头注释说明这一点）
- `__setExecForTest(fn)` 注入口 + `benchRunForTest/compareForTest/profileParseForTest` 三个测试面函数（内部与工具 execute 共用同一实现路径）

- [ ] **步骤 4：接线 index.ts 与 package.json**

index.ts：`import { registerPerfTools } from "./perf/index";` + 在工具注册区（todo 注册点之后）加 `registerPerfTools(pi);`。
package.json files 数组追加 `"perf/"`。

- [ ] **步骤 5：运行确认通过 + 全量**

```bash
node tests/perf-adapter.test.mjs 2>&1 | tail -2   # 全过
npm test 2>&1 | tail -2                            # 18 套件全绿（14+4 新增）
npm run typecheck 2>&1 | tail -1                   # 零错误
grep -c "@earendil-works" packages/core/perf/*.ts  # 0（core 纯净验证）
```

- [ ] **步骤 6：Commit**

```bash
git add perf/ tests/perf-adapter.test.mjs index.ts package.json
git commit -m "feat(perf): adapter — bench_run/profile_parse/metric_compare tools, .perf persistence, permission-gated"
```

---

### 任务 5：真实远端冒烟 + 文档收尾（控制者协同）

**文件：**
- 修改：`README.md`、`README.zh-CN.md`（Tools 表加 3 工具行 + perf-lab 小节）、`CHANGELOG.md`（0.12.0）
- 修改：`package.json` version → 0.12.0

- [ ] **步骤 1：控制者真实冒烟（可选但强烈建议）**

```bash
# worktree 外临时加载：确认工具面板出现 bench_run/profile_parse/metric_compare
cd /tmp && pi -e <repo> -p --no-session <<<'list your tools briefly' 2>&1 | tail -5
```

真实 GPU 冒烟（需 kunshan-quant 可达）：在 pi 会话中让模型调 bench_run 跑一个 `python -c "import torch; ..."` 微基准——若远端不可达/无权限，记录原因并跳过（mock 测试已覆盖逻辑正确性），roadmap 验收场景标注"待环境可用时补验"。

- [ ] **步骤 2：文档三处更新**

- README 双语 Tools 表加：`bench_run` / `profile_parse` / `metric_compare` 三行（一句话描述，注明 .perf/ 落盘与 multiloop verify 消费方式）
- Features 节加 "Perf lab" 小节（5-6 行：定位测量层、松耦合、环境快照、MAD 统计）
- CHANGELOG 顶部：

```markdown
## 0.12.0 (2026-08-14)

Phase 3 per plans/2026-08-14-perf-lab-design.md:

- Added: perf-lab — bench_run (remote GPU benchmark, N-run stats, env snapshot), profile_parse (torch profiler trace → hotspot table), metric_compare (Mann-Whitney significance, improve/regress/noise verdict)
- Results persist to .perf/<run-id>.json for pi-multiloop verify-command consumption
```

- package.json version → 0.12.0

- [ ] **步骤 3：全量验证 + 提交**

```bash
npm test 2>&1 | tail -2 && npm run typecheck 2>&1 | tail -1
git add -A
git commit -m "docs: perf-lab docs + 0.12.0 — tools table, feature section, changelog"
```

---

## 自检记录

- **规格覆盖度：** 设计 §2 模块结构 → 任务 1-4 文件一一对应；§3 三工具 → 任务 4 注册 + 各自 mock 用例；§4 四决策 → 任务 4（权限门控注释/落盘/快照/MAD 默认）；§5 TDD → 任务 1-4 全 RED→GREEN；§6 非目标 → 边界声明。验收场景真实远端部分 → 任务 5 步骤 1（可选项 + 降级路径）。
- **占位符扫描：** 测试用例给出具体断言值与夹具结构；remote 脚本模板以断言为准（明确标注）；无"待定"。
- **类型一致性：** BenchStats/ProfileReport/CompareResult 字段在任务 1 定义、任务 2-4 消费（parsers 返回 ProfileReport、compareStats 签名与 CompareResult 对齐）；测试注入口 `__setExecForTest` 与三个 ForTest 函数命名跨步骤一致。
