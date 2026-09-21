#!/usr/bin/env node
/**
 * wb-latency-report.mjs — WorkBuddy「对话大模型不响应」取证报告
 *
 * 用来回答一个具体问题：**模型侧到底有没有响应？慢在哪一段？**
 *
 * 背景（2026-09-20 实测结案）：用户在 beautiCode 的 WorkBuddy 适配生效后觉得
 * 「模型不响应」。逐层取证的结论是**与注入无关**，而是两件事叠在一起：
 *
 *   1. 上游 `https://copilot.tencent.com/v2/chat/completions` 偶发尖峰。
 *      WorkBuddy 的 worker 日志有精确的 TTFT（首字延迟）埋点：
 *      当天同一台机器上 p50 约 2–6s，但尖峰可达 24–36s。
 *      用户等到 ~15s 就按了「停止」→ 看起来就是「模型不响应」。
 *   2. 取消之后宿主自己的前端状态机没恢复：`.cr-send-button` 一直
 *      `disabled`、`.cr-cancelled-indicator`（「用户已取消」）一直挂着，
 *      于是「发不出消息」比「模型慢」更像故障。
 *
 * 本脚本只读日志、不改注入、不碰页面。它把 worker 日志里的
 * sendPrompt → Sending request → First meaningful token → Stream completed
 * 串成时间线，直接给出「哪一段慢」。
 *
 * 用法：
 *   node scripts/wb-latency-report.mjs              # 最近 3 小时的请求时间线
 *   node scripts/wb-latency-report.mjs --hours 24   # 看一整天
 *   node scripts/wb-latency-report.mjs --slow 8000  # 自定义「慢」阈值（毫秒）
 *   node scripts/wb-latency-report.mjs --json       # 机器可读
 *
 * 日志位置（只读）：
 *   macOS   ~/.workbuddy/logs/<date>/*.log
 *   Windows %USERPROFILE%\.workbuddy\logs\<date>\*.log
 *
 * 隐私：只输出延迟数字与事件种类；不打印 prompt 正文、不打印账号信息。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── 参数 ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { hours: 3, slow: 10000, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hours') o.hours = Number(argv[++i]);
    else if (a.startsWith('--hours=')) o.hours = Number(a.slice(8));
    else if (a === '--slow') o.slow = Number(argv[++i]);
    else if (a.startsWith('--slow=')) o.slow = Number(a.slice(7));
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(
    '用法：node scripts/wb-latency-report.mjs [--hours 3] [--slow 10000] [--json]\n' +
    '  读取 WorkBuddy worker 日志，还原「发消息 → 模型首字 → 完成/取消」的时间线。\n' +
    '  --hours  回看多少小时（默认 3）      --slow  判定为慢的 ms 阈值（默认 10000）\n');
  process.exit(0);
}

const LOG_ROOT = path.join(os.homedir(), '.workbuddy', 'logs');
if (!fs.existsSync(LOG_ROOT)) {
  process.stderr.write(`找不到 WorkBuddy 日志目录：${LOG_ROOT}\n`);
  process.exit(2);
}

// ── 日志解析 ──────────────────────────────────────────────────────────
// 时间戳形如 `[9/20/2026, 4:52:47 PM.515]`，是本地时间。
const TS = /^\[(\d+)\/(\d+)\/(\d+), (\d+):(\d+):(\d+(?:\.\d+)?)\s*(AM|PM)\.\d+\]/i;

function parseStamp(line) {
  const m = TS.exec(line);
  if (!m) return null;
  const [, mo, day, yr, hRaw, min, sec, ap] = m;
  let h = Number(hRaw);
  const upper = ap.toUpperCase();
  if (upper === 'PM' && h !== 12) h += 12;
  if (upper === 'AM' && h === 12) h = 0;
  const d = new Date(Number(yr), Number(mo) - 1, Number(day), h, Number(min), 0, 0);
  return d.getTime() + Math.round(Number(sec) * 1000) % 60000;
}
const stamp = (t) => new Date(t).toTimeString().slice(0, 8);

/** 一天一个目录：YYYY-MM-DD。取最近 N 天里的日志文件。 */
function logFiles(hours) {
  const out = [];
  const days = Math.max(1, Math.ceil(hours / 24) + 1);
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const dir = path.join(LOG_ROOT, d.toISOString().slice(0, 10));
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.log')) out.push({ file: path.join(dir, f), workspace: f.split('__')[0] });
    }
  }
  // 顶层日志（旧版本落在这里）
  for (const f of fs.readdirSync(LOG_ROOT)) {
    if (f.endsWith('.log')) out.push({ file: path.join(LOG_ROOT, f), workspace: f.replace(/\.log$/, '') });
  }
  return out;
}

const EVENTS = [
  [/Sending request: agent=([^,]+), model=([^,]+)/, 'send'],
  [/First meaningful token received: agent=([^,]+), requestId=([^,]+), ttft=(\d+)ms/, 'first'],
  [/First raw chunk received: agent=([^,]+), requestId=([^,]+), elapsed=(\d+)ms/, 'raw'],
  [/Stream completed: agent=([^,]+), requestId=([^,]+), chunks=(\d+), bytes=(\d+), elapsed=(\d+)ms/, 'done'],
  [/Request failed: agent=([^,]+), requestId=([^,]+), error=(.+)$/, 'fail'],
  [/method:cancel \{"instanceId":"([^"]+)"/, 'cancel'],
  [/runtime\.applyStopReason .*stopReason":"([^"]+)"/, 'stop'],
];

function scan(entry, since) {
  const rows = [];
  let text;
  try { text = fs.readFileSync(entry.file, 'utf8'); } catch { return rows; }
  for (const line of text.split('\n')) {
    if (!line.includes('[ModelProvider]') && !line.includes('method:cancel') && !line.includes('runtime.applyStopReason')) continue;
    const t = parseStamp(line);
    if (t === null || t < since) continue;
    for (const [re, kind] of EVENTS) {
      const m = re.exec(line);
      if (!m) continue;
      rows.push({ t, kind, ws: entry.workspace, fields: m.slice(1).map((s) => String(s).trim()) });
      break;
    }
  }
  return rows;
}

const since = Date.now() - args.hours * 3600000;
const entries = logFiles(args.hours);
let rows = [];
for (const e of entries) rows = rows.concat(scan(e, since));
rows.sort((a, b) => a.t - b.t);

if (!rows.length) {
  process.stdout.write(`最近 ${args.hours} 小时内没有模型请求记录（${entries.length} 个日志文件）。\n`);
  process.exit(0);
}

// ── 报告 ──────────────────────────────────────────────────────────────
const ttfts = rows.filter((r) => r.kind === 'first').map((r) => Number(r.fields[2]));
ttfts.sort((a, b) => a - b);
const pick = (q) => (ttfts.length ? ttfts[Math.min(ttfts.length - 1, Math.floor(ttfts.length * q))] : null);

const cancels = rows.filter((r) => r.kind === 'cancel' || r.kind === 'stop').length;
// 可疑请求只在「发出去之后」看：要么慢出字，要么干脆没有任何后续。
// 不用 requestId 硬配对——`agent=unknown`（会话标题一类）走另一条路径、常常不落
// done，硬配会把正常请求误判成卡死。慢请求统一记在 first 那一行，且只记一次。
const stalls = [];
let slowPending = 0;
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  if (r.kind === 'first' && Number(r.fields[2]) >= args.slow) {
    if (slowPending > 0) { slowPending--; continue; } // 已被对应 send 记过
    stalls.push({ at: r.t, why: `首字延迟 ${Number(r.fields[2])}ms（超过阈值 ${args.slow}ms）` });
    continue;
  }
  if (r.kind !== 'send') continue;
  // `agent=unknown` 是会话标题一类的前置请求，几乎总会被紧跟着的主请求顶上。
  // 因此「下一个事件也是 send 且间隔很短」不算可疑，只有长时间无人接手才算。
  const next = rows.slice(i + 1).find((x) => x.kind !== 'raw');
  if (!next) stalls.push({ at: r.t, why: '发出后没有任何后续记录（既无首字也无结束）' });
  else if (next.kind === 'send') {
    if (next.t - r.t > 60000) stalls.push({ at: r.t, why: `发出后 ${Math.round((next.t - r.t) / 1000)}s 内没有任何响应，随后被新请求顶掉` });
  } else if (next.kind === 'first' && Number(next.fields[2]) >= args.slow) slowPending++;
}

if (args.json) {
  // 紧凑输出：时间线可能上万行，缩进版会被终端/管道截断成非法 JSON。
  process.stdout.write(JSON.stringify({
    hours: args.hours, slowMs: args.slow, requests: rows.filter((r) => r.kind === 'send').length,
    ttft: { n: ttfts.length, p50: pick(0.5), p90: pick(0.9), max: ttfts[ttfts.length - 1] ?? null },
    cancels, stalls,
    timeline: rows.map((r) => ({ t: r.t, k: r.kind, ws: r.ws, f: r.fields })),
  }) + '\n');
  process.exit(0);
}

const out = [];
out.push(`WorkBuddy 模型请求报告 · 最近 ${args.hours} 小时 · ${entries.length} 个日志文件`);
out.push('─'.repeat(78));
if (ttfts.length) {
  out.push(`首字延迟(TTFT)：样本 ${ttfts.length}  p50=${(pick(0.5) / 1000).toFixed(1)}s  ` +
    `p90=${(pick(0.9) / 1000).toFixed(1)}s  最慢=${(ttfts[ttfts.length - 1] / 1000).toFixed(1)}s`);
  out.push(`取消/停止事件：${cancels} 次`);
  out.push('');
  const slow = ttfts.filter((v) => v >= args.slow).length;
  if (slow) {
    out.push(`⚠ 有 ${slow} 次请求首字超过 ${args.slow}ms ——「模型不响应」多半就是等在这里，`);
    out.push('  不是没发出去，而是上游迟迟不出第一个 token。');
  } else {
    out.push(`✓ 没有超过 ${args.slow}ms 的请求：模型侧响应正常，若仍觉得卡，看下面的时间线找客户端原因。`);
  }
} else {
  out.push('窗口内没有首字记录（可能都被取消了）。');
}
out.push('');
out.push('时间线（send = 请求发出，first = 模型第一个有效 token，done = 流结束）：');
for (const r of rows) {
  if (r.kind === 'send') out.push(`${stamp(r.t)}  → send    ${r.ws} · agent=${r.fields[0]} · model=${r.fields[1]}`);
  else if (r.kind === 'first') out.push(`${stamp(r.t)}    first  ttft=${r.fields[2]}ms${Number(r.fields[2]) >= args.slow ? '   ⚠ 慢' : ''}`);
  else if (r.kind === 'raw') out.push(`${stamp(r.t)}    raw    elapsed=${r.fields[2]}ms`);
  else if (r.kind === 'done') out.push(`${stamp(r.t)}    done   elapsed=${r.fields[4]}ms chunks=${r.fields[2]}`);
  else if (r.kind === 'fail') out.push(`${stamp(r.t)}    fail   ${r.fields[2].slice(0, 60)}`);
  else if (r.kind === 'cancel') out.push(`${stamp(r.t)}    cancel （渲染层点击「停止」/ 取消）`);
  else if (r.kind === 'stop') out.push(`${stamp(r.t)}    stop   stopReason=${r.fields[0]}`);
}
if (stalls.length) {
  out.push('');
  out.push('可疑请求：');
  for (const s of stalls) out.push(`  ${stamp(s.at)}  ${s.why}`);
}
out.push('');
out.push('判读：send 与 first 之间的间隔 = 上游出字时间；cancelled 出现在 first 之前 = 用户主动放弃。');
out.push('若这里一切正常但 WorkBuddy 仍发不出消息，检查页面上的发送键是否被判为流式中：');
out.push("  document.querySelector('.cr-send-button').disabled  // true 且无流式输出 = 宿主前端状态未恢复");
process.stdout.write(out.join('\n') + '\n');
