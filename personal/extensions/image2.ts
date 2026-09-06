// [pi-lamboy-personal] 收录自 ~/.pi/agent/extensions/image2.ts（2026-09-06 迁移）。
// 选装方式见 personal/README.md：pi install <repo>/personal（先移除全局目录旧副本）。
//
// image2.ts — pi 扩展：集成京东云 gpt-image2（OpenAI Images API 兼容）图像生成
//
// 作用：
//   1. 注册 generate_image 工具，任何模型在画图时都可调用；
//   2. 工具调用京东云 Images API，把生成的图片保存到本地文件，
//      并以 ImageContent 形式返回，使图片插入对话并在 TUI 显示。
//
// 配置优先级：环境变量 > ~/.pi/agent/image2.json > 默认值
//
// 环境变量（可选，覆盖配置文件）：
//   JD_IMAGE_BASE_URL   必填，如 https://modelservice.jdcloud.com/v1
//   JD_IMAGE_API_KEY    必填，Bearer token
//   JD_IMAGE_MODEL      可选，默认 gpt-image-1
//   JD_IMAGE_ENDPOINT   可选，默认 /images/generations
//   JD_IMAGE_SIZE       可选，默认 1024x1024
//   JD_IMAGE_OUTPUT_DIR 可选，默认 ./generated-images（相对当前工作目录）
//   JD_IMAGE_PROXY      可选，如 http://127.0.0.1:17893（也可用 HTTPS_PROXY/HTTP_PROXY）
//
// 配置文件示例（~/.pi/agent/image2.json）：
//   { "baseUrl": "...", "apiKey": "...", "model": "gpt-image-2", "proxy": "http://127.0.0.1:17893" }
//
// 设计文档见：pi-image2-integration-design.md

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, StringEnum } from "@earendil-works/pi-ai";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, isAbsolute, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

// 用 undici 的 fetch + ProxyAgent，以便显式支持代理（Node 原生 fetch 不支持 proxy 参数）
// undici 随 pi-coding-agent 一起安装。扩展运行时 __filename 指向扩展源文件，
// 从那里直接 require("undici") 会失败，需要从 pi 包根目录解析。
// 策略：从 process.execPath（node 二进制）反推全局 node_modules，再找 pi 包下的 undici。
const _require = createRequire(__filename);
let _undici: { fetch: typeof fetch; ProxyAgent: any } | null = null;
function getUndici(): { fetch: typeof fetch; ProxyAgent: any } | null {
  if (_undici) return _undici;
  const candidates: string[] = [];
  // 1) 从 node 二进制反推： <prefix>/bin/node -> <prefix>/lib/node_modules
  const nodeDir = dirname(process.execPath);
  candidates.push(join(nodeDir, "..", "lib", "node_modules"));
  candidates.push(join(nodeDir, "..", "node_modules"));
  // 2) 常规 require 查找路径
  try {
    const paths = _require.resolve.paths("") ?? [];
    candidates.push(...paths);
  } catch {}
  // 3) 逐一尝试在候选路径下解析 pi 包与 undici
  for (const base of candidates) {
    for (const piPkg of [
      join(base, "@earendil-works", "pi-coding-agent"),
      base,
    ]) {
      try {
        const undiciPath = _require.resolve("undici", { paths: [piPkg] });
        _undici = _require(undiciPath);
        return _undici;
      } catch {}
    }
  }
  console.error("[image2] 加载 undici 失败，将无法走代理。候选路径:", candidates.join(", "));
  return null;
}

interface ImagesApiResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { message?: string; type?: string; code?: string };
}

function getEnv(name: string, fallback = ""): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

// 配置文件回退：~/.pi/agent/image2.json
// 环境变量优先；缺失时从配置文件读取，避免依赖 shell 环境继承。
const CONFIG_FILE = join(homedir(), ".pi", "agent", "image2.json");

interface FileConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  size?: string;
  outputDir?: string;
  proxy?: string;
}

let _fileConfig: FileConfig | null | undefined;
async function getFileConfig(): Promise<FileConfig | null> {
  if (_fileConfig !== undefined) return _fileConfig;
  try {
    const raw = await readFile(CONFIG_FILE, "utf8");
    _fileConfig = JSON.parse(raw) as FileConfig;
  } catch {
    _fileConfig = null;
  }
  return _fileConfig;
}

// 读取顺序：环境变量 → 配置文件 → 默认值
async function readConfigValue(key: keyof FileConfig, envName: string, fallback = ""): Promise<string> {
  const envVal = getEnv(envName);
  if (envVal) return envVal;
  const fileVal = (await getFileConfig())?.[key];
  if (fileVal && fileVal.length > 0) return fileVal;
  return fallback;
}

async function requireConfigValue(key: keyof FileConfig, envName: string): Promise<string> {
  const v = await readConfigValue(key, envName);
  if (!v) {
    throw new Error(
      `[image2] 缺少配置 ${envName}。请设置环境变量，或在 ${CONFIG_FILE} 中配置 "${key}"。`
    );
  }
  return v;
}

async function buildConfig() {
  return {
    baseUrl: (await requireConfigValue("baseUrl", "JD_IMAGE_BASE_URL")).replace(/\/+$/, ""),
    apiKey: await requireConfigValue("apiKey", "JD_IMAGE_API_KEY"),
    model: await readConfigValue("model", "JD_IMAGE_MODEL", "gpt-image-1"),
    endpoint: await readConfigValue("endpoint", "JD_IMAGE_ENDPOINT", "/images/generations"),
    size: await readConfigValue("size", "JD_IMAGE_SIZE", "1024x1024"),
    outputDir: await readConfigValue("outputDir", "JD_IMAGE_OUTPUT_DIR", "./generated-images"),
    // 代理：环境变量 HTTPS_PROXY/HTTP_PROXY 优先，其次配置文件 proxy 字段
    proxy: getEnv("HTTPS_PROXY") || getEnv("https_proxy") ||
      getEnv("HTTP_PROXY") || getEnv("http_proxy") ||
      (await readConfigValue("proxy", "JD_IMAGE_PROXY")),
  };
}

function resolveOutputDir(outputDir: string, cwd: string): string {
  return isAbsolute(outputDir) ? outputDir : resolve(cwd, outputDir);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "generate_image",
    label: "Generate Image (gpt-image2)",
    description:
      "使用 gpt-image2（京东云）根据文本提示生成图片。当用户要求生成、绘制、画图片时调用此工具。" +
      "生成的图片会保存到本地文件并插入对话。",
    promptSnippet: "Generate an image from a text prompt via gpt-image2",
    promptGuidelines: [
      "当用户要求生成、绘制、画、做一张图片时，必须调用 generate_image 工具来产出图片，" +
        "不要只用文字描述你想画什么。调用时把用户对画面的描述放进 prompt 参数。",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: "对要生成图片的详细描述（中文或英文均可）。",
      }),
      size: StringEnum(
        ["1024x1024", "1024x1536", "1536x1024", "auto"] as const,
        { description: "图片尺寸，默认 1024x1024。" }
      ),
      n: Type.Optional(
        Type.Number({
          description: "生成数量，默认 1。",
          minimum: 1,
          maximum: 4,
        })
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      let cfg;
      try {
        cfg = await buildConfig();
      } catch (e) {
        return {
          content: [{ type: "text", text: `配置错误：${(e as Error).message}` }],
          isError: true,
          details: {},
        };
      }

      const prompt: string = params.prompt;
      const size: string = params.size ?? cfg.size;
      const n: number = Math.max(1, Math.min(4, params.n ?? 1));
      const outDir = resolveOutputDir(cfg.outputDir, ctx.cwd);

      await onUpdate?.({
        content: [{ type: "text", text: `正在调用 gpt-image2 生成图片…` }],
      });

      const url = `${cfg.baseUrl}${cfg.endpoint}`;
      // 选择 fetch 实现：有代理时用 undici 的 fetch + dispatcher，否则用全局 fetch。
      // 仅在需要代理时才加载 undici，避免无代理环境下输出无谓警告。
      const useProxy = !!cfg.proxy;
      const undici = useProxy ? getUndici() : null;
      const dispatcher = useProxy && undici ? new undici.ProxyAgent(cfg.proxy!) : undefined;
      const doFetch: typeof fetch = (useProxy && undici)
        ? (input, init) => undici.fetch(input, { ...init, dispatcher } as any)
        : fetch;
      if (useProxy && !undici) {
        console.error("[image2] 配置了 proxy 但 undici 加载失败，将回退到不走代理的全局 fetch");
      }

      let resp: Response;
      try {
        resp = await doFetch(url, {
          method: "POST",
          signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify({
            model: cfg.model,
            prompt,
            n,
            size,
          }),
        });
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `调用图像服务失败（网络/取消）：${(e as Error).message}`,
            },
          ],
          isError: true,
          details: { url, prompt, size, n },
        };
      }

      if (!resp.ok) {
        const raw = await resp.text().catch(() => "");
        return {
          content: [
            {
              type: "text",
              text: `图像服务返回错误 HTTP ${resp.status}：${raw.slice(0, 800)}`,
            },
          ],
          isError: true,
          details: { url, status: resp.status, prompt, size, n },
        };
      }

      const payload = (await resp.json().catch(() => ({}))) as ImagesApiResponse;
      if (payload.error) {
        return {
          content: [
            {
              type: "text",
              text: `图像服务报错：${payload.error.message ?? JSON.stringify(payload.error)}`,
            },
          ],
          isError: true,
          details: { url, prompt, size, n, error: payload.error },
        };
      }
      const items = payload.data ?? [];
      if (items.length === 0) {
        return {
          content: [{ type: "text", text: `图像服务返回空结果。` }],
          isError: true,
          details: { url, prompt, size, n, raw: payload },
        };
      }

      await mkdir(outDir, { recursive: true });
      const ts = Date.now();
      const saved: string[] = [];
      const content: Array<
        { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
      > = [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        let base64: string | undefined = item.b64_json;

        if (!base64 && item.url) {
          try {
            const imgResp = await doFetch(item.url, { signal });
            if (!imgResp.ok) {
              content.push({
                type: "text",
                text: `下载图片 URL 失败 HTTP ${imgResp.status}：${item.url}`,
              });
              continue;
            }
            const buf = Buffer.from(await imgResp.arrayBuffer());
            base64 = buf.toString("base64");
          } catch (e) {
            content.push({
              type: "text",
              text: `下载图片 URL 异常：${(e as Error).message}`,
            });
            continue;
          }
        }

        if (!base64) {
          content.push({
            type: "text",
            text: `第 ${i + 1} 张图片缺少 b64_json 与 url 字段。`,
          });
          continue;
        }

        const file = join(outDir, `img-${ts}-${i}.png`);
        try {
          await writeFile(file, Buffer.from(base64, "base64"));
          saved.push(file);
        } catch (e) {
          content.push({
            type: "text",
            text: `保存图片失败：${(e as Error).message}`,
          });
          continue;
        }

        content.push({ type: "image", data: base64, mimeType: "image/png" });
      }

      const summary =
        saved.length > 0
          ? `已生成 ${saved.length} 张图片并保存：\n${saved.join("\n")}`
          : `未能生成任何图片。`;

      // 文本说明放在最前，便于模型引用文件路径
      content.unshift({ type: "text", text: summary });

      return {
        content,
        details: {
          model: cfg.model,
          prompt,
          size,
          n,
          saved,
          outDir,
        },
      };
    },
  });

  // 兜底强化（默认不开，避免重复占 token）：
  // 如发现某些模型仍倾向用文字描述而非调用工具，取消下面注释即可在每次 agent 启动时
  // 追加一条强制系统提示。
  // pi.on("before_agent_start", async (event, _ctx) => {
  //   const extra =
  //     "\n\n【图像生成强制规则】当用户要求生成、绘制或画任何图片时，必须调用 generate_image 工具，" +
  //     "禁止仅用文字描述画面。";
  //   return { systemPrompt: event.systemPrompt + extra };
  // });
}
