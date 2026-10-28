// C5 (2026-10-28): handoff 之后自动续跑 —— 纯 core 单测，零模型配额。
//
// 修复目标：`/handoff` 用 ctx.newSession 切换后只 setEditorText，新会话停在
// 编辑器等用户回车（「handoff 之后还要我催」）。deliverHandoffBriefing 把
// 已审阅的 briefing 直接作为新会话首条 user message 提交。
//
// env:
//   PI_LAMBOY_HANDOFF_AUTOSUBMIT=0  退回「只预填编辑器」旧行为

import assert from "node:assert/strict";

const { deliverHandoffBriefing, handoffAutoSubmitEnabled } = await import(
  "../packages/core/handoff/switch.ts"
);

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

function stubTarget({ throwOnSend = false } = {}) {
  const calls = { sent: [], editor: [] };
  return {
    calls,
    target: {
      sendUserMessage: async (text) => {
        if (throwOnSend) throw new Error("send failed");
        calls.sent.push(text);
      },
      ui: { setEditorText: (text) => calls.editor.push(text) },
    },
  };
}

const ENV = "PI_LAMBOY_HANDOFF_AUTOSUBMIT";
const saved = process.env[ENV];

// ── 1. 默认：自动提交，不再只预填 ──────────────────────────────────
delete process.env[ENV];
{
  check("default enabled", handoffAutoSubmitEnabled() === true);
  const { target, calls } = stubTarget();
  const submitted = await deliverHandoffBriefing(target, "BRIEF-1");
  check("auto-submit: sendUserMessage 被调用", calls.sent.length === 1 && calls.sent[0] === "BRIEF-1",
    JSON.stringify(calls.sent));
  check("auto-submit: 不再 setEditorText", calls.editor.length === 0, JSON.stringify(calls.editor));
  check("auto-submit: 返回 true（已提交）", submitted === true, String(submitted));
}

// ── 2. env 关闭：回到「预填 + 等用户回车」─────────────────────────
process.env[ENV] = "0";
{
  check("autosubmit=0 disables", handoffAutoSubmitEnabled() === false);
  const { target, calls } = stubTarget();
  const submitted = await deliverHandoffBriefing(target, "BRIEF-2");
  check("disabled: 不发送", calls.sent.length === 0, JSON.stringify(calls.sent));
  check("disabled: 预填编辑器", calls.editor.length === 1 && calls.editor[0] === "BRIEF-2",
    JSON.stringify(calls.editor));
  check("disabled: 返回 false（待用户提交）", submitted === false, String(submitted));
}

// ── 3. 发送失败 → 回落预填，briefing 不丢 ─────────────────────────
delete process.env[ENV];
{
  const { target, calls } = stubTarget({ throwOnSend: true });
  const submitted = await deliverHandoffBriefing(target, "BRIEF-3");
  check("send 失败: 回落 setEditorText", calls.editor.length === 1 && calls.editor[0] === "BRIEF-3",
    JSON.stringify(calls.editor));
  check("send 失败: 返回 false", submitted === false, String(submitted));
}

if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
