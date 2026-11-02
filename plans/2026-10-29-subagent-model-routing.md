# 子代理模型路由（role → model）

日期：2026-10-29
状态：已落地并实测验证

## 1. 问题

用户反馈：主用模型（`deepseek-v4.1-flash/jd/DeepSeek-V4.1-Flash-1017`）在**代码写作与执行**上效果一般。

根因（证据）：改动前 `~/.pi/agent/settings.json` **没有任何 `subagents` 配置**，因此 pi-subagents 的 6 个内置角色（worker / reviewer / oracle / evidence-auditor / scout / delegate）全部走 fallback 链
`per-run → agentOverridesByProvider（未配置）→ agentOverrides → frontmatter model → subagents.defaultModel → 父会话模型`
（依据：`pi-subagents/docs/models.md` 的 Precedence 一节），即**所有子代理都继承父会话的 Flash**。

## 2. 实测选型（不是凭感觉）

同一份规格任务（线程安全 LRU + TTL 缓存，9 条可判分规则）、同 thinking level `high`、独立目录，各自实现 + 自测；随后用**我自己写的隐藏验收测试**（`/tmp/rt2/test_zz_grade.py`，按规格逐条转写，实现方不可见）打分。

| 模型 | 隐藏验收 | 耗时 | 总 token | assistant 轮次 | 实现行数 | 特征 |
|---|---|---|---|---|---|---|
| `jdcloud/kimi-k3` | 11/11 | **64s** | 50k | 8 | 85 | 最快、最省，字面遵循规格 |
| `deepseek-v4.1-flash/…Flash-1017` | 11/11 | 73s | 41k | 6 | 86 | 最省 token |
| `jdcloud/jd/GLM-5.3` | 11/11 | **462s** | 277k | 12 | 137 + 31 个自测 | 最严谨（自补边界测试、RLock、逐条对照规格）；慢 7×、token 5.5× |
| `mollycloud/gpt-5.6-sol` | — | — | — | — | — | 用户指示：暂缓考虑 |

前置的轻量任务（slugify）上四者全部正确、无法区分——**说明工具调用链路对各模型都通，区分度来自复杂任务的严谨度与成本**。

> 复制证据：`/tmp/rt2/{glm53,kimik3,dsflash}/`、隐藏测试 `/tmp/rt2/test_zz_grade.py`、规格 `/tmp/rt2/SPEC.txt`。
> 耗时/token 取自子代理 transcript（`~/.pi/agent/sessions/<proj>/subagent-artifacts/*_transcript.jsonl` 的 `message.model` 与 usage 字段）。

## 3. 用户决策

| 角色类 | 决策 |
|---|---|
| 实现类（worker） | 固定 `jdcloud/jd/GLM-5.3` |
| 审查类（reviewer / oracle） | `jdcloud/jd/GLM-5.3` |
| 轻量类（scout / delegate） | 保持 DeepSeek-Flash，thinking `low` |
| 父会话 | 不换模型，只优化子代理 |

> **2026-11-02 用户修订**：`reviewer` 与 `evidence-auditor` 改为 `deepseek-v4.1-flash/jd/DeepSeek-V4.1-Flash-1017`（thinking 保持 `high`）；`worker` / `oracle` 仍为 `jdcloud/jd/GLM-5.3`。见第 8 节。

## 4. 落地配置

`~/.pi/agent/settings.json`（备份：`settings.json.bak-model-routing-20261029-114935`）——**以下为 2026-11-02 修订后的当前值**：

```json
"subagents": {
  "agentOverrides": {
    "worker":           { "model": "jdcloud/GLM-5.3", "thinking": "high" },
    "reviewer":         { "model": "deepseek-v4.1-flash/jd/DeepSeek-V4.1-Flash-1017", "thinking": "high" },
    "oracle":           { "model": "jdcloud/GLM-5.3", "thinking": "high" },
    "evidence-auditor": { "model": "deepseek-v4.1-flash/jd/DeepSeek-V4.1-Flash-1017", "thinking": "high" },
    "scout":            { "model": "deepseek-v4.1-flash/jd/DeepSeek-V4.1-Flash-1017", "thinking": "low" },
    "delegate":         { "model": "deepseek-v4.1-flash/jd/DeepSeek-V4.1-Flash-1017", "thinking": "low" }
  }
}
```

未列出的角色（`researcher`、`claude-code*`、`codex-exec*`、`cursor-agent*`）保持继承父会话 / 外部 CLI 自身模型，未做未经请求的改动。

## 5. 验证（已执行）

配置写入后未手动执行 `/reload`，进程内已生效；逐角色启动子代理并读取 transcript 的 `message.model`：

```
worker   -> jd/GLM-5.3
reviewer -> jd/GLM-5.3
scout    -> jd/DeepSeek-V4.1-Flash-1017
delegate -> jd/DeepSeek-V4.1-Flash-1017
```

另验证 per-run 覆盖优先于配置：`worker` + `model="jdcloud/kimi-k3:high"` 的 transcript 显示 `kimi-k3`。

注意：官方文档（`docs/agents.md:372`）声明外部设置编辑需 `/reload`，普通回合不轮询文件系统。本次实测未 reload 即生效，但正确做法是改完配置后 `/reload` 或开新会话。

## 6. 按任务动态改路由（配合使用）

优先级：**per-run 覆盖 > 本配置**。所以下表之外的例外一律在启动时指定，不改全局：

| 场景 | 做法 |
|---|---|
| 想让 routine 实现跑快些 | `subagent({agent:"worker", model:"jdcloud/kimi-k3:high", ...})` |
| 硬任务/关键路径实现 | 默认即是 GLM-5.3，无需额外指定 |
| 大仓侦察怕成本 | 默认 scout 已是 Flash:low |
| 深度审查/方案第二意见 | 默认 reviewer/oracle 已是 GLM-5.3 |
| 一次性验证小改动 | `model:"deepseek-v4.1-flash/jd/DeepSeek-V4.1-Flash-1017:low"` |

## 7. 已知风险

1. **GLM-5.3 慢且 verbose**：单个基准任务上实测 7.2× 耗时、5.5× token（n=1，勿当普遍规律）。worker 全程 GLM 会明显拖长并行 fanout 的墙钟时间（本次跑一个 reviewer 审阅耗时 538s）。缓解：例行/机械改动用第 6 节的 per-run 降级到 kimi-k3。
2. **`jdcloud/jd/GLM-5.3` 与 `jdcloud/GLM-5.3` 是两个不同注册项**（前者 `input: [text, image]`，后者**纯 text**）。2026-11-02 起用户指定使用 `jdcloud/GLM-5.3`，**代价：worker / oracle 不再能读图片输入**；若需图片能力，临时用 `model: "jdcloud/jd/GLM-5.3:high"` 单次覆盖。
3. **模型 id 变更或下线**：`agentOverrides` 里是硬编码字符串，provider 改名或模型下线会**启动时直接报错** `Unknown subagent model '<id>' in the active Pi model registry`（`src/runs/shared/model-resolution.js:259-266,365-382`，`agentOverrides` 来源的 origin 为 `configured`，必须能解析），**不会静默回落父模型**。看到该报错即核对本文件中的 id。
4. 未设 `subagents.modelScope` 白名单；如担心子代理被指到未授权模型，可后续加。

## 8. 变更日志

### 2026-11-02（第二项）：GLM 注册项改为 `jdcloud/GLM-5.3`

- 变更：`worker`、`oracle` 的 `model` 由 `jdcloud/jd/GLM-5.3` 改为 `jdcloud/GLM-5.3`（注册表中 id 为 `GLM-5.3`，纯 text）。回滚参照：`~/.pi/agent/settings.json.bak-reviewer-flash-20261102-155203` 中该两项仍为 `jdcloud/jd/GLM-5.3`。
- 验证：分别起最小 worker / oracle 子代理，transcript 同时记录 `provider: jdcloud` + `model: GLM-5.3`，两者均解析成功。
- 影响：失去图片输入能力（见第 7 节风险 2）。

### 2026-11-02（第一项）：reviewer / evidence-auditor 降为 Flash

- 变更：`reviewer`、`evidence-auditor` 的 `model` 由 `jdcloud/jd/GLM-5.3` 改为 `deepseek-v4.1-flash/jd/DeepSeek-V4.1-Flash-1017`，`thinking` 保持 `high`。备份 `~/.pi/agent/settings.json.bak-reviewer-flash-20261102-155203`。
- 验证：起最小 reviewer / evidence-auditor 子代理后读 transcript 的 `message.model`，均为 `jd/DeepSeek-V4.1-Flash-1017`（无需 `/reload`，当前会话内即时生效）。
- 附带发现：`evidence-auditor` 的 `tools` 白名单里是扩展工具（`web_search` / `fetch_content` / `source_check` 等），**前台子代理不加载 ambient 扩展**，会以 `these child tools were unavailable` 失败；必须用 `async: true` 后台子代理才能拿到这些工具。
- 未解决风险：Flash 的审查深度弱于 GLM-5.3（本文件第 2 节实测证据，n=1）；如遇「reviewer 漏检」可在单次调用用 `model: "jdcloud/jd/GLM-5.3:high"` 临时回退。

## 9. 待确认

- `researcher` 是否也要从 Flash 换到 kimi-k3（1M 上下文对长文综合有利）——本次未动。
- `gpt-5.6-sol` 恢复评估后是否需要替换审查类模型。
