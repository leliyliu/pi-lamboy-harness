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
