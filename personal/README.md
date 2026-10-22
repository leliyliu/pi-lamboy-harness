# pi-lamboy-personal — 个人局部扩展（可选装）

> 本目录是一个独立的 **pi package**，与主包 `pi-lamboy-harness` 分开选装。
> 收录原先散落在 `~/.pi/agent/extensions/` 与 `~/.pi/agent/skills/` 的个人局部能力，
> 让本仓库成为个人 pi 生态的唯一事实来源（single source of truth）。
> 收录日期：2026-09-06。

## 内容清单

| 项 | 类型 | 作用 | 原位置 |
|---|---|---|---|
| **image2.ts** | extension（354 行） | 注册 `generate_image` 工具：调用京东云 gpt-image2（OpenAI Images API 兼容），生成 1–4 张图片保存到本地并以 ImageContent 插入对话。任何模型画图时都可调用 | `~/.pi/agent/extensions/image2.ts`（2026-08-20） |
| **joyspace-md-import** | skill（187 行 SKILL.md + 引用 + 脚本） | 把本地 Markdown（含图片/表格/代码块）经 Playwright 驱动 Slate 编辑器写入京东 JoySpace 在线文档；含 SSO 登录、图片上传、SVG 转 PNG 预处理 | `~/.pi/agent/skills/joyspace-md-import/` |
| **notify/pinotify.swift** | 构建脚本 + Swift 源码（~200 行） | 屏幕右上角非激活浮窗：不经 UNUserNotificationCenter，绕开被企业策略封锁的通知授权；`.nonactivatingPanel` 不抢焦点、鼠标穿透、6s 自动淡出、多实例槽位错开。配合 `personal/extensions/notify.ts` 在 turn 结束与「需要用户介入」时提醒 | 新建（2026-10-22） |
| **extensions/notify.ts** | extension（v6） | 统一提醒宿主：`agent_settled`（完成/出错）+ 接收 repo `packages/core/attention` 的三种「等你介入」事件——提问（Ping）、权限授权（Submarine）、计划审批（Hero）。通道优先级 pinotify 浮窗 → osascript 对话框 → 仅声音，全程 fail-open；`PI_NOTIFY=0` 全禁用 | `~/.pi/agent/extensions/notify.ts`（2026-10-22 迁入） |

### 构建 pinotify

```bash
./personal/notify/build.sh          # → ~/.pi/agent/bin/pinotify（需 Xcode CLT 的 swiftc）
# 自测（应出现右上角浮窗）
~/.pi/agent/bin/pinotify --title pi --body "自测" --kind success --duration 6
```

> 注意：`personal/notify/` **不在** `pi.extensions` / `pi.skills` 扫描范围内，不会被 pi 当作扩展加载——它是 `personal/extensions/notify.ts` 的配套二进制源码。背景与四轮通道实验见 `plans/2026-10-12-通知链路诊断报告.md`，提醒矩阵与三类介入事件见 `plans/2026-10-22-need-input-notifications.md`。

## 选装方式

### 安装（pi 原生 local-path 安装，settings 记录路径、不复制文件）

```bash
pi install /Users/liulian.leliy/github-projects/pi-lamboy-harness/personal
# 重启 pi；验证：
#  - generate_image 出现在工具列表
#  - /skill: joyspace-md-import 可用
```

### 首次安装前：先移除全局目录中的旧副本（避免双重注册）

```bash
mv ~/.pi/agent/extensions/image2.ts ~/.pi/agent/extensions/image2.ts.bak
# notify.ts v6 已迁入本包；home 旧副本必须改名，否则双注册会弹两次
mv ~/.pi/agent/extensions/notify.ts ~/.pi/agent/extensions/notify.ts.bak-$(date +%Y%m%d)
mv ~/.pi/agent/skills/joyspace-md-import ~/.pi/agent/skills/joyspace-md-import.bak
pi install /Users/liulian.leliy/github-projects/pi-lamboy-harness/personal
# 确认工作正常后删除 .bak
```

### 卸载

```bash
pi remove /Users/liulian.leliy/github-projects/pi-lamboy-harness/personal
```

或直接从 `~/.pi/agent/settings.json` 的 `packages` 数组删除对应路径条目。

## 配置

### image2.ts

配置优先级：环境变量 > `~/.pi/agent/image2.json` > 默认值（源码头部注释实测）。

| 环境变量 | 说明 | 默认 |
|---|---|---|
| `JD_IMAGE_BASE_URL` | 必填，如 `https://modelservice.jdcloud.com/v1` | — |
| `JD_IMAGE_API_KEY` | 必填，Bearer token | — |
| `JD_IMAGE_MODEL` | 模型名 | gpt-image-1 |
| `JD_IMAGE_SIZE` | 尺寸 | 1024x1024 |
| `JD_IMAGE_OUTPUT_DIR` | 输出目录（相对 cwd） | ./generated-images |
| `JD_IMAGE_PROXY` | 代理（也认 HTTPS_PROXY/HTTP_PROXY） | — |

配置文件示例（`~/.pi/agent/image2.json`）：

```json
{ "baseUrl": "...", "apiKey": "...", "model": "gpt-image-2", "proxy": "http://127.0.0.1:17893" }
```

### notify.ts

| 环境变量 | 说明 | 默认 |
|---|---|---|
| `PI_NOTIFY` | `0` = 完全禁用提醒 | 启用 |
| `PI_NOTIFY_DEBUG` | 调试日志路径 | `/tmp/pi-notify.log` |
| `PINOTIFY_BIN` | 浮窗二进制路径 | `~/.pi/agent/bin/pinotify` |
| `PI_NOTIFY_SOUND_ASK` / `_APPROVAL` / `_PLAN` | 三类介入事件的音色 | `Ping` / `Submarine` / `Hero` |

> 提醒只在 `ctx.mode === "tui"` 时触发；headless/RPC 与管道调用静默。

### joyspace-md-import

脚本依赖需在 skill 目录内安装一次（原目录 312MB 的来源即此 node_modules，未收录进仓库）：

```bash
cd personal/skills/joyspace-md-import/scripts && npm install
```

使用方式：直接对 pi 说"把 xxx.md 发布到 JoySpace"，或先读取 `SKILL.md` 按流程执行（Playwright + Slate editor 实例操作，详见 SKILL.md"解决思路"节）。

## 维护说明

- 本目录内容与主 harness **无代码依赖**，可独立演进。
- 若日后不再需要某项：从 `pi.extensions` / `pi.skills` 数组中移除对应条目，或直接删除文件。
- 修改 image2.ts / SKILL.md 后无需重装（local-path 安装直接引用仓库文件，重启 pi 生效）。
