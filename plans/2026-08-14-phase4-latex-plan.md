# Phase 4 实现计划：latex-toolchain

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 新增 latex-toolchain 模块——latex_compile（tectonic 封装 + 结构化错误）、bibtex_check（引用一致性）、/compile 命令；合成验收夹具三套；学术包轻试用（控制者执行）。

**架构：** core/adapter 分层（设计 plans/2026-08-14-phase4-latex-design.md 已批准）。`packages/core/latex/` 纯逻辑（log 解析 + bib 交叉比对）；`latex/index.ts` adapter（spawn tectonic + 工具注册）。

**技术栈：** TypeScript strict · tectonic（brew 安装）· node 测试（jiti 模式沿用）

**边界声明：** 学术包试用（设计 §6）由控制者亲自执行不入本计划任务流；真实稿件验收为后续人工动作（合成稿覆盖全部判据）。

**全局约束（审查者透镜）：**
- core/latex 零 pi import
- TDD 全程（RED→GREEN 证据入报告）
- tectonic 不存在时 latex_compile 返回结构化错误（非崩溃）——"tectonic not found, brew install tectonic" 提示
- commit 粒度 = 任务粒度

---

## 文件结构总览

| 动作 | 路径 | 职责 |
|---|---|---|
| 创建 | `packages/core/latex/types.ts` | CompileResult/LatexError/BibIssue |
| 创建 | `packages/core/latex/parse-log.ts` | tectonic/biber 输出 → 结构化错误 |
| 创建 | `packages/core/latex/bib-check.ts` | .aux×.bib 交叉比对 |
| 创建 | `latex/index.ts` | adapter：latex_compile/bibtex_check 工具 + /compile 命令 |
| 创建 | `tests/fixtures/latex/good/` | main.tex + refs.bib（正确稿） |
| 创建 | `tests/fixtures/latex/bad-refs/` | 引用缺失/重复 key 稿 |
| 创建 | `tests/fixtures/latex/bad-syntax/` | 语法错误稿 |
| 创建 | `tests/latex-parse.test.mjs` | log 解析 TDD |
| 创建 | `tests/latex-bib.test.mjs` | bib 检查 TDD（对夹具） |
| 创建 | `tests/latex-adapter.test.mjs` | adapter mock-spawn 全链路 |
| 修改 | `index.ts`、`package.json`、`tsconfig.json`、README×2、CHANGELOG、`.gitignore` | 接线/打包/文档 |

---

### 任务 1：core/latex/types.ts + parse-log.ts（日志解析，TDD）

**文件：**
- 创建：`packages/core/latex/types.ts`、`packages/core/latex/parse-log.ts`
- 测试：`tests/latex-parse.test.mjs`

- [ ] **步骤 1：编写失败的测试**

jiti 样板沿用（perf-stats 同款）。测试用例（夹具为内联字符串常量，取自 tectonic 真实输出格式的最小样例——实现者先 `brew install tectonic` 后用真实错误输出校准夹具，若 brew 不可用则按下列格式构造）：

```javascript
const parse = loadTs("packages/core/latex/parse-log.ts");

const TECTONIC_ERR = `error: missing $ inserted
  ==> /tmp/bad/main.tex:12:1
l.12 ...f(x) = x^2
`;

check("err: file+line extracted", (() => { const r = parse.parseTectonicLog(TECTONIC_ERR); return r.errors[0].file === "main.tex" && r.errors[0].line === 12; })());
check("err: message captured", parse.parseTectonicLog(TECTONIC_ERR).errors[0].message.includes("missing $"));
check("err: severity error", parse.parseTectonicLog(TECTONIC_ERR).errors[0].severity === "error");

const TECTONIC_WARN = `warning: undefined reference "sec:ghost"
  ==> /tmp/x/main.tex:20:5
`;
check("warn: severity warning", parse.parseTectonicLog(TECTONIC_WARN).errors[0].severity === "warning");

check("hint: undefined-ref gets rerun hint", parse.parseTectonicLog(TECTONIC_WARN).errors[0].hint?.includes("rerun") === true);
check("clean: no errors", parse.parseTectonicLog("running tectonic\nok").errors.length === 0);
check("multi: two errors both captured", parse.parseTectonicLog(TECTONIC_ERR + TECTONIC_WARN).errors.length === 2);
```

（若真实 tectonic 输出格式与上述模板有出入——以实测为准调整夹具与正则，断言意图不变：file/line/message/severity/hint 五要素）

- [ ] **步骤 2：运行确认失败**（ENOENT）

- [ ] **步骤 3：实现**

`types.ts`：

```typescript
// latex-toolchain core types — pure, no host imports.
export interface LatexError {
  file: string; line: number; col?: number;
  severity: "error" | "warning";
  message: string; hint?: string;
}
export interface CompileResult {
  ok: boolean; pdfPath?: string; errors: LatexError[]; rawTail: string;
}
export interface BibIssue {
  kind: "undefined-citation" | "unused-entry" | "duplicate-key";
  detail: string;
}
```

`parse-log.ts`：`parseTectonicLog(stdout)` —— 正则匹配 `(error|warning): <msg>` 块与随后的 `==> <path>:<line>:<col>` 行；路径取 basename；HINTS 映射表：`/undefined (reference|citation)/i → "Rerun compile (refs need 2 passes) or check the key"`、`/missing \$/i → "Check math-mode delimiters around the reported line"`、`/undefined control sequence/i → "Check the macro name / add the package"`；`rawTail` = 最后 30 行原文（兜底给模型看）。

- [ ] **步骤 4：运行确认通过**
- [ ] **步骤 5：Commit**

```bash
git add packages/core/latex/ tests/latex-parse.test.mjs
git commit -m "feat(latex): core log parser — tectonic errors to structured file:line:severity (TDD)"
```

---

### 任务 2：core/latex/bib-check.ts + 三套合成夹具（TDD）

**文件：**
- 创建：`packages/core/latex/bib-check.ts`
- 创建夹具：`tests/fixtures/latex/good/{main.tex,refs.bib}`、`bad-refs/{main.tex,refs.bib}`、`bad-syntax/main.tex`
- 测试：`tests/latex-bib.test.mjs`

- [ ] **步骤 1：创建三套夹具**

- `good/main.tex`：article 双栏（documentclass[twocolumn]{article}），2 节 + 1 个 equation + 1 个 table 占位 + `\cite{smith2020,jones2021}` 等 8 条引用全部存在于 refs.bib；refs.bib 8 条无重复 key
- `bad-refs/main.tex`：含 `\ref{sec:ghost}`（.tex 内无该 label）、`\cite{ghost2022}`（bib 无此 key）、`\cite{smith2020}`×2（正常）；refs.bib 含 `smith2020` 两条（重复 key）+ `jones2021`（正文未引用→unused）
- `bad-syntax/main.tex`：第 12 行 `\(f(x) = x^2`（缺右定界符）+ 第 20 行未闭合 `\begin{itemize}`

（夹具是测试的共享资产，本任务一并建好供任务 3 复用；bad-syntax 的 main.tex 无需 bib）

- [ ] **步骤 2：编写失败的测试**

```javascript
const bc = loadTs("packages/core/latex/bib-check.ts");
const fx = p => fs.readFileSync(path.join(ROOT, "tests/fixtures/latex", p), "utf8");

// good：零 issue
const g = bc.checkBib(fx("good/main.tex"), fx("good/refs.bib"));
check("good: no issues", g.issues.length === 0);

// bad-refs：三类 issue 各就位
const b = bc.checkBib(fx("bad-refs/main.tex"), fx("bad-refs/refs.bib"));
check("bad: duplicate key smith2020", b.issues.some(i => i.kind === "duplicate-key" && i.detail.includes("smith2020")));
check("bad: undefined citation ghost2022", b.issues.some(i => i.kind === "undefined-citation" && i.detail.includes("ghost2022")));
check("bad: unused entry jones2021", b.issues.some(i => i.kind === "unused-entry" && i.detail.includes("jones2021")));
```

- [ ] **步骤 3：运行确认失败**

- [ ] **步骤 4：实现 bib-check.ts**

签名 `checkBib(texSource: string, bibSource: string): { issues: BibIssue[] }`：
- bib 解析：行首 `@type{key,` 提取 entries（key 列表 + 重复检测）
- tex 提取：`\cite{...}`（逗号分隔展开）与 `\ref{...}`/`\label{...}`
- 交叉：cite−bib = undefined-citation；bib−cite = unused-entry；bib 内重复 = duplicate-key
- 纯文本正则，无 LaTeX 依赖

- [ ] **步骤 5：运行确认通过**
- [ ] **步骤 6：Commit**

```bash
git add packages/core/latex/bib-check.ts tests/latex-bib.test.mjs tests/fixtures/
git commit -m "feat(latex): bib consistency check + three synthetic fixtures (TDD)"
```

---

### 任务 3：adapter latex/index.ts（工具 + 命令 + mock 测试）

**文件：**
- 创建：`latex/index.ts`
- 测试：`tests/latex-adapter.test.mjs`
- 修改：`index.ts`（接线）、`package.json`（files）、`tsconfig.json`（include）、`.gitignore`（`*.pdf` 于 fixtures 下例外规则——不忽略，或统一忽略构建产物 `*.aux` `*.log` `*.pdf` 但 `!tests/fixtures/**`）

- [ ] **步骤 1：编写失败的测试（mock spawn）**

沿用 perf 的注入口模式：`__setExecForTest` + `compileForTest/bibCheckForTest`。

```javascript
// mock tectonic：good 夹具 → 模拟成功输出（含 "writing 2 pages" 与 pdf 路径行）；bad-syntax → 模拟任务 1 夹具的错误输出
const ok = await adapter.compileForTest(FX("good/main.tex"));
check("compile good: ok true", ok.ok === true && ok.errors.length === 0);
check("compile good: pdfPath set", typeof ok.pdfPath === "string");

const bad = await adapter.compileForTest(FX("bad-syntax/main.tex"));
check("compile bad: structured errors", bad.ok === false && bad.errors[0].line === 12);

// tectonic 缺失路径
adapter.__setExecForTest(async () => ({ code: 127, stdout: "", stderr: "command not found" }));
const nf = await adapter.compileForTest(FX("good/main.tex"));
check("missing tectonic: friendly error", nf.ok === false && nf.errors[0].message.includes("brew install tectonic"));

// bibtex_check 工具面：读夹具文件 → issues markdown
const bib = await adapter.bibCheckForTest(FX("bad-refs/main.tex"), FX("bad-refs/refs.bib"));
check("bib via adapter: markdown has 3 issue kinds", ["undefined-citation","unused-entry","duplicate-key"].every(k => bib.markdown.includes(k)));
```

- [ ] **步骤 2：运行确认失败**

- [ ] **步骤 3：实现 latex/index.ts**

- `registerLatexTools(pi)`：
  - `latex_compile` 工具：参数 texFile（绝对路径）、args?（string[] 透传）；实现：spawn `tectonic <texFile>`（cwd=文件目录，detected via path.dirname）；exit 127/ENOENT → 结构化 "tectonic not found, brew install tectonic" 错误；正常 → parseTectonicLog(stdout+stderr)，pdf 路径从输出行或 `<base>.pdf` 推断；返回 markdown（成败 + 错误表 + hint）
  - `bibtex_check` 工具：参数 texFile、bibFile?（缺省同目录同名 .bib 推断，找不到时明确报错）；读两文件 → checkBib → markdown
  - `/compile [file]` 命令：无参时扫 cwd 唯一 `*.tex`（多个则报歧义）；调 latex_compile 同路径
- `__setExecForTest` 注入 exec（生产用 spawn 包装为 Promise<{code,stdout,stderr}>）
- 接线：index.ts import + `registerLatexTools(pi)`（registerPerfTools 之后）；package.json files 加 `"latex/"`；tsconfig include 加 `"latex/**/*.ts"`

- [ ] **步骤 4：运行确认通过 + 全量**

```bash
node tests/latex-adapter.test.mjs 2>&1 | tail -2   # 全过
npm test 2>&1 | tail -2                             # 21 套件全绿
npm run typecheck 2>&1 | tail -1
```

- [ ] **步骤 5：Commit**

```bash
git add latex/ tests/latex-adapter.test.mjs index.ts package.json tsconfig.json .gitignore
git commit -m "feat(latex): adapter — latex_compile/bibtex_check tools + /compile command, tectonic spawn (mock-tested)"
```

---

### 任务 4：真实 tectonic 冒烟（条件执行）+ 文档收尾

**文件：**
- 修改：README×2、CHANGELOG、roadmap

- [ ] **步骤 1：控制者真实冒烟（brew 可用且网络允许时）**

```bash
brew install tectonic   # 控制者执行（或已装跳过）
cd <worktree> && npx tectonic tests/fixtures/latex/good/main.tex --outdir /tmp/lt-smoke && ls -la /tmp/lt-smoke/main.pdf
```

真实错误路径冒烟（可选）：bad-syntax 编译确认结构化输出。若 brew/网络不可用：记录原因，mock 覆盖已保逻辑正确性，README 标注 "tectonic required (brew install tectonic)"。

- [ ] **步骤 2：文档四件套**

- README 双语：Tools 表 2 行（latex_compile/bibtex_check）+ Latex toolchain 小节（4-5 行：tectonic 后端/结构化错误/引用一致性/前置 brew install tectonic）+ Architecture 图 core 加 `latex/` 行 adapter 加 `latex/` 行 + Tests 清单 3 套件（计数以实跑为准）
- CHANGELOG 0.13.0（模板）：

```markdown
## 0.13.0 (2026-08-14)

Phase 4 per plans/2026-08-14-phase4-latex-design.md:

- Added: latex-toolchain — latex_compile (tectonic backend, structured file:line errors + fix hints), bibtex_check (undefined-citation/unused-entry/duplicate-key), /compile command
- Requires: tectonic (brew install tectonic); graceful "not found" error otherwise
```

- package.json version → 0.13.0；roadmap 决策表追加 Phase 4 行

- [ ] **步骤 3：全量验证 + 提交**

```bash
npm test 2>&1 | tail -2 && npm run typecheck 2>&1 | tail -1
git add -A && git commit -m "docs: latex-toolchain docs + 0.13.0"
```

---

### 任务 5：学术包轻试用（控制者亲自执行，不分派）

- [ ] 安装三包：`pi install npm:pi-bib npm:pi-critique npm:@portos-wang/academic-research-skills-pi-extension`
- [ ] pi-bib 冒烟：对 `tests/fixtures/latex/bad-refs/refs.bib` 跑 `/review:bib` → 记录 CrossRef 校验质量
- [ ] pi-critique 冒烟：对 bad-refs/main.tex 的摘要段跑 `/critique --writing` → 记录 academic lens 质量
- [ ] academic-research-skills 冒烟：`/ars-reviewer`（或其可用命令）对 bad-refs 全文 → 记录多视角评审质量
- [ ] 结论（每包 保留/卸载 + 一句理由）记入 roadmap 决策表；卸载不保留的包
- [ ] CC-BY-NC 合规确认（个人使用，不分发）

---

## 自检记录

- **规格覆盖度：** 设计 §3 模块 → 任务 1-3；§4 工具/命令 → 任务 3；§5 验收 → 任务 2 夹具 + 任务 3 mock 断言 + 任务 4 真实冒烟；§6 试用 → 任务 5；§2 tectonic → 任务 3 错误路径 + 任务 4 安装冒烟。
- **占位符扫描：** 夹具有明确内容规格（章节/引用/错误行号）；正则允许"以实测 tectonic 输出校准"但断言意图五要素锁定——非占位符。
- **类型一致性：** LatexError/BibIssue/CompileResult 贯穿三任务；注入口命名与 perf 模式一致（__setExecForTest/ForTest）。
