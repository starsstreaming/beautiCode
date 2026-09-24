#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.avif': 'image/avif', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.m4v': 'video/mp4',
});
const VIDEO = new Set(['.mp4', '.mov', '.webm', '.m4v']);

function parseArgs(argv) {
  const out = { host: '', once: false, clean: false, verbose: false, watchdog: false, noRepair: false, pidFile: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--host') out.host = String(argv[++i] || '').toLowerCase();
    else if (arg.startsWith('--host=')) out.host = arg.slice(7).toLowerCase();
    else if (arg === '--once') out.once = true;
    else if (arg === '--clean') out.clean = true;
    else if (arg === '--verbose' || arg === '-v') out.verbose = true;
    else if (arg === '--watchdog') out.watchdog = true;
    else if (arg === '--no-repair') out.noRepair = true;
    else if (arg === '--pid-file') out.pidFile = String(argv[++i] || '');
  }
  if (out.host !== 'cursor' && out.host !== 'doubao') {
    throw new Error('用法：node desktop-cdp-runner.mjs --host cursor|doubao [--once|--clean|--watchdog|--no-repair]');
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.watchdog && (args.once || args.clean)) {
  throw new Error('--watchdog 不能与 --once 或 --clean 同时使用。');
}

if (args.watchdog) {
  if (args.pidFile) {
    fs.mkdirSync(path.dirname(args.pidFile), { recursive: true });
    fs.writeFileSync(args.pidFile, String(process.pid), 'utf8');
  }
  const childArgs = process.argv.slice(2).filter((arg) => arg !== '--watchdog');
  const stopSignals = new Set(['SIGINT', 'SIGTERM']);
  let stopping = false;
  let child = null;
  let restartAttempt = 0;
  const start = () => {
    if (stopping) return;
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...childArgs], {
      stdio: 'inherit', windowsHide: true,
    });
    let ended = false;
    const restart = () => {
      if (ended) return;
      ended = true;
      child = null;
      if (stopping) return;
      // 指数退避（1s → 2s → 4s…上限 60s）：PowerShell 被安全策略拦截或
      // 脚本持续崩溃时，1s 固定重启会无限刷日志并持续占用 CPU。
      const delay = Math.min(1000 * 2 ** restartAttempt, 60_000);
      restartAttempt += 1;
      if (restartAttempt === 5) {
        console.error('[watchdog] 子进程连续崩溃，已进入指数退避；若持续失败请检查 PowerShell 是否被安全策略拦截。');
      }
      setTimeout(start, delay);
    };
    child.once('exit', restart);
    child.once('error', restart);
    // 子进程稳定存活 30s 后重置退避计数，正常偶发崩溃不受长期惩罚
    setTimeout(() => { if (!ended) restartAttempt = 0; }, 30_000).unref();
  };
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  for (const signal of stopSignals) process.once(signal, () => {
    stopping = true;
    child?.kill();
    finish();
  });
  start();
  await finished;
  if (args.pidFile) { try { fs.unlinkSync(args.pidFile); } catch {} }
  process.exit(0);
}

async function loadModule(packageName, fallback) {
  try { return await import(packageName); } catch { return await import(fallback); }
}

const shared = await loadModule('@beauticode/adapter-desktop-cdp', '../packages/adapter-desktop-cdp/dist/index.js');
const core = await loadModule('@beauticode/core', '../packages/core/dist/index.js');
const adapter = args.host === 'cursor'
  ? await loadModule('@beauticode/adapter-cursor', '../packages/adapter-cursor/dist/index.js')
  : await loadModule('@beauticode/adapter-doubao', '../packages/adapter-doubao/dist/index.js');
const spec = args.host === 'cursor' ? adapter.CURSOR_CDP_SPEC : adapter.DOUBAO_CDP_SPEC;
const buildInjection = args.host === 'cursor'
  ? adapter.buildCursorBackgroundInjection
  : adapter.buildDoubaoBackgroundInjection;
const buildCleanup = args.host === 'cursor'
  ? adapter.buildCursorBackgroundCleanup
  : adapter.buildDoubaoBackgroundCleanup;

const ts = () => new Date().toISOString().slice(11, 23);
const log = {
  info: (...parts) => process.stderr.write(`[${ts()}] [${args.host}] ${parts.join(' ')}\n`),
  warn: (...parts) => process.stderr.write(`[${ts()}] [${args.host}:warn] ${parts.join(' ')}\n`),
  debug: (...parts) => { if (args.verbose) process.stderr.write(`[${ts()}] [${args.host}:debug] ${parts.join(' ')}\n`); },
};

const dataRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'beauticode', 'hosts', args.host);
const stateFile = path.join(dataRoot, 'state.json');
fs.mkdirSync(dataRoot, { recursive: true });

function readState() {
  try {
    const buf = fs.readFileSync(stateFile);
    if (buf.length > 256 * 1024) return null;
    const value = JSON.parse(buf.toString('utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
}

function writeState(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 256 * 1024) return;
  JSON.parse(raw);
  const tmp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, raw, 'utf8');
  fs.renameSync(tmp, stateFile);
}

function openWs(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const handlers = [];
    const SEND_TIMEOUT_MS = 15_000;
    // 每个请求带超时并在到时移出 pending：没有超时的话，宿主半开连接
    // 会让 Runtime.evaluate 永不 settle，busy 卡死、tick 循环静默死亡。
    const send = (method, params = {}, timeoutMs = SEND_TIMEOUT_MS) => new Promise((res, rej) => {
      const requestId = ++id;
      const timer = setTimeout(() => {
        if (pending.delete(requestId)) rej(new Error(`CDP ${method} 超时（${timeoutMs}ms）。`));
      }, timeoutMs);
      pending.set(requestId, {
        res: (value) => { clearTimeout(timer); res(value); },
        rej: (error) => { clearTimeout(timer); rej(error); },
      });
      ws.send(JSON.stringify({ id: requestId, method, params }));
    });
    const failAllPending = (error) => {
      for (const task of pending.values()) task.rej(error);
      pending.clear();
    };
    ws.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id && pending.has(message.id)) {
        const task = pending.get(message.id);
        pending.delete(message.id);
        message.error ? task.rej(new Error(message.error.message || 'CDP error')) : task.res(message.result);
      } else if (message.method) {
        for (const handler of handlers) handler(message);
      }
    });
    ws.addEventListener('open', () => resolve({
      ws, send,
      onEvent: (handler) => handlers.push(handler),
      close: () => ws.close(),
    }));
    ws.addEventListener('error', () => {
      failAllPending(new Error('CDP WebSocket 连接失败。'));
      reject(new Error('CDP WebSocket connection failed.'));
    });
    // 断开（含半开恢复）时统一定损：拒绝并清空全部挂起请求，防止
    // Promise 永久悬挂与 pending Map 无限增长。
    ws.addEventListener('close', () => failAllPending(new Error('CDP 连接已关闭。')));
  });
}

async function evaluate(connection, expression) {
  const reply = await connection.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (reply.exceptionDetails) {
    throw new Error((reply.exceptionDetails.exception?.description || reply.exceptionDetails.text || 'page exception').slice(0, 240));
  }
  return reply.result?.value;
}

async function pickFileNative() {
  if (process.platform !== 'win32') throw new Error('本轮仅支持 Windows 原生文件选择器。');
  const ps = [
    "$ErrorActionPreference='Stop'",
    "$OutputEncoding=New-Object System.Text.UTF8Encoding($false)",
    '[Console]::OutputEncoding=$OutputEncoding',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '[System.Windows.Forms.Application]::EnableVisualStyles()',
    '$owner=New-Object System.Windows.Forms.Form',
    "$owner.Text='beautiCode 文件选择器'",
    '$owner.FormBorderStyle=[System.Windows.Forms.FormBorderStyle]::FixedToolWindow',
    '$owner.ShowInTaskbar=$false',
    '$owner.StartPosition=[System.Windows.Forms.FormStartPosition]::CenterScreen',
    '$owner.Size=[System.Drawing.Size]::new(1,1)',
    '$owner.Opacity=0.01',
    '$owner.TopMost=$true',
    '$dialog=New-Object System.Windows.Forms.OpenFileDialog',
    "$dialog.Filter='媒体|*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp;*.avif;*.mp4;*.mov;*.webm;*.m4v'",
    '$dialog.Multiselect=$false', '$dialog.CheckFileExists=$true', '$dialog.RestoreDirectory=$true',
    "$dialog.Title='选择背景图片或视频'",
    'try{[void]$owner.Show();[void]$owner.Activate();[void]$owner.BringToFront();[System.Windows.Forms.Application]::DoEvents();$result=$dialog.ShowDialog($owner);if($result -eq [System.Windows.Forms.DialogResult]::OK){[Console]::WriteLine($dialog.FileName)}}finally{$dialog.Dispose();$owner.Close();$owner.Dispose()}',
  ].join(';');
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  return await new Promise((resolve, reject) => execFile(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true, maxBuffer: 1024 * 1024 },
    (error, stdout) => error ? reject(error) : resolve(String(stdout).trim()),
  ));
}

function mediaIdentity(info) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

function assertStableMedia(file, expectedIdentity) {
  const logical = path.resolve(String(file || ''));
  const logicalInfo = fs.lstatSync(logical);
  if (logicalInfo.isSymbolicLink()) throw new Error('媒体路径不能是符号链接。');
  const resolved = fs.realpathSync.native(logical);
  const info = fs.lstatSync(resolved);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('媒体路径不是普通文件。');
  if (expectedIdentity && mediaIdentity(info) !== expectedIdentity) {
    throw new Error('媒体文件在应用前发生变化。');
  }
  return { path: resolved, identity: mediaIdentity(info) };
}

async function validateMedia(file) {
  const logical = path.resolve(String(file || ''));
  const ext = path.extname(logical).toLowerCase();
  if (!MEDIA[ext]) throw new Error('不支持的媒体格式。');
  const first = assertStableMedia(logical);
  // The shared validator performs magic/container checks and walks every path
  // segment for symlinks/reparse points. Keep the identity check here as well:
  // the renderer receives a path, so it must not race a replacement file.
  const checked = VIDEO.has(ext)
    ? await core.validateVideoFile(first.path, { mode: 'fast' })
    : await core.validateImageFile(first.path, { mode: 'fast' });
  const stable = assertStableMedia(checked.filePath, first.identity);
  return { path: stable.path, identity: stable.identity };
}

async function setFileInput(connection, file, meta) {
  const checked = await validateMedia(file);
  const resolved = checked.path;
  assertStableMedia(resolved, checked.identity);
  const requestId = meta.requestId || `runner-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const prepared = { ...meta, path: resolved, requestId };
  await evaluate(connection, `window.__bcDesktopPrepareFile(${JSON.stringify(prepared)})`);
  await connection.send('DOM.enable');
  const document = await connection.send('DOM.getDocument', { depth: 1 });
  const selector = `#beauticode-${args.host}-background-panel [data-id="fileInput"]`;
  const query = await connection.send('DOM.querySelector', {
    nodeId: document.root.nodeId, selector,
  });
  const nodeId = query.nodeId || query.result?.nodeId;
  if (!nodeId) throw new Error('找不到背景文件输入框。');
  await connection.send('DOM.setFileInputFiles', { files: [resolved], nodeId });
  assertStableMedia(resolved, checked.identity);
  await evaluate(connection, `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change',{bubbles:true}))`);
  if (meta.mode === 'gallery' || meta.mode === 'theme' || meta.mode === 'restore') {
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) {
      const result = await evaluate(connection, `window.__bcDesktopApplyResult && window.__bcDesktopApplyResult[${JSON.stringify(requestId)}]`);
      if (result?.status === 'ok') return result;
      if (result?.status === 'error') throw new Error(result.error || '背景媒体加载失败。');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('等待背景媒体加载或主题保存超时。');
  }
}

function openExternal(url) {
  if (process.platform !== 'win32') return;
  const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
}

const galleryToken = crypto.randomBytes(20).toString('hex');
const skinRegistry = new Map();
let galleryPort = null;
let galleryServer = null;
let activeConnection = null;

async function buildCatalog() {
  skinRegistry.clear();
  const result = await core.listApprovedSkins();
  for (const skin of result) skinRegistry.set(skin.id, skin);
  return result;
}

function galleryPage() {
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>beautiCode 皮肤中心</title><style>body{margin:0;background:#101114;color:#eee;font:14px system-ui}header{padding:18px 22px;border-bottom:1px solid #333}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;padding:20px}.card{padding:0;overflow:hidden;border:1px solid #444;border-radius:14px;background:#242424;color:inherit;text-align:left}.card img,.card video{display:block;width:100%;aspect-ratio:16/10;object-fit:cover}.card span{display:block;padding:10px}#msg{padding:10px 22px;color:#aaa}</style><header><b>beautiCode 皮肤中心</b><div>${spec.displayName} · 选择后自动保存主题</div></header><div id="msg">正在读取…</div><main id="grid"></main><script>var token=${JSON.stringify(galleryToken)};fetch('/api/catalog?t='+token).then(r=>r.json()).then(d=>{msg.textContent='共 '+d.skins.length+' 款';d.skins.forEach(s=>{var b=document.createElement('button');b.className='card';var m=document.createElement(s.type==='video'?'video':'img');m.src='/media?id='+s.id+'&t='+token;if(s.type==='video'){m.muted=true;m.preload='metadata'}var n=document.createElement('span');n.textContent=s.name;b.append(m,n);b.onclick=()=>{msg.textContent='正在应用「'+s.name+'」…';fetch('/apply',{method:'POST',headers:{'content-type':'application/json','x-beauticode-media-token':token},body:JSON.stringify({id:s.id})}).then(r=>r.json()).then(v=>{msg.textContent=v.ok?'已应用「'+s.name+'」':v.error})};grid.appendChild(b)})})</script></html>`;
}

function isLoopbackHost(value) {
  const host = String(value || '').replace(/^\[/, '').split(/[:\]]/)[0].toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function startGallery() {
  if (galleryServer) return Promise.resolve(galleryPort);
  const handler = async (request, response) => {
    if (!isLoopbackHost(request.headers.host)) { response.writeHead(403).end(); return; }
    const url = new URL(request.url, 'http://127.0.0.1');
    const token = request.headers['x-beauticode-media-token'] || url.searchParams.get('t');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('cache-control', 'no-store');
    if (token !== galleryToken) { response.writeHead(403).end(JSON.stringify({ ok: false, error: 'bad token' })); return; }
    if (url.pathname === '/' || url.pathname === '/beauticode/gallery') {
      response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(galleryPage()); return;
    }
    if (url.pathname === '/api/catalog') {
      try {
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ skins: await buildCatalog(), url: core.SKIN_CENTER_ORIGIN }));
      } catch (error) {
        response.writeHead(502).end(JSON.stringify({ ok: false, skins: [], error: error.message }));
      }
      return;
    }
    const id = String(url.searchParams.get('id') || '');
    if (url.pathname === '/media') {
      const skin = skinRegistry.get(id);
      if (!skin) { response.writeHead(404).end(); return; }
      let download;
      try {
        // 缩略图按皮肤自身类型请求资源（视频皮肤请求 /video 端点）；
        // 旧写法三元两分支同为 'image'，视频皮肤恒拿到图片 MIME。
        download = await core.downloadApprovedAsset(skin, skin.type, { directory: path.join(dataRoot, 'tmp', 'gallery') });
        response.setHeader('content-type', download.contentType || 'application/octet-stream');
        fs.createReadStream(download.filePath).on('close', () => fs.rmSync(download.tempDir, { recursive: true, force: true })).pipe(response);
      } catch (error) {
        response.writeHead(502).end(JSON.stringify({ ok: false, error: error.message }));
      }
      return;
    }
    if (url.pathname === '/apply' && request.method === 'POST') {
      let body = Buffer.alloc(0);
      request.on('data', (part) => { if (body.length < 4096) body = Buffer.concat([body, part]); });
      request.on('end', async () => {
        try {
          const item = skinRegistry.get(String(JSON.parse(body.toString('utf8')).id || ''));
          if (!item || !activeConnection) throw new Error(`${spec.displayName} 守护尚未连接。`);
          const download = await core.downloadApprovedAsset(item, item.type, { directory: path.join(dataRoot, 'tmp', 'gallery') });
          const persistentDir = path.join(dataRoot, 'themes');
          fs.mkdirSync(persistentDir, { recursive: true });
          const persistent = path.join(persistentDir, `${item.sourceSkinId}${path.extname(download.filePath)}`);
          const backup = `${persistent}.previous-${process.pid}-${Date.now()}`;
          let hadPrevious = false;
          let committed = false;
          try {
            if (fs.existsSync(persistent)) { fs.renameSync(persistent, backup); hadPrevious = true; }
            fs.renameSync(download.filePath, persistent);
            await setFileInput(activeConnection, persistent, {
              mode: 'gallery', name: item.name, save: true,
              provenance: { source: item.source, sourceSkinId: item.sourceSkinId, sourceVersion: item.sourceVersion },
            });
            committed = true;
          } catch (error) {
            try { fs.rmSync(persistent, { force: true }); } catch {}
            if (hadPrevious) { try { fs.renameSync(backup, persistent); } catch {} }
            throw error;
          } finally {
            fs.rmSync(download.tempDir, { recursive: true, force: true });
            if (committed || !hadPrevious) fs.rmSync(backup, { force: true });
          }
          response.end(JSON.stringify({ ok: true }));
        } catch (error) { response.writeHead(500).end(JSON.stringify({ ok: false, error: error.message })); }
      });
      return;
    }
    response.writeHead(404).end();
  };
  return new Promise((resolve) => {
    let port = args.host === 'cursor' ? 9381 : 9382;
    const tryPort = () => {
      if (port > 9390) { log.warn('皮肤中心端口耗尽。'); resolve(null); return; }
      const server = createServer(handler);
      server.once('error', (error) => error.code === 'EADDRINUSE' ? (port++, tryPort()) : resolve(null));
      server.listen(port, '127.0.0.1', () => { galleryServer = server; galleryPort = port; resolve(port); });
    };
    tryPort();
  });
}

async function applyRuntime(connection, galleryUrl) {
  const result = await evaluate(connection, buildInjection(galleryUrl));
  if (result === 'no-anchor' || result === 'anchor-text-mismatch') {
    throw new Error(`DOM 兼容检查失败：${result}`);
  }
  if (result === 'ok') {
    const state = readState();
    if (state) await evaluate(connection, `window.__bcDesktopRestoreState(${JSON.stringify(state)})`);
  }
  return result;
}

async function runSession(endpoint) {
  const wsUrl = shared.assertLoopbackDebuggerUrl(endpoint.target.webSocketDebuggerUrl, endpoint.port);
  const connection = await openWs(wsUrl);
  activeConnection = connection;
  await connection.send('Page.enable');
  if (args.clean) {
    await evaluate(connection, buildCleanup());
    connection.close();
    return 'done';
  }
  const port = await startGallery();
  const galleryUrl = port ? `http://127.0.0.1:${port}/beauticode/gallery?t=${galleryToken}` : '';
  try { await applyRuntime(connection, galleryUrl); }
  catch (error) { activeConnection = null; connection.close(); throw error; }
  log.info(`已注入 ${shared.safeTargetLabel(endpoint.target.url)} :${endpoint.port}`);

  let busy = false;
  let busySince = 0;
  let lastPick = 0;
  let lastApply = '';
  let lastSkin = 0;
  let lastDirty = 0;
  const tick = async () => {
    if (busy) {
      // 看门狗：单轮 tick 正常毫秒级完成（所有 CDP 调用已带 15s 超时），
      // busy 持续超过 60s 意味着连接处于异常半开状态，强制断开让
      // 主循环重连自愈，而不是让守护「假活」到进程被手动结束。
      if (Date.now() - busySince > 60_000) {
        log.warn('tick 已停滞超过 60s，强制断开 CDP 连接以自愈。');
        connection.close();
      }
      return;
    }
    busy = true;
    busySince = Date.now();
    try {
      const snapshot = await evaluate(connection, `({pick:window.__bcDesktopPickRequest||0,apply:window.__bcDesktopApplyRequest||null,skin:window.__bcDesktopSkinCenterRequest||0,dirty:window.__bcDesktopPersistDirty||0,entry:!!document.getElementById('beauticode-${args.host}-background-entry'),style:!!document.getElementById('beauticode-${args.host}-background-style'),stage:!!document.getElementById('beauticode-bg-stage'),anchor:!!document.querySelector(${JSON.stringify(spec.anchorSelector)})})`);
      if (!snapshot.anchor) {
        await evaluate(connection, buildCleanup());
        throw new Error('DOM 锚点丢失，已停止注入。');
      }
      if (!snapshot.entry || !snapshot.style || !snapshot.stage) await applyRuntime(connection, galleryUrl);
      if (snapshot.pick && snapshot.pick !== lastPick) {
        lastPick = snapshot.pick;
        await evaluate(connection, 'window.__bcDesktopPickRequest=0');
        let picked = '';
        try { picked = await pickFileNative(); }
        catch (error) {
          // 原生选择器失败不再静默：留下诊断日志并给用户可见提示
          log.warn(`文件选择器无法打开：${error?.message || error}`);
          await evaluate(connection, `window.__bcDesktopMessage(${JSON.stringify('无法打开文件选择器。')})`).catch(() => {});
        }
        if (picked) await setFileInput(connection, picked, { mode: 'import', save: false });
      }
      if (snapshot.apply?.requestId && snapshot.apply.requestId !== lastApply) {
        lastApply = snapshot.apply.requestId;
        await evaluate(connection, 'window.__bcDesktopApplyRequest=null');
        try { await setFileInput(connection, snapshot.apply.path, snapshot.apply); }
        catch (error) {
          // 区分「原文件不可用」与「格式不支持」，避免一律谎报文件丢失；
          // 真实原因始终进日志供排查。
          const message = String(error?.message || error || '');
          log.warn(`背景应用失败：${message}`);
          const text = message.includes('格式不支持') || message.includes('不支持的媒体')
            ? spec.strings.unsupportedFile
            : spec.strings.missingFile;
          await evaluate(connection, `window.__bcDesktopMessage(${JSON.stringify(text)})`);
        }
      }
      if (snapshot.skin && snapshot.skin !== lastSkin) {
        lastSkin = snapshot.skin;
        await evaluate(connection, 'window.__bcDesktopSkinCenterRequest=0');
        if (galleryUrl) openExternal(galleryUrl);
      }
      if (snapshot.dirty !== lastDirty) {
        lastDirty = snapshot.dirty;
        const raw = await evaluate(connection, 'window.__bcDesktopPersistGet&&window.__bcDesktopPersistGet()');
        if (raw) writeState(raw);
      }
    } finally { busy = false; }
  };
  await tick();
  if (args.once) { connection.close(); return 'done'; }
  const interval = setInterval(() => tick().catch((error) => log.debug(error.message)), 180);
  return await new Promise((resolve) => {
    connection.ws.addEventListener('close', () => { clearInterval(interval); activeConnection = null; resolve('closed'); }, { once: true });
  });
}

const monitor = args.noRepair ? { close() {} } : shared.startDesktopStartupRepairMonitor(spec, log);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  stopping = true;
  monitor.close();
  galleryServer?.close();
  activeConnection?.close();
});

do {
  const endpoint = await shared.discoverDesktopCdp(spec);
  if (endpoint) {
    try {
      const result = await runSession(endpoint);
      if (result === 'done') break;
    } catch (error) {
      log.warn(error.message);
      if (args.once || args.clean) { process.exitCode = 1; break; }
    }
  } else if (args.once || args.clean) {
    log.warn(`${spec.displayName} 没有可用的受控 CDP 页面。`);
    process.exitCode = 1;
    break;
  }
  if (!stopping) await new Promise((resolve) => setTimeout(resolve, 700));
} while (!stopping);

monitor.close();
galleryServer?.close();
