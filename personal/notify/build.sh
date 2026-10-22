#!/usr/bin/env bash
# 编译 pinotify 浮窗工具到 ~/.pi/agent/bin/pinotify
# 依赖：Xcode Command Line Tools（swiftc 在 /usr/bin/swiftc）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${PINOTIFY_OUT_DIR:-$HOME/.pi/agent/bin}"
OUT="$OUT_DIR/pinotify"

mkdir -p "$OUT_DIR"
swiftc -O -o "$OUT" "$HERE/pinotify.swift" -framework Cocoa
chmod +x "$OUT"
echo "built: $OUT"
"$OUT" --title "pinotify" --body "构建完成，浮窗通道自测" --kind success --duration 3 &
