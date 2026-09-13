# jdcloud/GLM-5.3 400/1210「API 调用参数有误」错误分析

> 日期：2026-09-13 · 分析工具：pi 0.85.1（当前会话即 GLM-5.3 + xhigh）

## TL;DR

GLM-5.3 在某轮生成了**畸形 toolCall**（`write` 的 `arguments` 顶层是 JSON **数组**而非对象）。pi 本地校验正确拒绝了执行，但把该畸形调用原样保留在会话历史中；此后每轮请求回传历史时，京东云端点对数组形式的 `tool_calls[].function.arguments` 返回 `400 / code 1210 / "API 调用参数有误，请检查文档。"`，导致**该会话永久卡死**（"继续执行"也失败）。

修复 = 把会话文件中该条 `arguments` 从数组改为其第一个元素（模型真正想传的对象），会话即恢复可用。已完成修复并通过 A/B 验证。

## 1. 错误现场

```
[System Error] 400: {"cause":"{\"error\":{\"code\":\"1210\",\"message\":\"API 调用参数有误，请检查文档。\"}}","code":400,"message":"模型服务调用失败","status":"FAILED_RESPONSE"} (stopReason=error, model=jdcloud/GLM-5.3)
```

- 出错会话：`~/.pi/agent/sessions/--Users-…-pi-lamboy-harness--/2026-09-13T08-17-45-679Z_01a099d8-….jsonl`
- 会话状态：`model_change → jdcloud/GLM-5.3`，`thinking_level_change → xhigh`（L1/L2）
- 模型配置（`~/.pi/agent/models.json` → jdcloud provider）：`thinkingFormat: "deepseek"`、`supportsReasoningEffort: true`、`thinkingLevelMap: {off:null, minimal:low, low:high, medium:high, high:max, xhigh:max, max:max}` —— **配置本身无问题**（映射后只会发送 low/high/max，均合法）。

## 2. 排除过程（全部有 curl 实测证据）

| 假设 | 实验 | 结果 | 结论 |
|------|------|------|------|
| key/模型 ID/连通性 | 最简请求 | 200 | 排除 |
| `max_tokens=131072` 超限 | 直测 | 200 | 排除 |
| `stream` / `stream_options` / `tools` / `temperature` | 直测 | 200 | 排除 |
| `thinking:{type:"enabled"}`（deepseek 格式） | 直测 | 200 | 排除 |
| `reasoning_effort` 非法值 | medium/minimal/xhigh/none/垃圾值 | **400/1210**，但错误消息为特定文案（"该模型始终思考…请使用 low、high 或 max。" / "参数值非法，可选值为 none、minimal、low、medium、high、xhigh、max"） | **排除**——与用户遇到的通用文案"API 调用参数有误，请检查文档。"不同，属另一子错误 |
| 当前 thinkingLevelMap 映射越界 | 逐档位跑 pi（off/minimal/low/medium/high/xhigh/max） | 全部正常 | 排除 |

> 京东云 1210 是**通用参数校验失败码**，至少有三种子文案；只有"数组 toolCall arguments"这一种命中用户报错。

## 3. 根因定位

### 3.1 会话日志证据链

| 行 | 时间(UTC) | 事件 |
|----|-----------|------|
| L76–L78 | 08:23:35–43 | 正常多轮工具调用；L78 模型输出 `write` toolCall，**arguments 是数组** `[{content, path, then_run}, ["碎片…","…"]]` |
| L79 | 08:23:43 | pi 本地校验拒绝：`Validation failed for tool "write": root: must be object`（**pi 行为正确**） |
| L80 | 08:23:43 | 下一次 API 请求（回传含畸形 toolCall 的历史）→ **400/1210 通用文案**，assistant 空消息，`stopReason: "error"`，`errorMessage` 与用户报错逐字一致 |
| L81–L82 | 08:24:09 | 用户"继续执行" → 再次 400 → 会话卡死 |

### 3.2 pi 侧机制（源码证据）

`dist/bundle/chunks/openai-completions-EKZT2IH2.js` 回传历史时对 toolCall 只做 `JSON.stringify(tc.arguments)`，**不校验/不修复顶层数组** → 畸形结构每轮原样上送。

### 3.3 服务端触发条件（curl 判别实验）

固定其余请求，仅改 `tool_calls[0].function.arguments`：

| 变体 | arguments | 字节 | HTTP |
|------|-----------|------|------|
| D1 | JSON **数组**（复刻 L78 畸形） | 133 | **400/1210 通用文案** |
| D2 | 合法**对象**（内容对齐、更长） | 193 | **200** |
| D3 | 合法对象（= 数组第一元素） | 短 | **200** |

**结论：触发条件 = `arguments` 顶层为数组**，与长度无关（D2 更长也通过）。

补充现象（服务端内部行为，外部无法进一步归因）：是否命中校验与**总 prompt token 数**相关——同一畸形请求，user 文本增删 1–3 字符会在 200/400 间翻转（同一请求重复 3 次结果恒定，非缓存时序）。推测服务端校验路径按 token 分片/缓存条件选择性执行。

## 4. 根因链（三方责任）

```
GLM-5.3 模型输出了数组形式的 toolCall arguments          ← 模型侧 bug（起点）
        ↓
pi 本地正确拒绝执行，但将畸形结构原样留在会话历史         ← pi 侧缺防御（放大器）
        ↓
后续每轮请求回传历史 → 京东云端点 400/1210（通用文案）    ← 服务端校验（拒绝+文案含糊）
        ↓
会话永久卡死：模型无法自救，"继续执行"只会重复失败
```

## 5. 修复与验证（已执行）

**修复**：将会话文件 L78 的 `arguments` 从 `[{...}, [...]]` 改为 `{...}`（取数组第一元素——即模型真正想传的对象）。备份：`<会话文件>.bak-1210`。

**A/B 验证**（`pi --session <副本> -p "继续执行" --model jdcloud/GLM-5.3`）：

| 组 | 副本 | 结果 |
|----|------|------|
| A | 未修复 | `400: {"…code":"1210","message":"API 调用参数有误，请检查文档。"...}` —— **与用户报错逐字一致** |
| B | 修复后 | 正常回复；任务继续执行直至完成（paseo.json 写入、PaseoConfigSchema 校验通过、worktree 36 项测试全过、调研文档写入 Desktop） |

原会话文件已修复并恢复可用（含验证过程的完整执行记录）。

## 6. 预防与自救建议

1. **已实装防护（2026-09-13）**：pi-lamboy-harness `extensions/82-sanitize.ts`（三层防御 + `/sanitize-session` 命令）—— `message_end` 定稿即修（会话文件保持干净、工具直接执行修正后参数）、`context` 每次调用前修（已中毒旧会话也能续用）、`before_provider_request` 线格式兑底；已安装到 `~/.pi/agent/settings.json`。E2E A/B 验证：同一中毒会话，无扩展复现 1210，带扩展正常续用。详见 CHANGELOG Unreleased 段。
2. **遇到同样错误的自救**：出错会话里运行 `/sanitize-session`（自动备份 `.bak-sanitize` 后原子写回）；或手动在 `.jsonl` 中定位 `arguments` 为数组的 `toolCall`，改为其第一个元素（对象）。
3. **pi 上游建议**：回传历史前对畸形 toolCall arguments 做防御（对象化取首元素、或剥离该条 toolCall），避免单次模型失误永久毒化会话。可作为 issue 反馈 `@earendil-works/pi-coding-agent`。
4. **京东云侧建议**：a) GLM-5.3 偶发输出数组形式 tool 参数（模型侧需修复）；b) 1210 通用文案应指明具体非法字段（当前"API 调用参数有误"对排查极不友好）。
5. **另一个 1210 子错误的备忘**（与本次无关但已实测）：该端点 GLM-5.3 的 `reasoning_effort` 仅接受 `low/high/max`；`medium/minimal/xhigh/none` 会 400。当前 `thinkingLevelMap` 映射后不会发送这些值，无需改动。
6. **排查备忘（headless 回显陷阱）**：pi 无模型输出的 headless 运行（如纯命令 `-p "/sanitize-session"`）会**回显会话尾部 error 消息的 errorMessage**——错误尾部的会话跑命令后看到的"400"行是回显而非新请求（已用 MARKER-ECHO 实验验证），勿误判为防护失效。

## 7. 关键文件

| 文件 | 说明 |
|------|------|
| `~/.pi/agent/models.json` | jdcloud/GLM-5.3 模型配置（本次无需修改） |
| `~/.pi/agent/sessions/…/2026-09-13T08-17-45-….jsonl` | 出错会话（已修复）+ `.bak-1210` 备份 |
| `/tmp/full_req.json`（D1）| 最小稳定 400 复现体 |
| `/tmp/bad_req.json`、`/tmp/good_req.json` | 早期对照实验请求体 |
