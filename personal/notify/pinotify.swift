// pinotify.swift — 屏幕右上角非激活浮窗（不抢焦点、不经系统通知中心）
//
// 为什么自己画窗口：
//   本机 macOS 15.5 上 UNUserNotificationCenter / display notification 投递被
//   策略层拦死（granted=false, "Notifications are not allowed"），
//   且 osascript display notification 被拦时仍返回 exit 0（假成功，难以察觉）。
//   直接创建 NSPanel 属于「本进程画自己的窗口」，不需要任何通知授权，
//   也不会占用键盘焦点（.nonactivatingPanel + ignoresMouseEvents）。
//
// 用法：
//   pinotify --title "pi" --body "Ready for input" --kind success --duration 5
//     kind: success | error | info（决定图标与强调色）
//     duration: 停留秒数，默认 5
//
// 布局：多实例同时运行会占用不同纵向槽位（/tmp/pinotify-slots），避免叠在一起。

import Cocoa

// MARK: - 参数解析

var title = "pi"
var body = "Ready for input"
var kind = "info"
var duration: Double = 5.0

let argv = CommandLine.arguments
var i = 1
while i < argv.count {
    let key = argv[i]
    let val = i + 1 < argv.count ? argv[i + 1] : ""
    switch key {
    case "--title": title = val; i += 2
    case "--body": body = val; i += 2
    case "--kind": kind = val; i += 2
    case "--duration": duration = Double(val) ?? duration; i += 2
    default: i += 1
    }
}

// MARK: - 外观

let icon: String
let accent: NSColor
switch kind {
case "success": icon = "✅"; accent = .systemGreen
case "error": icon = "❌"; accent = .systemRed
default: icon = "ℹ️"; accent = .systemBlue
}

let W: CGFloat = 348
let H: CGFloat = 88
let margin: CGFloat = 14
let gap: CGFloat = 10
let maxSlots = 6

// MARK: - 槽位（多实例不重叠）

let slotDir = "/tmp/pinotify-slots"

func acquireSlot() -> Int {
    let fm = FileManager.default
    try? fm.createDirectory(atPath: slotDir, withIntermediateDirectories: true)
    var used = Set<Int>()
    let files = (try? fm.contentsOfDirectory(atPath: slotDir)) ?? []
    for f in files where f.hasSuffix(".pid") {
        guard let slot = Int(f.dropLast(4)) else { continue }
        let path = "\(slotDir)/\(f)"
        if let data = fm.contents(atPath: path),
           let s = String(data: data, encoding: .utf8),
           let pid = Int32(s.trimmingCharacters(in: .whitespacesAndNewlines)),
           kill(pid, 0) == 0 {
            used.insert(slot)          // 进程还活着，槽位占用中
        } else {
            try? fm.removeItem(atPath: path)  // 僵尸槽位，回收
        }
    }
    let slot = (0..<maxSlots).first { !used.contains($0) } ?? 0
    try? String(getpid()).write(toFile: "\(slotDir)/\(slot).pid", atomically: true, encoding: .utf8)
    return slot
}

func releaseSlot(_ slot: Int) {
    try? FileManager.default.removeItem(atPath: "\(slotDir)/\(slot).pid")
}

// MARK: - 窗口

let app = NSApplication.shared
app.setActivationPolicy(.accessory)   // 不出现 Dock 图标、不抢 app 焦点

/// 目标屏幕：鼠标所在屏 → 含菜单栏的主屏（screens[0]）→ NSScreen.main。
///
/// 不能用 NSScreen.main 作为首选：其 AppKit 语义是「key window 所在屏」，
/// 会随焦点窗口漂移到任意副屏，导致浮窗弹在用户没看的屏上（实测多屏下
/// 落到 x=-362，即左侧副屏边缘，等同于消失）。鼠标位置是「用户此刻视线」
/// 的稳定代理，且与系统通知的行为一致。
func targetScreen() -> NSScreen? {
    let mouse = NSEvent.mouseLocation
    if let s = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) {
        return s
    }
    return NSScreen.screens.first ?? NSScreen.main
}

guard let screen = targetScreen() else { exit(0) }
let vf = screen.visibleFrame

let slot = acquireSlot()
let y = vf.maxY - H - margin - CGFloat(slot) * (H + gap)
let xTarget = vf.maxX - W - margin
let xStart = vf.maxX + 24               // 从屏幕右侧外滑入

let panel = NSPanel(
    contentRect: NSRect(x: xStart, y: y, width: W, height: H),
    styleMask: [.borderless, .nonactivatingPanel],
    backing: .buffered,
    defer: false
)
panel.level = .statusBar
panel.isOpaque = false
panel.backgroundColor = .clear
panel.hasShadow = true
panel.hidesOnDeactivate = false
panel.ignoresMouseEvents = true          // 纯提示：鼠标穿透，不打断操作
panel.animationBehavior = .none
panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]

// 毛玻璃卡片
let card = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: W, height: H))
card.material = .hudWindow
card.blendingMode = .behindWindow
card.state = .active
card.wantsLayer = true
card.layer?.cornerRadius = 16
card.layer?.masksToBounds = true
card.layer?.borderWidth = 1
card.layer?.borderColor = NSColor.white.withAlphaComponent(0.14).cgColor

let iconLabel = NSTextField(labelWithString: icon)
iconLabel.font = NSFont.systemFont(ofSize: 22)
iconLabel.alignment = .center
iconLabel.translatesAutoresizingMaskIntoConstraints = false

let titleLabel = NSTextField(labelWithString: title)
titleLabel.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
titleLabel.textColor = .labelColor
titleLabel.lineBreakMode = .byTruncatingTail
titleLabel.maximumNumberOfLines = 1

let bodyLabel = NSTextField(labelWithString: body)
bodyLabel.font = NSFont.systemFont(ofSize: 12, weight: .regular)
bodyLabel.textColor = .secondaryLabelColor
bodyLabel.lineBreakMode = .byTruncatingTail
bodyLabel.maximumNumberOfLines = 2
bodyLabel.preferredMaxLayoutWidth = W - 84

let textStack = NSStackView(views: [titleLabel, bodyLabel])
textStack.orientation = .vertical
textStack.alignment = .leading
textStack.spacing = 3
textStack.translatesAutoresizingMaskIntoConstraints = false

// 左侧 accent 竖条
let bar = NSView()
bar.wantsLayer = true
bar.layer?.backgroundColor = accent.cgColor
bar.layer?.cornerRadius = 1.5
bar.translatesAutoresizingMaskIntoConstraints = false

card.addSubview(bar)
card.addSubview(iconLabel)
card.addSubview(textStack)
NSLayoutConstraint.activate([
    bar.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 0),
    bar.topAnchor.constraint(equalTo: card.topAnchor, constant: 14),
    bar.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -14),
    bar.widthAnchor.constraint(equalToConstant: 3),

    iconLabel.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 16),
    iconLabel.centerYAnchor.constraint(equalTo: card.centerYAnchor),
    iconLabel.widthAnchor.constraint(equalToConstant: 28),

    textStack.leadingAnchor.constraint(equalTo: iconLabel.trailingAnchor, constant: 10),
    textStack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -16),
    textStack.centerYAnchor.constraint(equalTo: card.centerYAnchor),
])

panel.contentView = card
panel.orderFrontRegardless()

// 滑入
NSAnimationContext.runAnimationGroup { ctx in
    ctx.duration = 0.26
    ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
    panel.animator().setFrame(NSRect(x: xTarget, y: y, width: W, height: H), display: true)
}

// 停留 → 淡出 → 退出
DispatchQueue.main.asyncAfter(deadline: .now() + duration) {
    NSAnimationContext.runAnimationGroup({ ctx in
        ctx.duration = 0.34
        ctx.timingFunction = CAMediaTimingFunction(name: .easeIn)
        panel.animator().alphaValue = 0
    }, completionHandler: {
        panel.orderOut(nil)
        releaseSlot(slot)
        exit(0)
    })
}

// 兜底：进程被信号打断也要释放槽位
atexit {
    let path = "\(slotDir)/\(slot).pid"
    if FileManager.default.fileExists(atPath: path) {
        try? FileManager.default.removeItem(atPath: path)
    }
}

app.run()
