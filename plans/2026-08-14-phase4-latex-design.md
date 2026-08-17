# Phase 4 设计文档：latex-toolchain 自建 + 学术包轻试用

> 日期：2026-08-14 · 状态：**设计已批准**（2026-08-14 用户确认推荐组合 a+a+b+a）
> 阶段：roadmap Phase 4 · 设计依据：plans/personal-harness-roadmap.md §6.1/§7.2 Phase 4
> 裁定记录：Q1=a Tectonic 编译后端 / Q2=a 先自建后试用 / Q3=b+c 合成稿先行真实稿随后 / Q4=a 轻试用

---

## 1. 定位与边界

**latex-toolchain = 论文场景的机械层**：编译、错误结构化定位、引用一致性检查。学术流程层（review/revise/lit-search）由三个第三方学术包承担（轻试用后定去留）。

**做**：latex_compile（tectonic 封装 + 错误解析）、bibtex_check（引用一致性：未定义/未用/重复 key）、/compile 快捷命令
**不做**：写作辅助（pi-critique 领域）、元数据校验（pi-bib 领域）、文献检索（Zotero MCP + academic 包领域）、Word 输出（YAGNI，待高频需求出现）

## 2. LaTeX 编译后端：Tectonic

- `brew install tectonic`（单二进制 ~50MB，自动按需拉宏包）
- 首次编译联网拉包的冷启动特性记录在工具描述中（模型可预期）
- 兼容性边界：tectonic 失败且报宏包缺失时，错误信息透传给模型自行判断（不自动回退 MacTeX）

## 3. 模块结构（延续 core/adapter 分层）

```
packages/core/latex/           纯逻辑，零 pi 依赖
├── types.ts                   CompileResult/LatexError/BibIssue 类型
├── parse-log.ts               tectonic/biber 输出 → 结构化错误（file:line:code:message 分级 error/warning）
└── bib-check.ts               .aux/.bbl 交叉比对 .bib：未定义引用/未用条目/重复 key

latex/                         adapter 层
└── index.ts                   registerLatexTools(pi)：latex_compile + bibtex_check + /compile 命令
```

## 4. 两个工具 + 一个命令

| 工具/命令 | 输入 | 输出 | 要点 |
|---|---|---|---|
| `latex_compile` | texFile（绝对路径）、workdir、args（可选传递给 tectonic） | CompileResult：成败 + 结构化错误列表 + 产物 PDF 路径 | 本地 spawn tectonic；错误按 file:line 定位并给修复提示语（错误码映射常见 causes：undefined ref→跑两遍/查 key、missing $→数学环境等，映射表小而准） |
| `bibtex_check` | bibFile、auxFile（可选，缺省同目录推断） | BibIssue 列表 + markdown 报告 | 纯文本解析：重复 key/未定义 citation/未用 entry；不做元数据校验（pi-bib 领域） |
| `/compile [file]` | 当前目录或指定 .tex | 同 latex_compile | 快捷方式；无参数时找目录内唯一 main .tex |

## 5. 验收（合成稿先行）

合成验收夹具（`tests/fixtures/latex/`）：
- `good/`：正确双栏 article（2 节 + 公式 + 图表占位 + 8 条参考文献）——编译成功 + bib 零 issue
- `bad-refs/`：引用 `\ref{missing}` + `\cite{ghost}` + .bib 重复 key——编译报 warning + bibtex_check 抓出三类 issue
- `bad-syntax/`：缺 `$`/未闭合环境——latex_compile 返回结构化错误（file:line 非空）

**验收判据**：三夹具在 mock 与真实 tectonic（CI 外的本地验收）下行为一致；真实稿件路径留接口（texFile 任意路径即可）。

## 6. 学术包轻试用（自建完成后）

| 包 | 冒烟动作 | 保留判据 |
|---|---|---|
| pi-bib | 对合成稿 .bib 跑 `/review:bib` | CrossRef 校验准确、报告可用 |
| pi-critique | 对 bad-refs 摘要段跑 `/critique --writing` | academic lens 输出结构化、非泛泛而谈 |
| academic-research-skills | `/ars-reviewer` 对 bad-refs 全文 | 多视角评审覆盖 methodology/citation/logic |

试用结论（保留/卸载）记入 roadmap 决策表；CC-BY-NC 许可（academic 包）个人使用合规确认。

## 7. 规模预估

core ~450 行 + adapter ~200 行 + 夹具 ~150 行 + 测试 ~250 行。
