# WorkBuddy Boot and Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** WorkBuddy 首次无媒体启动能可靠显示默认壁纸，登录启动后的守护日志可用且有界，并定位中文主题名乱码发生在哪个边界。

**Architecture:** 页面 UI 挂载时用同一个舞台创建函数预建舞台，runner 根据清除态/已保存媒体决定是否铺默认壁纸。runner 自行持久化安全日志，launcher 只记录 Node 启动前的失败；皮肤名比较使用长度与 UTF-8 哈希，不写原文。

**Tech Stack:** Node.js >=22、ESM、TypeScript、现有 WorkBuddy CDP runner、Windows PowerShell launcher、node:test；不新增 DOM 库或运行时依赖。

**Spec:** docs/superpowers/specs/2026-09-24-workbuddy-boot-observability-design.md

## Global Constraints

- 不改 WorkBuddy 原图标、CDP 10 秒修复窗口、主题数据格式、用户媒体或其它宿主行为。
- cleared=true 始终优先；失败不删除已保存主题；重复挂载只留一座舞台和一条入口。
- 日志必须有界，不写完整 URL、媒体路径、主题名、账号信息；日志写失败不能让守护崩溃。
- 中文名先查明边界，不自动重命名旧主题或猜测性转码。
- 工作树已有其它未提交改动。只暂存本任务新增文件及确认属于本任务的 hunk，禁止 git add -A。
- 真机验收不得自动关闭用户正在使用的 WorkBuddy；关闭/重开步骤由用户配合。

## Review Focus

1. UI 已挂载但无舞台且无保存状态：默认壁纸出现；Task 1 测试。
2. cleared=true 与既有媒体同时出现：清除优先且重连不闪默认壁纸；Task 1 测试。
3. 登录 VBS 启动时 PowerShell 不转发输出：runner 文件日志仍有启动与连接记录；Task 2 测试。
4. 日志过大或包含主题名/本地路径：轮转且持久文件不泄露；Task 2 测试。
5. 中文名称在目录/页面/状态边界变化：只记录不同阶段的哈希与长度、不改旧值；Task 3 测试。

---

### Task 1: 舞台初始化和默认壁纸决策

**Files:** Create packages/adapter-workbuddy/src/background-stage.ts、packages/adapter-workbuddy/test/background-stage.test.js、scripts/wb-startup-media.mjs、packages/adapter-workbuddy/test/startup-media.test.js；Modify packages/adapter-workbuddy/src/background-bar.ts、scripts/wb-cdp-runner.mjs。

**Interfaces:** Produces ensureBackgroundStage(document) 可在页面注入代码与测试中共用；shouldApplyDefaultWallpaper({cleared,wallpaper,hasMedia}) 返回布尔值。

- [ ] **Step 1: 写失败测试。** 用最小 document fake 调用真实 ensureBackgroundStage，验证创建、第二次复用、旧舞台脱离后重建；对默认媒体决策使用手算字面预期。

~~~js
function fakeDocument() {
  const doc = {
    body: {},
    insertions: 0,
    stage: null,
    getElementById(id) { return this.stage?.id === id ? this.stage : null; },
    createElement() {
      return { id: "", isConnected: false, style: {}, setAttribute() {} };
    },
  };
  doc.documentElement = {
    insertBefore(node) {
      node.isConnected = true;
      doc.stage = node;
      doc.insertions++;
    },
  };
  return doc;
}
test("stage is created once before any import", () => {
  const doc = fakeDocument();
  const first = ensureBackgroundStage(doc);
  assert.equal(first.id, "beauticode-bg-stage");
  assert.equal(first.isConnected, true);
  assert.equal(ensureBackgroundStage(doc), first);
  assert.equal(doc.insertions, 1);
});
test("cleared state never receives default wallpaper", () => {
  assert.equal(shouldApplyDefaultWallpaper({
    cleared: true, wallpaper: null, hasMedia: false,
  }), false);
  assert.equal(shouldApplyDefaultWallpaper({
    cleared: false, wallpaper: null, hasMedia: false,
  }), true);
  assert.equal(shouldApplyDefaultWallpaper({
    cleared: false, wallpaper: "C:\\saved.jpg", hasMedia: false,
  }), false);
});
~~~

- [ ] **Step 2: 运行红测。** Run: npm run build -w @beauticode/adapter-workbuddy && node --test packages/adapter-workbuddy/test/background-stage.test.js packages/adapter-workbuddy/test/startup-media.test.js。Expected: 新模块导入不存在。
- [ ] **Step 3: 最小实现。** 把现有 stageEl DOM 构造提取为不依赖闭包的 ensureBackgroundStage，注入 payload 使用同一个函数源码并在 UI 挂载完成时调用一次；重挂时继续实时查找舞台。runner 在默认壁纸之前读取持久清除态和主题路径，有显式清除或已保存媒体就跳过默认图，随后按既有事务恢复路径应用媒体。不要在 runner 复制舞台 DOM 构造。

~~~ts
export function ensureBackgroundStage(doc: Document): HTMLElement {
  let stage = doc.getElementById("beauticode-bg-stage");
  if (stage?.isConnected) return stage;
  stage = doc.createElement("div");
  stage.id = "beauticode-bg-stage";
  stage.setAttribute("data-bc-injected", "beauticode-workbuddy-bg");
  stage.style.cssText = "position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none;background-color:#101114";
  doc.documentElement.insertBefore(stage, doc.body);
  return stage;
}
export function shouldApplyDefaultWallpaper(state: {
  cleared: boolean; wallpaper: string | null; hasMedia: boolean;
}): boolean {
  return !state.cleared && !state.wallpaper && !state.hasMedia;
}
~~~

- [ ] **Step 4: 运行绿测与现有合约测试。** Run: npm run test -w @beauticode/adapter-workbuddy。用真实 WorkBuddy 无状态、已有图片、已有视频、清除态、重挂各检查一次舞台和媒体数量；这些为 Windows CDP 验收，不替代自动化红绿测试。
- [ ] **Step 5: scoped commit。** 检查 git diff --check，仅提交本任务的新增文件及 background-bar.ts/wb-cdp-runner.mjs hunk，提交 fix: initialize WorkBuddy background stage before fallback。

### Task 2: runner 自写安全日志和 launcher 早期错误

**Files:** Create scripts/wb-runner-log.mjs、packages/adapter-workbuddy/test/wb-runner-log.test.js；Modify scripts/wb-cdp-runner.mjs、scripts/wb-setup.mjs、scripts/portable-runtime.mjs、packages/adapter-workbuddy/test/setup-scripts.test.js。

**Interfaces:** Produces createWorkBuddyLogger({file,maxBytes,stderr})，输出 info/warn/error/debug 方法；renderRuntimeLauncherPs1({host,startupLogPath}) 仅在 WorkBuddy 传入 startupLogPath 时记录 Node 启动前错误。

- [ ] **Step 1: 写失败测试。** 临时目录验证无需 PowerShell 重定向即可写入日志；触发小尺寸轮转，文件总量有界；包含路径和中文名称的消息落盘时被屏蔽；launcher 的错误码由运行时渲染参数传递，其他宿主渲染保持不变。

~~~js
test("runner writes a bounded log without inherited stdio", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bc-wb-log-"));
  try {
    const file = path.join(dir, "runner.log");
    const log = createWorkBuddyLogger({ file, maxBytes: 256, stderr: () => {} });
    log.info("started");
    log.info("selected C:\\Users\\me\\private.jpg");
    for (let n = 0; n < 20; n++) log.info("tick-" + n);
    const current = await fs.readFile(file, "utf8");
    assert.match(current, /tick-19/);
    assert.doesNotMatch(current, /private\.jpg/);
    assert.ok((await fs.stat(file)).size <= 256);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
~~~

- [ ] **Step 2: 运行红测。** Run: node --test packages/adapter-workbuddy/test/wb-runner-log.test.js。Expected: createWorkBuddyLogger 不存在。
- [ ] **Step 3: 最小实现。** 日志模块将 ISO 时间、级别和脱敏消息同步追加到 LocalAppData 的 wb-runner.log；超过 1 MiB 时保留一份 previous，再写当前文件。runner 原有 44 个 log 调用中，移除皮肤名、文件选择路径和持久状态片段等敏感内容；错误文本经路径/URL 脱敏后持久化。写文件失败仅在前台 stderr 报告一次。PowerShell launcher 的 WorkBuddy 专属可选参数记录指针、Node 版本和入口缺失等安全错误码；wb-setup status 只读展示日志是否存在、可写性与最后更新时间，不从空文件推断守护已停。

~~~js
function redactWorkBuddyLog(message) {
  return message
    .replace(/[A-Za-z]:\\[^\s)]+/g, "[path]")
    .replace(/(?:file|https?):\/\/[^\s)]+/g, "[url]");
}
function rotateIfNeeded(file, maxBytes, nextBytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file) || fs.statSync(file).size + nextBytes <= maxBytes) return;
  const previous = file + ".previous";
  fs.rmSync(previous, { force: true });
  fs.renameSync(file, previous);
}
export function createWorkBuddyLogger({ file, maxBytes = 1024 * 1024, stderr }) {
  const write = (level, message) => {
    const safe = redactWorkBuddyLog(String(message)).slice(
      0, Math.max(0, Math.floor((maxBytes - 64) / 4)),
    );
    const line = new Date().toISOString() + " [" + level + "] " + safe + "\n";
    try {
      rotateIfNeeded(file, maxBytes, Buffer.byteLength(line));
      fs.appendFileSync(file, line);
    } catch {
      stderr("workbuddy log unavailable\n");
    }
  };
  return {
    info: (...parts) => write("info", parts.join(" ")),
    warn: (...parts) => write("warn", parts.join(" ")),
    error: (...parts) => write("error", parts.join(" ")),
    debug: (...parts) => write("debug", parts.join(" ")),
  };
}
~~~

- [ ] **Step 4: 运行绿测及 Windows 启动链路测试。** Run: node --test packages/adapter-workbuddy/test/wb-runner-log.test.js packages/adapter-workbuddy/test/setup-scripts.test.js。再分别经安装即时启动和登录 VBS 启动 runner，验证日志含启动/连接或明确早期错误码，且无需继承 PowerShell 标准流。
- [ ] **Step 5: scoped commit。** 只暂存本任务文件与 hunk，提交 fix: persist bounded WorkBuddy guardian logs directly。

### Task 3: 中文皮肤名边界诊断

**Files:** Create scripts/wb-theme-name-diagnostic.mjs、packages/adapter-workbuddy/test/wb-theme-name-diagnostic.test.js；Modify scripts/wb-cdp-runner.mjs。

**Interfaces:** Produces fingerprintThemeName(name,key) 和 compareThemeNameStages({catalog,renderer,persisted},key)；key 为每次 runner 启动生成的随机密钥，返回阶段、UTF-8 字节长度与进程内 HMAC 相等性，不返回原文。

- [ ] **Step 1: 写失败测试。** 固定中文样例通过 JSON 往返保持相等；人为替换为乱码时，诊断准确指出第一次变化发生在页面或落盘边界；输出不得包含原名称。

~~~js
test("name diagnostic detects first changed boundary without leaking names", () => {
  const result = compareThemeNameStages({
    catalog: "室内", renderer: "室内", persisted: "瀹ゅ唴",
  }, Buffer.alloc(32, 7));
  assert.equal(result.firstMismatch, "persisted");
  assert.equal(JSON.stringify(result).includes("室内"), false);
  assert.equal(JSON.stringify(result).includes("瀹"), false);
});
~~~

- [ ] **Step 2: 运行红测。** Run: node --test packages/adapter-workbuddy/test/wb-theme-name-diagnostic.test.js。Expected: 诊断模块不存在。
- [ ] **Step 3: 最小实现。** 从 node:crypto 导入 createHmac/randomBytes，runner 启动时生成一次 randomBytes(32)。皮肤中心应用时，在 catalog name、CDP 页面确认后的 active theme name、下一次 state.json 持久值三处计算 UTF-8 长度和进程内临时密钥的 HMAC-SHA-256；只在不一致时输出阶段码和截短 HMAC，不写原名称或可跨运行关联的原始 SHA。旧状态只读，既不自动改名也不重新下载。由于来源站点响应可能已乱码，若 catalog 阶段异常，记录为上游未定位，不宣称页面编码修复。

~~~js
export function fingerprintThemeName(name, key) {
  const bytes = Buffer.from(String(name), "utf8");
  return {
    byteLength: bytes.length,
    digest: createHmac("sha256", key).update(bytes).digest("hex").slice(0, 16),
  };
}
export function compareThemeNameStages({ catalog, renderer, persisted }, key) {
  if (catalog == null || renderer == null || persisted == null) {
    return { firstMismatch: "unavailable", lengths: [], hashes: [] };
  }
  const first = fingerprintThemeName(catalog, key);
  const second = fingerprintThemeName(renderer, key);
  const third = fingerprintThemeName(persisted, key);
  return {
    firstMismatch: first.digest !== second.digest ? "renderer"
      : second.digest !== third.digest ? "persisted" : null,
    lengths: [first.byteLength, second.byteLength, third.byteLength],
    hashes: [first.digest, second.digest, third.digest],
  };
}
~~~

- [ ] **Step 4: 运行绿测。** Run: node --test packages/adapter-workbuddy/test/wb-theme-name-diagnostic.test.js。真机仅在用户主动选择皮肤时采样，不更改主题名；核对日志不含原文、路径。
- [ ] **Step 5: scoped commit。** 提交 test: locate WorkBuddy theme name corruption without rewriting data。

### Task 4: 打包与回归验收

**Files:** Modify scripts/pack-desktop-aggregate.mjs、packages/beauticode-desktop/README.md、docs/beauticode-desktop-test-guide.md、packages/beauticode-desktop/test/pack.test.mjs。

**Interfaces:** Consumes Tasks 1–3 新模块。Produces 自包含 WorkBuddy 运行时，不改 Cursor/豆包/Codex/DSH 运行时。

- [ ] **Step 1: 写失败打包测试。** 打包后检查新 stage 的编译产物与三个 runner 模块均可从聚合运行时读取。

~~~js
test("packed WorkBuddy runtime includes startup and logging modules", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-wb-pack-"));
  try {
    await stageDesktopAggregate(root, { build: false });
    await fs.access(path.join(root, "runtime", "workbuddy", "scripts", "wb-startup-media.mjs"));
    await fs.access(path.join(root, "runtime", "workbuddy", "scripts", "wb-runner-log.mjs"));
    await fs.access(path.join(root, "runtime", "workbuddy", "scripts", "wb-theme-name-diagnostic.mjs"));
    await fs.access(path.join(root, "runtime", "workbuddy", "packages", "adapter-workbuddy", "dist", "background-stage.js"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
~~~

- [ ] **Step 2: 运行红测。** Run: node --test packages/beauticode-desktop/test/pack.test.mjs。Expected: 新运行时模块未进入聚合包。
- [ ] **Step 3: 更新打包清单及使用指南。** 说明登录日志位置、轮转、默认媒体优先级及中文名诊断边界；不自动发布 npm、不修改用户媒体。
- [ ] **Step 4: 全量验证。** Run: npm run build && npm run typecheck && npm test && npm run desktop:pack。Windows 真机验收无状态首启、图片/视频恢复、清除后重启、侧栏重挂、原图标启动后的日志、约 800 MB 有效视频；关闭/重开由用户配合，主动关闭后观察 30 秒不得重启。
- [ ] **Step 5: 检查 scoped diff 并提交。** 若现有未提交 hunk 无法安全分离，保留未提交并报告；否则提交 test: verify WorkBuddy boot and logging recovery。
