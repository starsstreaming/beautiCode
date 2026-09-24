#!/usr/bin/env node
/**
 * wb-cdp-runner.mjs — WorkBuddy 背景功能注入守护（完整版）
 *
 * 应用序列（对齐 docs/host-adapter-workbuddy.md 的 M1 / §5.2 / §5.7）：
 *   1) UI payload：侧栏「自定义背景」条目 + 背景面板 + #beauticode-bg-stage
 *   2) 契约 CSS：buildContractCss（壁纸区透明 / 浮层统一 α=0.82 / 压平 / 遮罩；
 *      浅深两套同时烘，切主题不需重注）
 *   3) token 覆盖层：页面侧 TOKEN_SCAN_EXPRESSION 扫描 → buildTokenOverlayCss
 *   4) 硬编码中性面中立化：HARDCODED_SURFACE_SCAN_EXPRESSION → buildHardcodedSurfaceCss
 *   5) 样式看门狗：buildStyleKeeperExpression 把我们的 <style> 钉在 <head> 末尾
 *
 * 没有第 2-5 步时，壁纸被 .teams-container（100% 不透明外壳）整个盖住 ——
 * 「导入了图片但看不到」就是这个原因。
 *
 * 用法：
 *   node wb-cdp-runner.mjs                # 常驻：连上就应用；断开 3s 后重连（默认）
 *   node wb-cdp-runner.mjs --once         # 应用一次后退出
 *   node wb-cdp-runner.mjs --clean        # 清理（注入节点 + 样式）后退出
 *   node wb-cdp-runner.mjs --port 9335 --verbose
 *
 * 安全：URL 仅打印 pathname 前 32 字符（query 含账号快照，§3.3 脱敏）；
 *       不写 ~/.workbuddy/；清理 = 移除 data-bc-injected 节点 + 我们的 <style>。
 */

import process from 'node:process';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 导入 adapter（workspace 名优先，相对 dist 兜底） ─────────────────────
async function loadAdapter() {
  const candidates = [
    '@beauticode/adapter-workbuddy',
    '../packages/adapter-workbuddy/dist/index.js',
  ];
  for (const c of candidates) {
    try { return await import(c); } catch { /* 试下一个 */ }
  }
  throw new Error('无法导入 @beauticode/adapter-workbuddy —— 先跑 tsc 编译该包');
}
const A = await loadAdapter();
const {
  BACKGROUND_BAR_INJECTION, BACKGROUND_BAR_CLEANUP, BACKGROUND_BAR_STYLE_ID,
  buildContractCss, readTheme,
  TOKEN_SCAN_EXPRESSION, buildTokenOverlayCss, TOKEN_OVERLAY_STYLE_ID,
  HARDCODED_SURFACE_SCAN_EXPRESSION, buildHardcodedSurfaceCss,
  buildStyleKeeperExpression,
  pickWorkBuddyTarget, assertLoopbackDebuggerUrl, safeTargetLabel,
  ensureWorkBuddyCdp,
} = A;
for (const [k, v] of Object.entries({
  BACKGROUND_BAR_INJECTION, BACKGROUND_BAR_CLEANUP, buildContractCss, readTheme,
  TOKEN_SCAN_EXPRESSION, buildTokenOverlayCss, TOKEN_OVERLAY_STYLE_ID,
  HARDCODED_SURFACE_SCAN_EXPRESSION, buildHardcodedSurfaceCss, buildStyleKeeperExpression,
  pickWorkBuddyTarget, assertLoopbackDebuggerUrl, safeTargetLabel,
  ensureWorkBuddyCdp,
})) {
  if (typeof v !== 'string' && typeof v !== 'function') {
    process.stderr.write(`adapter 导出形状不对：${k}\n`); process.exit(2);
  }
}
const CONTRACT_STYLE_ID = A.STYLE_ID || 'beauticode-contract-style';
const HARDCODED_STYLE_ID = 'beauticode-hardcoded-style';
const APPLY_IDS = [CONTRACT_STYLE_ID, TOKEN_OVERLAY_STYLE_ID, HARDCODED_STYLE_ID];

// ── 参数 ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { port: 0, once: false, clean: false, verbose: false, help: false, watchdog: false, noLaunch: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') o.port = parseInt(argv[++i], 10);
    else if (a === '--wallpaper') o.wallpaper = argv[++i];
    else if (a === '--once') o.once = true;
    else if (a === '--clean') o.clean = true;
    else if (a === '--verbose' || a === '-v') o.verbose = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--watchdog') o.watchdog = true;
    else if (a === '--no-launch') o.noLaunch = true;
    else if (a.startsWith('--port=')) o.port = parseInt(a.slice(7), 10);
  }
  return o;
}
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(
    '用法：node wb-cdp-runner.mjs [--port 9335] [--once] [--clean] [--verbose] [--watchdog] [--no-launch]\n' +
    '  默认常驻：仅修复 10 秒内新启动且没有 CDP 的 WorkBuddy；主动退出后不会重开\n' +
    '  --once   应用一次后退出    --clean  清理后退出    --watchdog 崩溃拉起\n' +
    '  --no-launch  不启动/重启宿主，缺 CDP 时失败退出\n');
  process.exit(0);
}
let PORT = args.port || parseInt(process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT || '9335', 10);
// 默认壁纸：舞台没有媒体时自动铺上（否则透明面透出的是 #101114 纯色，
// 看起来就像"不透明没生效"——实测踩过）。--wallpaper 可换。
const DEFAULT_WALLPAPER = args.wallpaper
  || path.join(REPO, 'assets', 'themes', 'internal-beyond', 'bg-canvas-4k.png');

function ts() { return new Date().toISOString().slice(11, 23); }
const log = {
  info: (...m) => process.stderr.write(`[${ts()}] [info] ` + m.join(' ') + '\n'),
  warn: (...m) => process.stderr.write(`[${ts()}] [warn] ` + m.join(' ') + '\n'),
  error: (...m) => process.stderr.write(`[${ts()}] [error] ` + m.join(' ') + '\n'),
  debug: (...m) => { if (args.verbose) process.stderr.write(`[${ts()}] [debug] ` + m.join(' ') + '\n'); },
};
const fp = (u) => safeTargetLabel(u);

// ── CDP ───────────────────────────────────────────────────────────────
const MAX_CDP_JSON_BYTES = 1_000_000;
async function fetchBoundedJson(url) {
  const r = await fetch(url, { redirect: 'error' });
  if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
  const declared = Number(r.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_CDP_JSON_BYTES) {
    throw new Error(`CDP JSON exceeded ${MAX_CDP_JSON_BYTES} bytes`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_CDP_JSON_BYTES) {
    throw new Error(`CDP JSON exceeded ${MAX_CDP_JSON_BYTES} bytes`);
  }
  return JSON.parse(buf.toString('utf8'));
}
async function fetchTargets(port) {
  const list = await fetchBoundedJson(`http://127.0.0.1:${port}/json/list`);
  if (!Array.isArray(list)) throw new Error('/json/list is not an array');
  if (list.length > 500) throw new Error('/json/list exceeded target count safety cap');
  return list;
}
function openWs(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const handlers = [];
    const send = (method, params = {}) => new Promise((res, rej) => {
      const i = ++id; pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.rej(new Error(`${m.error.code || ''} ${m.error.message || ''}`.trim())) : p.res(m.result);
        return;
      }
      if (m.method) for (const cb of handlers) { try { cb(m); } catch {} }
    });
    const onEvent = (cb) => handlers.push(cb);
    ws.addEventListener('open', () => resolve({ ws, send, onEvent, close: () => ws.close() }));
    ws.addEventListener('error', (e) => reject(new Error(`WS error: ${e.message || e}`)));
  });
}
async function evaluate(c, expression) {
  const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 200));
  return r.result?.value;
}
function setStyleExpr(id, css) {
  return `(function(){
var id=${JSON.stringify(id)}, css=${JSON.stringify(css)};
var el=document.getElementById(id);
if(!el){el=document.createElement('style');el.id=id;el.setAttribute('data-bc-injected','beauticode');document.head.appendChild(el);}
el.textContent=css;return 'style:'+id;})()`;
}

// ── 皮肤商城（DSH gallery 对齐）：本地服务 + 浏览器商城页 ─────────────
// 公用皮肤 = 内置素材 + 用户皮肤目录（~/Library/Application Support/beauticode/skins）。
// 浏览器里点卡片 → /apply → 经 CDP 应用到 WorkBuddy 面板（__bcApplyBackgroundPath）。
const GALLERY_PORT_BASE = 9337;
const GALLERY_TOKEN = crypto.randomBytes(16).toString('hex');
const SKIN_ID = /^skin-[a-f0-9]{8,40}$/i;
const CENTER_URL = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(REPO, 'integrations', 'deepseek-harness', 'skin-center.json'), 'utf8')).url;
    const parsed = new URL(String(raw || ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch { return null; }
})();
const DATA_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'beauticode')
  : path.join(os.homedir(), 'Library', 'Application Support', 'beauticode');
const SKINS_DIR = path.join(DATA_DIR, 'skins');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const GALLERY_MEDIA = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/mp4',
};
let galleryConn = null;
let galleryPort = null;
let galleryServer = null;
let galleryApplyFn = null;
const skinRegistry = new Map();

function buildCatalog() {
  skinRegistry.clear();
  const skins = [];
  const add = (p, name) => {
    const ext = path.extname(p).toLowerCase();
    if (!GALLERY_MEDIA[ext] || !fs.existsSync(p)) return;
    const id = 'skin-' + crypto.createHash('sha1').update(p).digest('hex').slice(0, 12);
    skinRegistry.set(id, p);
    skins.push({ id, name, type: ['.mp4', '.mov', '.webm', '.m4v'].includes(ext) ? 'video' : 'image' });
  };
  const themeDir = path.join(REPO, 'assets', 'themes', 'internal-beyond');
  const bundled = {
    'bg-canvas-4k.png': '内置 · 画布 4K', 'bg-canvas.png': '内置 · 画布',
    'bg-infernal.jpg': '内置 · 炼狱', 'bg-internal.jpg': '内置 · 内在',
  };
  try { for (const f of fs.readdirSync(themeDir)) if (bundled[f]) add(path.join(themeDir, f), bundled[f]); } catch { /* 素材目录缺失 */ }
  try {
    fs.mkdirSync(SKINS_DIR, { recursive: true });
    for (const f of fs.readdirSync(SKINS_DIR)) add(path.join(SKINS_DIR, f), f.replace(/\.[^.]+$/, ''));
  } catch { /* 用户目录不可读 */ }
  return skins;
}

function galleryPage() {
  const tokenJson = JSON.stringify(GALLERY_TOKEN);
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>beauticode 皮肤商城</title><style>
body{margin:0;background:#101114;color:rgba(228,228,228,.92);font:15px -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
header{padding:16px 22px;border-bottom:.5px solid rgba(255,255,255,.12);background:rgb(36,36,36)}
h1{margin:0;font-size:15px;font-weight:500}
header p{margin:4px 0 0;font-size:12px;color:rgba(228,228,228,.55)}
main{padding:16px 22px;display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}
.card{border:.5px solid rgba(255,255,255,.14);outline:.5px solid rgba(255,255,255,.07);outline-offset:-.5px;border-radius:14px;overflow:hidden;background:rgb(36,36,36);cursor:pointer;text-align:left;color:rgba(228,228,228,.92);padding:0;font:inherit}
.card:hover{background:rgba(255,255,255,.09)}
.card img,.card video{width:100%;aspect-ratio:16/10;object-fit:cover;display:block;background:rgb(24,24,24)}
.card span{display:block;padding:8px 10px;font-size:13px}
#msg{padding:10px 22px;min-height:20px;color:rgba(228,228,228,.55);font-size:12px}
</style></head><body>
<header><h1>beauticode 皮肤商城</h1><p>公用皮肤 · 点卡片直接应用到 WorkBuddy · 把文件放进皮肤目录可上架自己的皮肤</p></header>
<div id="msg">正在读取目录…</div><main id="grid"></main>
<script>
var TOKEN = ${tokenJson};
fetch('/api/catalog?t=' + encodeURIComponent(TOKEN)).then(function(r){return r.json()}).then(function(d){
  var g = document.getElementById('grid');
  document.getElementById('msg').textContent = d.skins.length ? ('共 ' + d.skins.length + ' 款') : '目录是空的';
  (d.skins || []).forEach(function(s){
    var card = document.createElement('button');
    card.className = 'card';
    card.dataset.id = s.id;
    card.dataset.name = s.name || '';
    var media = document.createElement(s.type === 'video' ? 'video' : 'img');
    if (s.type === 'video') { media.muted = true; media.preload = 'metadata'; } else { media.alt = ''; }
    media.src = '/media?id=' + encodeURIComponent(s.id) + '&t=' + encodeURIComponent(TOKEN);
    var span = document.createElement('span');
    span.textContent = s.name + (s.type === 'video' ? ' · 视频' : '');
    card.appendChild(media); card.appendChild(span); g.appendChild(card);
  });
  g.addEventListener('click', function(ev){
    var c = ev.target.closest('.card'); if (!c) return;
    document.getElementById('msg').textContent = '正在应用「' + c.dataset.name + '」…';
    fetch('/apply', { method: 'POST', headers: { 'content-type': 'application/json', 'x-beauticode-media-token': TOKEN }, body: JSON.stringify({ id: c.dataset.id }) })
      .then(function(r){return r.json()}).then(function(j){
        document.getElementById('msg').textContent = j.ok ? ('已应用到 WorkBuddy：「' + c.dataset.name + '」') : (j.error || '应用失败');
      }).catch(function(){ document.getElementById('msg').textContent = '应用失败（守护未连接？）'; });
  });
});
</script></body></html>`;
}

function isLoopbackHost(hostHeader) {
  const host = String(hostHeader || '').split(':')[0].toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (origin === 'null') return true;
  try {
    const parsed = new URL(origin);
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
  } catch {
    return false;
  }
}

function requestToken(req, url, body) {
  const header = req.headers['x-beauticode-media-token'];
  if (typeof header === 'string' && header) return header;
  if (url.searchParams.get('t')) return url.searchParams.get('t');
  if (body && typeof body.token === 'string') return body.token;
  return '';
}

function deny(res, status, error) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: false, error }));
}

function startGalleryServer(applyFn) {
  galleryApplyFn = applyFn;
  if (galleryServer && galleryPort) return Promise.resolve(galleryPort);

  const galleryHandler = (req, res) => {
    if (!isLoopbackHost(req.headers.host) || !isAllowedOrigin(req.headers.origin)) {
      deny(res, 403, 'forbidden origin');
      return;
    }
    const u = new URL(req.url, 'http://127.0.0.1');
    const allowedOrigin = req.headers.origin && isAllowedOrigin(req.headers.origin) ? req.headers.origin : '';
    if (allowedOrigin) res.setHeader('access-control-allow-origin', allowedOrigin);
    res.setHeader('access-control-allow-headers', 'content-type, x-beauticode-media-token');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    res.setHeader('content-type', 'application/json; charset=utf-8');

    if (u.pathname === '/beauticode/gallery' || u.pathname === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(galleryPage());
      return;
    }

    const tokenOk = requestToken(req, u, null) === GALLERY_TOKEN;

    if (u.pathname === '/api/catalog') {
      if (!tokenOk) { deny(res, 403, 'bad token'); return; }
      res.end(JSON.stringify({ skins: buildCatalog() }));
      return;
    }
    if (u.pathname === '/media') {
      if (!tokenOk) { deny(res, 403, 'bad token'); return; }
      const id = u.searchParams.get('id') || '';
      if (!SKIN_ID.test(id)) { deny(res, 400, 'bad id'); return; }
      const file = skinRegistry.get(id);
      if (!file || !fs.existsSync(file)) { deny(res, 404, 'unknown id'); return; }
      res.setHeader('content-type', GALLERY_MEDIA[path.extname(file).toLowerCase()] || 'application/octet-stream');
      fs.createReadStream(file).pipe(res);
      return;
    }
    if (u.pathname === '/apply') {
      if (req.method !== 'POST') { deny(res, 405, 'POST required'); return; }
      const chunks = [];
      let n = 0;
      req.on('data', (c) => {
        n += c.length;
        if (n > 4096) { req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = {}; }
        if (requestToken(req, u, body) !== GALLERY_TOKEN) { deny(res, 403, 'bad token'); return; }
        const id = String(body.id || '');
        if (!SKIN_ID.test(id)) { deny(res, 400, 'bad id'); return; }
        const file = skinRegistry.get(id);
        if (!file) { deny(res, 404, 'unknown id'); return; }
        if (!galleryConn || !galleryApplyFn) { deny(res, 503, '守护未连接 WorkBuddy'); return; }
        galleryApplyFn(file)
          .then(() => { log.info(`皮肤商城：已应用 ${path.basename(file)}`); res.end(JSON.stringify({ ok: true, name: path.basename(file) })); })
          .catch((e) => { deny(res, 500, e.message); });
      });
      return;
    }
    deny(res, 404, 'not found');
  };

  return new Promise((resolve) => {
    let p = GALLERY_PORT_BASE;
    const tryNext = () => {
      if (p >= GALLERY_PORT_BASE + 9) {
        log.warn('皮肤商城端口耗尽（9337-9345），未启动（其余功能不受影响）');
        resolve(null);
        return;
      }
      const port = p++;
      const server = createServer(galleryHandler);
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE') { log.info(`皮肤商城端口 ${port} 被占，换下一个…`); tryNext(); }
        else { log.warn('皮肤商城服务错误：', e.message); resolve(null); }
      });
      server.listen(port, '127.0.0.1', () => {
        galleryServer = server;
        galleryPort = port;
        log.info(`皮肤商城 ✓ http://127.0.0.1:${port}/beauticode/gallery（仅本机，需令牌）`);
        resolve(port);
      });
    };
    tryNext();
  });
}

// ── 完整应用序列 ──────────────────────────────────────────────────────
// α 槽变量化：把生成 CSS 里烘焙的「82%, transparent)」统一替换为
// 「var(--bc-surface-alpha-pct, 82%), transparent)」——面板透明度滑杆从此
// 实时驱动（纯 CSS 变量，拖动即生效，无需守护重造）。
const ALPHA_VARIFY = (css) =>
  css.split(' 82%, transparent)').join(' var(--bc-surface-alpha-pct, 82%), transparent)');

function isBlankPersistState(live) {
  return !live || (
    !live.wallpaper && !live.cleared && !live.blob &&
    live.dim == null && live.blur == null && live.alpha == null &&
    (!Array.isArray(live.themes) || live.themes.length === 0) &&
    !live.activeThemeId
  );
}

async function applyAll(c) {
  // 1) 主题（fail-closed：读不出就不上 CSS，只上 UI 并说明原因）
  let className = await evaluate(c, 'document.documentElement.className');
  let theme = readTheme(String(className || ''));
  // 启动期 html 常常还没挂上主题类（class=""）。旧实现就此跳过透明契约，
  // 而契约样式表一旦缺失，界面全程实心、壁纸被盖住——用户看到的是
  // 「导入没反应」。这里先短暂重试，等主题类出现再注入。
  for (let i = 0; !theme && i < 6; i++) {
    await new Promise((r) => setTimeout(r, 400));
    className = await evaluate(c, 'document.documentElement.className');
    theme = readTheme(String(className || ''));
    if (theme) log.info(`主题延迟可读（第 ${i + 1} 次重试）→ 正常注入契约`);
  }
  if (!theme) log.warn(`读不出主题（class="${String(className).slice(0, 60)}"）—— 本轮只注入 UI，不上透明契约`);

  // 2) 契约 CSS（浅深两套同时烘）
  if (theme) {
    await evaluate(c, setStyleExpr(CONTRACT_STYLE_ID, ALPHA_VARIFY(buildContractCss({ theme }))));
    log.info('contract CSS ✓（' + CONTRACT_STYLE_ID + '）');
  }

  // 3) token 覆盖层（页面侧扫描 → 生成）
  const scanRaw = await evaluate(c, TOKEN_SCAN_EXPRESSION);
  const scan = typeof scanRaw === 'string' ? JSON.parse(scanRaw) : scanRaw;
  const overlay = ALPHA_VARIFY(buildTokenOverlayCss(scan.rows || []));
  await evaluate(c, setStyleExpr(TOKEN_OVERLAY_STYLE_ID, overlay));
  log.info(`token overlay ✓（${(scan.rows || []).length} 个面 token，${(overlay.length / 1024).toFixed(0)} KB）`);

  // 4) 硬编码中性面中立化
  const hardRaw = await evaluate(c, HARDCODED_SURFACE_SCAN_EXPRESSION);
  const hard = typeof hardRaw === 'string' ? JSON.parse(hardRaw) : hardRaw;
  const hardCss = ALPHA_VARIFY(buildHardcodedSurfaceCss(hard.selectors || []));
  if (hardCss) await evaluate(c, setStyleExpr(HARDCODED_STYLE_ID, hardCss));
  log.info(`hardcoded 中立化 ✓（${(hard.selectors || []).length} 个面，跳过饱和 ${hard.skippedSaturated ?? 0}）`);

  // 4.6) 产物面板还原层：半透明体系只作用于外壳，产物阅读面（.sidebar-next）
  //      恢复原版 token（含语法高亮色）+ 中立化背景改回实心——否则面板内
  //      高亮被 color-mix 污染（用户实测"高亮全错"）、视频透光造成频闪。
  const restParts = [];
  const lTok = [], dTok = [];
  for (const row of (scan.rows || [])) {
    if (!row.token || !row.token.startsWith('--')) continue;
    if (row.lightValue) lTok.push(row.token + ':' + row.lightValue + ' !important;');
    if (row.darkValue) dTok.push(row.token + ':' + row.darkValue + ' !important;');
  }
  if (lTok.length) restParts.push('html.light .sidebar-next,html.cb-light .sidebar-next{' + lTok.join('') + '}');
  if (dTok.length) restParts.push('html.dark .sidebar-next,html.cb-dark .sidebar-next{' + dTok.join('') + '}');
  for (const sel of (hard.selectors || [])) {
    if (/^html|^[^\s.#[a-z]/i.test(sel)) continue;
    restParts.push('.sidebar-next ' + sel + '{background-color:var(--bc-panel-solid) !important}');
  }
  if (restParts.length) {
    const rest =
      'html:root{--bc-panel-solid-dark:rgb(31,31,31);--bc-panel-solid-light:rgb(252,252,252)}' +
      'html.dark .sidebar-next,html.cb-dark .sidebar-next{--bc-panel-solid:rgb(31,31,31)}' +
      'html.light .sidebar-next,html.cb-light .sidebar-next{--bc-panel-solid:rgb(252,252,252)}' +
      restParts.join('');
    await evaluate(c, setStyleExpr('beauticode-restore-panel', rest));
    log.info('产物面板还原层 ✓（' + (scan.rows || []).length + ' token 回原版，' + (hard.selectors || []).length + ' 面改实心）');
  }

  // 4.5) 沉降幕样式常驻：面板打开（守护触发）与文件卡片点击（页面内触发）共用
  await evaluate(c, "(function(){var s=document.getElementById('beauticode-panel-settle');if(!s){s=document.createElement('style');s.id='beauticode-panel-settle';s.textContent='.sidebar-next{transition:opacity .25s ease}html[data-bc-panel-settling] .sidebar-next{opacity:0 !important}';document.head.appendChild(s);}})()");

  // 5) 样式看门狗：**WorkBuddy 下停用**。
  //    我们的覆盖层/契约规则全部带 !important，顺序无关；而 WorkBuddy 宿主自己有
  //    一个 keeper（cb-font-size-override 重排器）。两个 keeper 互相"把自己钉到
  //    head 末尾"= 16Hz 的样式重排乒乓（实测 2 秒 66 次变更）→ 预览文字高亮频闪。
  //    停掉我方的，并叫停页面里已装的实例。
  await evaluate(c, "window.__bcKeepStylesLast && window.__bcKeepStylesLast.stop && window.__bcKeepStylesLast.stop(); 'keeper-stopped'");

  // 6) UI（侧栏条目 + 面板 + 舞台；皮肤中心浮窗的端口/中心URL占位符在此注入）
  const ui = await evaluate(c, BACKGROUND_BAR_INJECTION
    .replace(/__BC_GALLERY_PORT__/g, String(galleryPort || 9337))
    .replace(/__BC_GALLERY_TOKEN__/g, JSON.stringify(GALLERY_TOKEN))
    .replace(/__BC_CENTER_URL__/g, JSON.stringify(CENTER_URL || '')));
  log.info('UI ✓（' + JSON.stringify(ui) + '）');

  // 7) 默认壁纸：舞台没有媒体（既无背景图也无视频）时铺上内置壁纸。
  //    用户自己导入的 blob:/file:/用户路径不受影响；「清除背景」后也不会被顶回
  //    （本步只在 applyAll 时跑一次，清除后 entry 仍在、不触发重放）。
  if (fs.existsSync(DEFAULT_WALLPAPER)) {
    const wp = await evaluate(c, `(function(){
var wp = ${JSON.stringify(DEFAULT_WALLPAPER)};
var url = 'file://' + encodeURI(wp.charAt(0) === '/' ? wp : '/' + wp).replace(/#/g, '%23');
var stage = document.getElementById('beauticode-bg-stage');
if (!stage) return 'no-stage';
var bgImg = stage.style.backgroundImage;
// 简写 background:#101114 展开后 backgroundImage 会是 "initial"（真值！）——
// 只排除 'none' 会误判"有媒体"→ 默认壁纸永远不铺、重启后死黑（实测踩过）
var hasMedia = (bgImg && bgImg !== 'none' && bgImg !== 'initial' && bgImg !== 'unset')
  || stage.querySelector('video,img');
if (hasMedia) return 'has-media';
// 用 <img class=bc-media> 而非 background-image —— 磨砂滑杆只作用于媒体元素，
// 默认壁纸若是 background-image，磨砂对它就无物可糊（实测踩过）。
var img = document.createElement('img');
img.className = 'bc-media';
img.setAttribute('data-bc-injected', 'beauticode');
img.src = url;
stage.appendChild(img);
return 'default-applied';
})()`);
    if (wp === 'default-applied') log.info('默认壁纸 ✓（舞台原本无媒体）');
    else log.debug('默认壁纸：' + wp);
  }

  // 8) 记忆恢复：有 state.json 就把壁纸 + 三滑杆恢复到上次退出时的样子
  //    （state.wallpaper=null 且 cleared=true = 用户上次主动清除 → 连默认壁纸也撤掉）
  let liveBeforeRestore = null;
  try {
    const raw = await evaluate(c, 'window.__bcPersistGet ? window.__bcPersistGet() : null');
    liveBeforeRestore = raw ? JSON.parse(raw) : null;
  } catch { /* treat unreadable live state as blank */ }
  if (fs.existsSync(STATE_FILE) && isBlankPersistState(liveBeforeRestore)) {
    try {
      const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      await evaluate(c, 'window.__bcRestoreState && window.__bcRestoreState(' + JSON.stringify(st) + ')');
      log.info(`记忆恢复 ✓（壁纸=${st.wallpaper ? path.basename(st.wallpaper) : '已清除'}，阴影=${st.dim}% 磨砂=${st.blur}% 透明度=${st.alpha}%）`);
    } catch (e) { log.warn('记忆恢复失败：', e.message); }
  }
  return { theme, tokens: (scan.rows || []).length, ui };
}

// ── 清理（注入节点 + 我们的三块样式） ─────────────────────────────────
async function cleanupAll(c) {
  try {
    await evaluate(c, BACKGROUND_BAR_CLEANUP);
    for (const id of APPLY_IDS) {
      await evaluate(c, `(function(){var el=document.getElementById(${JSON.stringify(id)});if(el)el.remove();return 'removed:'+${JSON.stringify(id)};})()`);
    }
    log.info('清理完成');
  } catch (e) { log.warn('清理失败：', e.message); }
}

// ── 守护轮询：entry 丢失 / 主题切换 → 重新应用 ────────────────────────
function startWatcher(c, state) {
  let inflight = false;
  const tick = async () => {
    if (inflight) return; inflight = true;
    try {
      const v = JSON.parse(await evaluate(c, `JSON.stringify({
        entry: !!document.getElementById(${JSON.stringify(BACKGROUND_BAR_STYLE_ID + '-entry')}),
        nav: !!document.querySelector('.conversation-list-tabs'),
        theme: document.documentElement.className,
        panel: !!document.querySelector('.sidebar-next'),
        persist: window.__bcPersistGet ? window.__bcPersistGet() : null
      })`));
      const fpTheme = String(v.theme || '');
      if (v.nav && !v.entry) {
        log.warn('entry 丢失（侧栏重挂），重新应用完整序列');
        await applyAll(c);
      } else if (fpTheme && fpTheme !== state.lastThemeFp) {
        // 旧条件写作 `state.lastThemeFp && ...`（要求上轮非空），于是
        // 「启动期空 → 随后可读」这一次变化被吞掉：契约一旦在启动时被跳过，
        // 就再也不会补上（界面全程实心）。去掉那个前置判断即自愈。
        log.info(`主题（可用/切换 ${state.lastThemeFp ? '切换' : '首次可读'}）→ 重扫注入  fp=${fpTheme.slice(0, 40)}`);
        await applyAll(c);
      }
      state.lastThemeFp = fpTheme;
      // 产物面板开合检测：打开瞬间宿主注入样式潮会引发 ~16Hz 高亮翻转（频闪），
      // 沉降幕先把面板淡出 1.5s（让注入潮在幕后结束），再淡入已稳定的内容。
      const panelOpen = !!v.panel;
      if (panelOpen && !state.panelOpen) {
        log.info('产物面板打开 → 沉降幕 1.5s（压住进入期频闪）');
        await evaluate(c, "(function(){var s=document.getElementById('beauticode-panel-settle');if(!s){s=document.createElement('style');s.id='beauticode-panel-settle';s.textContent='.sidebar-next{transition:opacity .25s ease}html[data-bc-panel-settling] .sidebar-next{opacity:0 !important}';document.head.appendChild(s);}})()");
        await evaluate(c, "document.documentElement.setAttribute('data-bc-panel-settling','1')");
        setTimeout(function () {
          evaluate(c, "document.documentElement.removeAttribute('data-bc-panel-settling')")
            .catch(function (e) { log.debug('沉降幕解除失败：', e.message); });
        }, 1500);
      }
      state.panelOpen = panelOpen;
      // ── 记忆调和：每 tick 核对（幂等）——React 重挂/SPA 导航随时可能把舞台打回默认 ──
      let blankLive = true;
      try {
        const live = v.persist ? JSON.parse(v.persist) : null;
        blankLive = isBlankPersistState(live);
      } catch { blankLive = true; }
      let disk = null;
      try { disk = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* 无存档 */ }
      const hasArchive = !!(disk && (disk.wallpaper || disk.cleared));

      if (hasArchive && disk.wallpaper && blankLive) {
        // 纯兜底：只在页面【真空白】（全 null 且无 blob 标记 = 刚重装/刚刷新）时
        // 恢复存档。非空白 = 用户的当前状态（拖动的滑杆、导入的 blob），绝不碰——
        // 每 tick 无条件 restore 会把用户刚拖的滑杆拽回存档值、把 blob 媒体顶掉
        //（实测：面板参数"隔一会儿变一下"的真凶）
        try {
          await evaluate(c, 'window.__bcRestoreState && window.__bcRestoreState(' + JSON.stringify(disk) + ')');
        } catch (e) { log.debug('记忆调和：', e.message); }
      } else if (hasArchive && disk.cleared && blankLive) {
        // 清除态 + 页面空白（刚重装）→ 恢复清除态（撤掉默认壁纸）
        await evaluate(c, 'window.__bcRestoreState && window.__bcRestoreState(' + JSON.stringify(disk) + ')');
        log.info('记忆调和 ✓（清除态恢复）');
      }

      // 状态写盘：仅在页面状态真实变化（非空白样本）时覆盖存档
      // （空白样本 = 刚重装/刚刷新的初始态，覆盖会把已存壁纸冲掉——实测踩过）
      if (v.persist && v.persist !== state.lastPersist) {
        if (!blankLive) {
          fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
          fs.writeFileSync(STATE_FILE, v.persist);
          log.info('状态已保存 ✓（' + v.persist.slice(0, 110) + '）');
        }
        state.lastPersist = v.persist;
      }
    } catch (e) { log.debug('watcher:', e.message); }
    finally { inflight = false; }
  };
  return setInterval(tick, 1500);
}

// ── 原生文件选择器（DSH「宿主接管文件选择」的移植） ────────────────────
// WorkBuddy renderer 拦程序化 file chooser（Page.fileChooserOpened 未触发），
// 所以面板「选择文件」只发 __bcPickRequest，由守护开系统原生对话框并回填路径。
import { platform } from 'node:os';

async function pickFileNative() {
  // 注意：回调里不能引用外层 await 解构的 stdout（TDZ → ReferenceError 当场崩掉守护，
  // 实测踩过：用户一选完文件守护就死，KeepAlive 拉回来时注入已被清理）。回调参数独立命名。
  if (platform() === 'darwin') {
    return await new Promise((resolve, reject) => {
      execFile('osascript', ['-e',
        'POSIX path of (choose file with prompt "选择背景图片或视频")'],
        (err, so) => err ? reject(err) : resolve(String(so).trim()));
    });
  }
  if (platform() === 'win32') {
    const ps = [
      "$ErrorActionPreference='Stop'",
      // Windows PowerShell 5 writes redirected console output in the active
      // OEM code page by default. Node decodes the pipe as UTF-8, so a media
      // path containing Chinese characters used to arrive as U+FFFD and the
      // renderer later reported MEDIA_ERR_SRC_NOT_SUPPORTED. Pin both output
      // channels to UTF-8 before the dialog prints its selected path.
      "$OutputEncoding=New-Object System.Text.UTF8Encoding($false)",
      "[Console]::OutputEncoding=$OutputEncoding",
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      "[System.Windows.Forms.Application]::EnableVisualStyles()",
      "$owner = New-Object System.Windows.Forms.Form",
      "$owner.Text='beautiCode 文件选择器'",
      "$owner.FormBorderStyle=[System.Windows.Forms.FormBorderStyle]::FixedToolWindow",
      "$owner.ShowInTaskbar=$false",
      "$owner.StartPosition=[System.Windows.Forms.FormStartPosition]::CenterScreen",
      "$owner.Size=[System.Drawing.Size]::new(1,1)",
      "$owner.Opacity=0.01",
      "$owner.TopMost=$true",
      "$d=New-Object System.Windows.Forms.OpenFileDialog",
      "$d.Filter='媒体|*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp;*.avif;*.mp4;*.mov;*.webm;*.m4v'",
      "$d.Multiselect=$false",
      "$d.CheckFileExists=$true",
      "$d.RestoreDirectory=$true",
      "$d.Title='选择背景图片或视频'",
      "try { [void]$owner.Show(); [void]$owner.Hide(); [void]$owner.Show(); [void]$owner.Activate(); [void]$owner.BringToFront(); [System.Windows.Forms.Application]::DoEvents(); $r=$d.ShowDialog($owner); if($r -eq [System.Windows.Forms.DialogResult]::OK){ [Console]::WriteLine($d.FileName) } } finally { $d.Dispose(); $owner.Close(); $owner.Dispose() }",
    ].join('; ');
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    const out = await new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, maxBuffer: 1 << 20 },
        (err, so) => err ? reject(err) : resolve(String(so).trim()));
    });
    if (!out) throw new Error('cancel');
    return out;
  }
  // Linux：zenity 优先，kdialog 回退（KDE 桌面常无 zenity）
  const out = await new Promise((resolve, reject) => {
    execFile('zenity', ['--file-selection', '--title', '选择背景图片或视频'],
      (err, so) => {
        if (!err) return resolve(String(so).trim());
        execFile('kdialog', ['--getopenfilename', '.', 'image/* video/*',
          '::选择背景图片或视频'], (e2, s2) => e2 ? reject(e2) : resolve(String(s2).trim()));
      });
  });
  if (!out) throw new Error('cancel');
  return out;
}

/** 专用快轮询（150ms）：面板「选择文件」请求 → 原生选择器 → 回填路径。
 *  之前 600ms 的轮询延迟是"开选择器卡顿感"的主要可去除成分（实测 osascript
 *  本身仅 ~20ms；对话框首次初始化是系统成本，无法消除，但即时反馈可掩盖）。 */
function startPickWatcher(c) {
  let busy = false;
  return setInterval(async () => {
    if (busy) return; busy = true;
    try {
      const want = await evaluate(c, 'window.__bcPickRequest || 0');
      if (!want) return;
      await evaluate(c, 'window.__bcPickRequest = 0');
      log.info('面板请求文件选择器 → 打开系统对话框');
      let picked = '';
      try { picked = await pickFileNative(); } catch { picked = ''; }
      if (!picked) {
        await evaluate(c, 'window.__bcBackgroundMsg && window.__bcBackgroundMsg("已取消选择。")');
        return;
      }
      log.info('已选择：' + picked.slice(-60));
      // DSH/Codex 回落路径：不走 file://（视频/权限不可靠），
      // 用 DOM.setFileInputFiles 把真实 File 塞进隐藏 input，再派发 change，
      // 页面 applyBlob 走 blob: URL —— 与路径编码、TCC、CSP 全部解耦。
      // 真实路径先行传递：payload 的 applyBlob 读它记入持久状态（媒体显示仍走
      // blob URL 不变）——否则路径在 setFileInputFiles→blob 链路中丢失，重启无法恢复
      await evaluate(c, 'window.__bcPendingPickPath = ' + JSON.stringify(picked));
      await c.send('DOM.enable');
      const doc = await c.send('DOM.getDocument', { depth: 1 });
      const q = await c.send('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: '#beauticode-workbuddy-bg-panel [data-id="fileInput"]',
      });
      if (!q.result?.nodeId && !q.nodeId) throw new Error('找不到隐藏的文件输入框');
      const nodeId = q.result?.nodeId || q.nodeId;
      await c.send('DOM.setFileInputFiles', { files: [picked], nodeId });
      await evaluate(c,
        'document.querySelector(\'#beauticode-workbuddy-bg-panel [data-id="fileInput"]\')' +
        '.dispatchEvent(new Event("change", { bubbles: true }));');
      log.info('已回填并触发导入');
    } catch (e) { log.debug('pick watcher:', e.message); }
    finally { busy = false; }
  }, 150);
}

// ── 单次连接生命周期 ──────────────────────────────────────────────────
async function session() {
  const targets = await fetchTargets(PORT);
  const page = pickWorkBuddyTarget(targets);
  if (!page) throw new Error('no WorkBuddy renderer page target');
  const wsUrl = assertLoopbackDebuggerUrl(page.webSocketDebuggerUrl, PORT);
  log.info(`target ${page.id}  url=${fp(page.url)}`);
  const c = await openWs(wsUrl);

  if (args.clean) { await cleanupAll(c); c.close(); process.exit(0); }

  const state = { lastThemeFp: '', panelOpen: false };
  galleryConn = c;
  await startGalleryServer(async (file) => {
    await evaluate(c, 'window.__bcApplyBackgroundPath && window.__bcApplyBackgroundPath(' + JSON.stringify(file) + ')');
  });
  await applyAll(c);

  if (args.once) { c.close(); process.exit(0); }

  c.onEvent((m) => {
    if (m.method === 'Page.loadEventFired') {
      log.info('页面重载 → 重新应用');
      applyAll(c).catch((e) => log.warn('重应用失败：', e.message));
    }
  });
  const poll = startWatcher(c, state);
  const pickPoll = startPickWatcher(c);
  activeSession = { c, poll, pickPoll };
  log.info('守护运行中（1.5s 轮询 + 150ms 取件轮询 + 断线重连）；Ctrl+C 清理并退出');

  await new Promise((resolve, reject) => {
    c.ws.addEventListener('close', () => reject(Object.assign(new Error('ws-closed'), { code: 'WS_CLOSED' })));
  });
}

let activeSession = { c: null, poll: null, pickPoll: null };
let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(sig + ' → 清理并退出');
  clearInterval(activeSession.poll);
  clearInterval(activeSession.pickPoll);
  if (activeSession.c) await cleanupAll(activeSession.c).catch(() => {});
  try { activeSession.c?.close(); } catch {}
  try { galleryServer?.close(); } catch {}
  process.exit(0);
}

async function runWatchdog() {
  if (args.once || args.clean) {
    throw new Error('--watchdog 不能与 --once 或 --clean 同时使用');
  }
  let child = null;
  let stopping = false;
  const start = () => {
    if (stopping) return;
    const childArgs = process.argv.slice(2).filter((a) => a !== '--watchdog');
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...childArgs], {
      stdio: 'inherit',
      env: process.env,
      windowsHide: true,
    });
    child.on('exit', (code, signal) => {
      if (stopping) process.exit(code ?? 0);
      log.warn(`runner 退出（${code ?? signal}），3s 后拉起`);
      setTimeout(start, 3000);
    });
  };
  const stop = () => {
    stopping = true;
    if (child?.pid) {
      try { process.kill(child.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    setTimeout(() => process.exit(0), 800);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  start();
  await new Promise(() => {});
}

async function main() {
  if (args.watchdog) {
    await runWatchdog();
    return;
  }
  process.on('SIGINT', () => { shutdown('SIGINT'); });
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  if (!args.clean) {
    try {
      const ensured = await ensureWorkBuddyCdp({
        preferredPort: PORT,
        launch: !args.noLaunch,
        launchIfMissing: false,
        restartIfBlind: !args.noLaunch,
        repairWindowMs: 10_000,
        timeoutMs: args.once ? 15_000 : 40_000,
        log,
      });
      PORT = ensured.port;
      if (ensured.launched || ensured.restarted) {
        log.info(`WorkBuddy CDP 已就绪：127.0.0.1:${PORT}${ensured.restarted ? '（已重启）' : '（已启动）'}`);
      }
    } catch (e) {
      if (args.once || args.noLaunch) { log.error('fatal: ' + e.message); process.exit(1); }
      log.warn('启动检测暂未就绪：' + e.message.slice(0, 160) + ' —— 3s 后重试');
    }
  }
  for (;;) {
    try {
      log.info(`连接 http://127.0.0.1:${PORT} …`);
      await session();
    } catch (e) {
      if (args.once) { log.error('fatal: ' + e.message); process.exit(1); }
      log.warn('连接断开（' + e.message.slice(0, 80) + '），3s 后重试');
      if (!args.noLaunch) {
        try {
          const ensured = await ensureWorkBuddyCdp({
            preferredPort: PORT,
            launch: true,
            launchIfMissing: false,
            restartIfBlind: true,
            repairWindowMs: 10_000,
            timeoutMs: 20_000,
            log,
          });
          PORT = ensured.port;
        } catch (ensureErr) {
          log.warn('WorkBuddy 尚未恢复：' + ensureErr.message.slice(0, 120));
        }
      }
    }
    if (args.once) process.exit(0);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
main().catch((e) => { log.error('fatal: ' + (e.stack || e.message)); process.exit(1); });
