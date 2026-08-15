/**
 * Convert application errors to concise Chinese text at user-facing
 * boundaries. Internal error strings remain English so protocol matching and
 * recovery logic keep their existing semantics.
 */
export function toChineseErrorMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? "");
  const message = raw.trim();
  if (!message) return "未知错误。";

  // Chromium/Node use both spellings for the same missing-CDP symptom.
  if (/^(?:error:\s*)?(?:failed to fetch|fetch failed|fail fetch)$/i.test(message)) {
    return "未发现注入CDP的Codex进程";
  }

  const rules: Array<[RegExp, string | ((match: RegExpExecArray) => string)]> = [
    [
      /DeepSeek Harness URL must be loopback HTTP\.?/i,
      "DeepSeek Harness 地址必须使用本机回环 HTTP（127.0.0.1、localhost 或 ::1）。",
    ],
    [
      /DeepSeek Harness phase one supports image backgrounds only\.?/i,
      "DeepSeek Harness 第一阶段仅支持图片背景、清除和重新应用；视频、摸鱼模式、声音与色调暂不支持。",
    ],
    [
      /DeepSeek Harness bridge token file is invalid\.?/i,
      "DeepSeek Harness 桥接令牌文件无效，请删除该令牌文件后重新启动 beautiCode。",
    ],
    [
      /DeepSeek Harness bridge (?:is unavailable|request failed.*|request timed out)\.?/i,
      "未连接到 DeepSeek Harness。请先用 beautiCode 补丁启动 dsh web，并打开浏览器页面。",
    ],
    [
      /No DeepSeek Harness browser client is connected\.?/i,
      "DeepSeek Harness 页面尚未连接，请先在浏览器中打开 DSH Web。",
    ],
    [
      /DeepSeek Harness client (?:has not acknowledged this generation|failed to render the background)\.?/i,
      "DeepSeek Harness 页面未确认背景已成功显示。",
    ],
    [
      /DeepSeek Harness image apply requires a loopback media URL\.?/i,
      "无法为 DeepSeek Harness 创建安全的本机图片地址。",
    ],
    [
      /No healthy loopback Codex CDP endpoint found.*$/i,
      "未发现健康的本机 Codex CDP 端点，请先打开 Codex Desktop。",
    ],
    [/No CDP port configured\. Pass --port or enable auto-discover\.?/i, "未配置 CDP 端口，请传入 --port 或启用自动发现。"],
    [/CDP is missing or unreachable \(fail closed\)\.?/i, "未发现可用的 CDP 连接。"],
    [/ECONNREFUSED/i, "无法连接到目标服务（连接被拒绝）。"],
    [/ECONNRESET/i, "与目标服务的连接已重置。"],
    [/ETIMEDOUT|connection timed out/i, "操作超时。"],
    [/aborted/i, "操作已中止。"],
    [/No candidate page targets on CDP port/i, "CDP 端口上未发现可注入的页面。"],
    [/No live CDP sessions to apply background/i, "没有可应用背景的活动 CDP 会话。"],
    [/No live CDP sessions/i, "未发现活动的 CDP 会话。"],
    [/Timed out waiting for a CDP page target/i, "等待 CDP 页面超时。"],
    [/CDP target is missing webSocketDebuggerUrl/i, "CDP 目标缺少 WebSocket 调试地址。"],
    [/CDP webSocketDebuggerUrl is not a valid URL/i, "CDP WebSocket 调试地址无效。"],
    [/Rejected a CDP WebSocket URL outside the allowed loopback endpoint shape/i, "已拒绝非本机回环地址的 CDP WebSocket。"],
    [/Rejected an invalid CDP browser identity URL/i, "CDP 浏览器身份地址无效。"],
    [
      /CDP HTTP (\d+) for (.+)/i,
      (match) => `CDP 请求失败（HTTP ${match[1]}）：${match[2]}`,
    ],
    [/CDP response exceeded (.+) bytes(?: \(declared (.+)\))?\.?/i, (match) => `CDP 响应超过安全大小限制（${match[1]} 字节）。`],
    [/CDP response had no readable body for (.+)/i, (match) => `CDP 响应没有可读取的内容：${match[1]}`],
    [/CDP \/json\/version returned an unexpected shape\.?/i, "CDP 版本信息格式异常。"],
    [/CDP \/json\/list is not an array/i, "CDP 页面列表格式异常。"],
    [/CDP \/json\/list exceeded target count safety cap/i, "CDP 页面数量超过安全上限。"],
    [/CDP browser identity changed from (.+) to (.+)/i, (match) => `CDP 浏览器身份已变化（${match[1] ?? "旧"} → ${match[2] ?? "新"}）。`],
    [/CDP WebSocket open timed out/i, "CDP WebSocket 连接超时。"],
    [/CDP WebSocket open failed/i, "CDP WebSocket 连接失败。"],
    [/CDP socket closed/i, "CDP 套接字已关闭。"],
    [/CDP session is closed/i, "CDP 会话已关闭。"],
    [/CDP command timed out:\s*(.*)/i, (match) => `CDP 命令执行超时：${match[1] ?? "未知命令"}`],
    [/Renderer evaluation failed:\s*(.*)/i, (match) => `渲染器执行失败：${match[1] ?? "未知错误"}`],
    [/CDP probe only allows loopback hosts\.?/i, "CDP 探测只允许本机回环地址。"],
    [/CDP port must be an integer 1[–-]65535\.?/i, "CDP 端口必须是 1–65535 之间的整数。"],
    [/Session already stopped/i, "会话已经停止。"],
    [/Session is not started/i, "会话尚未启动。"],
    [/Session already started/i, "会话已经启动。"],
    [/Host is not connected/i, "尚未连接到 Codex 主机。"],
    [/CodexHostApplier is closed/i, "Codex 注入器已经关闭。"],
    [/Another beautiCode injector is running \(pid (\d+)\)\.?/i, (match) => `另一个 beautiCode 注入器正在运行（进程 ${match[1] ?? "未知"}）。`],
    [/CodexHostApplier port must be 1[–-]65535/i, "Codex 注入器端口必须是 1–65535 之间的整数。"],
    [/Another (.+) is running \(pid (\d+)\)\.?/i, (match) => `另一个${match[1] ?? "操作"}正在运行（进程 ${match[2] ?? "未知"}）。`],
    [/Another (.+) may be starting; lock owner is not readable yet\.?/i, (match) => `另一个${match[1] ?? "操作"}可能正在启动，暂时无法读取锁的所有者。`],
    [/Another background apply is already in progress\.?/i, "已有背景应用正在进行中，请等待当前操作完成。"],
    [/No active background\. Apply an image or video first\.?/i, "当前没有背景，请先应用图片或视频。"],
    [/Live verify did not pass \(([^)]+)\):\s*(.*)/i, (match) => `实时校验未通过（${translateVerifyStatus(match[1] ?? "") }）：${translateReadinessReason(match[2] ?? "")}`],
    [/Failed to inject background into any session:\s*(.*)/i, (match) => `未能向任何会话注入背景：${match[1]}`],
    [/Could not attach the local MP4 through CDP:\s*(.*)/i, (match) => `无法通过 CDP 附加本地 MP4：${translateMediaDetail(match[1] ?? "")}`],
    [/Could not toggle fish mode on any session/i, "无法在任何会话中切换摸鱼模式。"],
    [/Could not set background tone on any session/i, "无法在任何会话中设置背景色调。"],
    [/Could not toggle mute on any session/i, "无法在任何会话中切换视频声音。"],
    [/runtime rejected fish mode \(no background\?\)/i, "运行时拒绝摸鱼模式：当前没有背景。"],
    [/runtime rejected mute toggle/i, "运行时拒绝切换视频声音。"],
    [/renderer does not support background tone/i, "当前渲染器不支持背景色调。"],
    [/video decode\/playback failed/i, "视频解码或播放失败。"],
    [/video node missing/i, "未找到视频节点。"],
    [/video has no playable local source/i, "视频没有可播放的本地来源。"],
    [/poster\/image decode failed/i, "海报图片解码失败。"],
    [/poster\/image missing/i, "未找到海报图片。"],
    [/background stage missing/i, "未找到背景渲染层。"],
    [/clear expected but background still active/i, "预期已清除背景，但背景仍处于活动状态。"],
    [/generation mismatch \(page=(.+), expected=(.+)\)/i, (match) => `背景版本不匹配（页面=${match[1]}，预期=${match[2]}）。`],
    [/horizontal document overflow detected/i, "检测到页面出现横向溢出。"],
    [/empty readiness snapshot/i, "未读取到渲染就绪状态。"],
    [/snapshot missing generation/i, "渲染状态缺少背景版本号。"],
    [/video expected but renderer reports (.+)/i, (match) => `预期显示视频，但渲染器报告：${match[1] ?? "未知状态"}。`],
    [/stage pointer-events must be none \(got (.+)\)/i, (match) => `背景层 pointer-events 必须为 none（当前为 ${match[1]}）。`],
    [/Video background is missing a video basename\.?/i, "视频背景缺少视频文件名。"],
    [/Video payload requires a detached runtime copy\.?/i, "视频载荷需要独立的运行时副本。"],
    [/Unsupported media extension(?: for data URL)?:\s*(.*)/i, (match) => `不支持的媒体扩展名：${match[1]}`],
    [/Could not acquire (.+) lock\.?/i, (match) => `无法获取${match[1]}锁。`],
    [/Interrupted commit could not recover either active generation\.?/i, "中断的提交无法恢复任何一个活动版本。"],
    [/Runtime media root must be a real directory\.?/i, "运行时媒体根目录必须是真实目录。"],
    [/Runtime media session must be a real directory\.?/i, "运行时媒体会话目录必须是真实目录。"],
    [/Snapshot must be a generated child of the snapshots directory\.?/i, "快照必须位于快照目录生成的子目录中。"],
    [/Snapshot directory cannot be a link\.?/i, "快照目录不能是链接。"],
    [/Snapshot manifest is invalid\.?/i, "快照清单无效。"],
    [/Promoted active manifest is invalid\.?/i, "提升后的活动清单无效。"],
    [/Theme name must be 1[–-]80 characters\.?/i, "主题名称长度必须为 1–80 个字符。"],
    [/Theme name contains illegal characters\.?/i, "主题名称包含非法字符。"],
    [/No active background to save\.?/i, "当前没有可保存的背景。"],
    [/Saved theme limit reached \((\d+)\)\. Delete one before saving\.?/i, (match) => `已达到保存主题数量上限（${match[1]}），请先删除一个主题。`],
    [/Saved theme storage limit exceeded \((\d+) bytes\)\. Delete a theme before saving\.?/i, (match) => `已超过保存主题的存储上限（${match[1]} 字节），请先删除一个主题。`],
    [/Invalid saved theme id\.?/i, "已保存主题 ID 无效。"],
    [/Saved theme not found\.?/i, "未找到已保存的主题。"],
    [/Invalid video position\.?/i, "视频位置无效。"],
    [/Theme meta unreadable\.?/i, "主题元数据无法读取。"],
    [/Theme meta invalid\.?/i, "主题元数据无效。"],
    [/Not a video theme\.?/i, "该主题不是视频主题。"],
    [/Saved theme manifest is invalid\.?/i, "已保存主题清单无效。"],
    [/Saved video theme has no video file\.?/i, "已保存的视频主题缺少视频文件。"],
    [/Saved theme path escaped saved root\.?/i, "已保存主题路径越过了保存目录。"],
    [/Saved theme directory cannot be a link\.?/i, "已保存主题目录不能是链接。"],
    [/Saved theme real path escaped saved root\.?/i, "已保存主题真实路径越过了保存目录。"],
    [/Staging transaction escaped staging root\.?/i, "暂存事务越过了暂存目录。"],
    [/Invalid media commit payload\.?/i, "媒体提交载荷无效。"],
    [/Media file ended while revalidating/i, "媒体文件在重新校验时提前结束。"],
    [/Media hub is closed/i, "媒体服务已关闭。"],
    [/Local media server did not expose a TCP port\.?/i, "本地媒体服务未提供 TCP 端口。"],
    [/Media hub closed while listener was starting\.?/i, "媒体服务在监听器启动时已关闭。"],
    [/Media path became a symbolic link/i, "媒体路径变成了符号链接。"],
    [/Media file changed or exceeded the safety limit/i, "媒体文件已变化或超过安全限制。"],
    [/Media file content changed after staging/i, "媒体文件在暂存后发生了内容变化。"],
    [/Media file too large to embed as data URL \((\d+) > (\d+)\)\.?/i, (match) => `媒体文件过大，无法嵌入数据地址（${match[1]}/${match[2]} 字节）。`],
    [/beautiCode data root must be a real directory\.?/i, "beautiCode 数据根目录必须是真实目录。"],
    [/beautiCode data-root ownership marker is invalid\.?/i, "beautiCode 数据目录所有权标记无效。"],
    [/Media file not found:\s*(.*)/i, (match) => `未找到媒体文件：${match[1]}`],
    [/Media path must be a regular file\.?/i, "媒体路径必须指向普通文件。"],
    [/Image must use one of:\s*(.*)/i, (match) => `图片必须使用以下扩展名之一：${match[1]}`],
    [/Image must be a non-empty file no larger than (\d+) bytes\.?/i, (match) => `图片必须是非空文件，且不超过 ${match[1]} 字节。`],
    [/Image content does not match a supported JPEG\/PNG\/WEBP\/AVIF signature\.?/i, "图片内容与支持的 JPEG/PNG/WEBP/AVIF 格式不匹配。"],
    [/Video backgrounds must use an MP4 file\.?/i, "视频背景必须使用 MP4 文件。"],
    [/Video background must be a non-empty MP4 no larger than (\d+) bytes\.?/i, (match) => `视频背景必须是非空 MP4 文件，且不超过 ${match[1]} 字节。`],
    [/Video background is not a valid MP4 container\.?/i, "视频背景不是有效的 MP4 容器。"],
    [/must be a basename string\.?/i, "必须是文件名字符串。"],
    [/must be a basename only\.?/i, "只能是文件名，不能包含路径。"],
    [/contains illegal path characters\.?/i, "包含非法路径字符。"],
    [/contains characters invalid in Windows basenames\.?/i, "包含 Windows 文件名不允许的字符。"],
    [/uses a reserved device name\.?/i, "使用了 Windows 保留设备名。"],
    [/contains control characters\.?/i, "包含控制字符。"],
    [/missing data url/i, "缺少数据地址。"],
    [/data url fetch failed:\s*(\d+)/i, (match) => `数据地址加载失败（HTTP ${match[1]}）。`],
    [/malformed data url/i, "数据地址格式错误。"],
    [/missing media url/i, "缺少媒体地址。"],
    [/media fetch failed:\s*(\d+)/i, (match) => `媒体加载失败（HTTP ${match[1]}）。`],
    [/no video source/i, "没有视频来源。"],
    [/Renderer did not create the video file input/i, "渲染器未创建视频文件输入框。"],
    [/DOM\.getDocument returned no root nodeId/i, "DOM 文档没有返回根节点 ID。"],
    [/Video file input is not attached to the renderer DOM/i, "视频文件输入框未附加到渲染器 DOM。"],
    [/stale generation/i, "背景版本已过期，正在重新加载。"],
    [/request body too large/i, "请求内容过大。"],
    [/request body must be a JSON object/i, "请求内容必须是 JSON 对象。"],
    [/unauthorized/i, "未授权的请求。"],
    [/shutting down/i, "服务正在关闭。"],
    [/not found/i, "未找到请求的资源。"],
    [/Unknown flag:\s*(.*)/i, (match) => `未知参数：${match[1] ?? ""}`],
    [/Refusing to adopt a non-empty directory without beautiCode data\. Choose an empty --data-root\.?/i, "拒绝接管不含 beautiCode 数据的非空目录，请选择空的 --data-root。"],
  ];

  for (const [pattern, replacement] of rules) {
    const match = pattern.exec(message);
    if (!match) continue;
    return typeof replacement === "function"
      ? replacement(match)
      : message.replace(pattern, replacement);
  }

  return message;
}

function translateReadinessReason(reason: string): string {
  return toChineseErrorMessage(reason);
}

function translateVerifyStatus(status: string): string {
  if (/^fail$/i.test(status)) return "失败";
  if (/^inconclusive$/i.test(status)) return "无法确定";
  return status;
}

function translateMediaDetail(detail: string): string {
  return toChineseErrorMessage(detail);
}
