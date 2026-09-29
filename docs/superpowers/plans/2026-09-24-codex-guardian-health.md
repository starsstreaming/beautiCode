# Codex Guardian and Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Codex 的外层守护在同一 Windows 登录会话内可有界恢复，并提供不改变状态的分层健康检查。

**Architecture:** 当前用户计划任务替换 HKCU Run 作为唯一开机接线；任务管理外层 watchdog，watchdog 继续管理内部 watch-host。独立 health 探针只读进程、受限 loopback CDP 和选定主页面，不再让文件安装状态冒充运行健康。

**Tech Stack:** Node.js >=22、ESM、Windows Task Scheduler/PowerShell、现有 @beauticode/core 文件锁与 @beauticode/adapter-codex CDP 模块、node:test。

**Spec:** docs/superpowers/specs/2026-09-24-codex-guardian-health-design.md

## Global Constraints

- 仅更改 Windows Codex 接线；Codex 原始图标、官方程序与其启动参数不改。
- 自动 CDP 修复只允许年龄小于 10 秒、唯一的新主进程；旧进程与用户主动关闭的宿主绝不自动重启。
- 任务当前用户、最低权限、登录触发、无限执行时限、IgnoreNew、失败后有界重试；禁止每分钟周期任务。
- status/all status 保持文件标记语义；health 只读、超时有界，不输出完整 URL、窗口标题、主题名、路径或账号信息。
- 工作树有其他未提交改动。每次只暂存本任务新增文件及经过检查的相关 hunk；禁止 git add -A。
- 当前对话可能运行在 Codex 宿主内；真机验收不得自动关闭正在使用的 Codex，关闭/重开场景由用户配合执行。

## Review Focus

1. 同名但 action 不属于 beautiCode 的任务：安装/卸载均拒绝覆盖或删除；Task 1 测试。
2. 注册成功但即时启动失败：恢复旧 Run 接线且安装失败；Task 1 测试。
3. 旧外层 watchdog 与新任务交接重叠：租约阻止第二条内部链；Task 2 测试。
4. Codex 已运行超过 10 秒且无 CDP：health 提示用户可选重开，不结束宿主；Task 3 测试。
5. 错误端口或入口滚出视口：不误报 connected/visible；Task 3 测试。

---

### Task 1: 计划任务接线与安装事务

**Files:** Create integrations/codex-desktop/task-wiring.mjs；Create packages/adapter-codex/test/codex-task-wiring.test.js；Modify integrations/codex-desktop/cli.js、integrations/codex-desktop/lifecycle.mjs。

**Interfaces:** Consumes 稳定 start-watch.ps1、旧 Run 值和经安装路径验证的旧守护进程。Produces installCodexWiring({task,runKey,stopOld,resumeOld,starter}) 与 uninstallCodexWiring({task,runKey,stopOwned})；task adapter 实现 read/register/start/stop/removeOwned/restore/isRunning。任务名固定为 beautiCode Codex Guardian。

- [ ] **Step 1: 写失败测试。** 使用有状态的 task/runKey 假实现验证成功安装、启动失败回滚和外来同名任务保护，断言最终接线状态而非仅断言调用次数：

~~~js
function memoryTask(state, { failStart = false } = {}) {
  return {
    async assertAbsentOrOwned() {
      if (state.task?.owner === "foreign") throw new Error("task is not owned");
    },
    async read() { return state.task ? { ...state.task } : null; },
    async register(starter) { state.task = { owner: "beauticode", action: starter }; },
    async assertOwned() {
      if (state.task?.owner !== "beauticode") throw new Error("task is not owned");
    },
    async start() {
      if (failStart) throw new Error("task start failed");
      state.task.running = true;
    },
    async isRunning() { return state.task?.running === true; },
    async stop() { if (state.task?.owner === "beauticode") state.task.running = false; },
    async removeOwned() {
      if (state.task?.owner === "beauticode") state.task = null;
    },
    async restore(value) { state.task = value; },
  };
}
function memoryRunKey(state) {
  return {
    async read() { return state.run; },
    async remove() { state.run = null; },
    async restore(value) { state.run = value; },
  };
}
test("failed task start restores old Run wiring", async () => {
  const state = { run: "old-command", task: null };
  await assert.rejects(() => installCodexWiring({
    task: memoryTask(state, { failStart: true }),
    runKey: memoryRunKey(state), stopOld: async () => {},
    resumeOld: async () => {},
    starter: "C:\\bc\\start-watch.ps1",
  }));
  assert.equal(state.run, "old-command");
  assert.equal(state.task, null);
});
test("a foreign task is never replaced", async () => {
  const state = { run: null, task: { owner: "foreign", action: "other.exe" } };
  await assert.rejects(() => installCodexWiring({
    task: memoryTask(state), runKey: memoryRunKey(state),
    stopOld: async () => {}, resumeOld: async () => {},
    starter: "C:\\bc\\start-watch.ps1",
  }), /not owned/);
  assert.equal(state.task.action, "other.exe");
});
test("failed upgrade restores an existing owned task", async () => {
  const state = {
    run: "old-command",
    task: { owner: "beauticode", action: "old-starter.ps1", running: true },
  };
  let resumed = false;
  await assert.rejects(() => installCodexWiring({
    task: memoryTask(state, { failStart: true }),
    runKey: memoryRunKey(state), stopOld: async () => {},
    resumeOld: async () => { resumed = true; },
    starter: "C:\\bc\\new-starter.ps1",
  }));
  assert.equal(state.task.action, "old-starter.ps1");
  assert.equal(resumed, true);
});
test("uninstall removes only owned task and Run key", async () => {
  const state = { run: "old-command", task: { owner: "beauticode", action: "starter.ps1" } };
  await uninstallCodexWiring({
    task: memoryTask(state), runKey: memoryRunKey(state),
    stopOwned: async () => {},
  });
  assert.deepEqual(state, { run: null, task: null });
});
~~~

- [ ] **Step 2: 运行红测。** Run: npm run build -w @beauticode/core && node --test packages/adapter-codex/test/codex-task-wiring.test.js。Expected: 缺少 task-wiring 导出导致失败，非测试语法错误。
- [ ] **Step 3: 最小实现。** 新模块使用当前用户 SID 和绝对 launcher 路径调用 Windows Task Scheduler。注册前核对同名任务 action 和主体。设置 AtLogOn、Limited、IgnoreNew、ExecutionTimeLimit=0、RestartCount=3、RestartInterval=1 分钟，action 隐藏执行并等待 launcher 退出。安装顺序为注册并验证任务、移除旧 Run、仅停止确认属于本产品的旧守护、启动并验证任务；失败恢复旧 Run 并删除仅本产品任务。卸载只拆本产品任务与旧 Run，不触碰 Codex。移除 cli.js 的直接后台拉起正式路径。

~~~js
export async function installCodexWiring({ task, runKey, stopOld, starter }) {
  const previous = await runKey.read();
  const previousTask = await task.read();
  await task.assertAbsentOrOwned();
  await task.register(starter);
  let stoppedOld = false;
  try {
    await task.assertOwned();
    await runKey.remove();
    await stopOld();
    stoppedOld = true;
    await task.start();
    if (!(await task.isRunning())) throw new Error("Codex guardian task did not start");
  } catch (error) {
    if (previousTask) await task.restore(previousTask);
    else await task.removeOwned();
    await runKey.restore(previous);
    if (stoppedOld) await resumeOld();
    throw error;
  }
}
~~~

- [ ] **Step 4: 运行绿测与 Windows 权限测试。** Run: node --test packages/adapter-codex/test/codex-task-wiring.test.js。再以非管理员当前用户、临时专属任务名完成 register/query/start/delete，读取真实任务设置和 action；如系统拒绝注册，安装必须失败且旧接线不变。
- [ ] **Step 5: 检查并提交本任务 hunk。** Run: git diff --check && git diff --cached --check。只暂存新增文件及 cli.js/lifecycle.mjs 的本任务 hunk，提交 feat: supervise Codex guardian with a user task。

### Task 2: 外层 watchdog 单实例与退出语义

**Files:** Modify integrations/codex-desktop/codex-watchdog.mjs、integrations/codex-desktop/lifecycle.mjs、packages/adapter-codex/test/codex-lifecycle.test.js、scripts/pack-codex-plugin.mjs、packages/beauticode-desktop/src/index.mjs。

**Interfaces:** Consumes Task 1 的任务启动路径和 vendor/core/index.js 的 acquireFileLock。Produces Codex 专属 guardian.lock 租约；正常停止返回 0，未处理异常返回非零。

- [ ] **Step 1: 写失败测试。** 临时目录中实际获取租约，第二个守护不得启动内部 helper；第一个释放后允许接管。保留现有内部 helper 崩溃后 1 秒恢复测试。

~~~js
test("second outer guardian cannot acquire a live lease", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-guardian-"));
  const first = await acquireCodexGuardianLease(root);
  try {
    await assert.rejects(() => acquireCodexGuardianLease(root), /running/);
  } finally {
    await first.release();
    await fs.rm(root, { recursive: true, force: true });
  }
});
~~~

- [ ] **Step 2: 运行红测。** Run: npm run build -w @beauticode/core && node --test packages/adapter-codex/test/codex-lifecycle.test.js。Expected: acquireCodexGuardianLease 尚不存在。
- [ ] **Step 3: 最小实现。** watchdog 主循环在启动内部 helper 前持有 Codex 命名空间的真实文件锁；按 watch-host.mjs 的 vendor/workspace 双路径解析方式导入 core，保证源码测试与打包运行都能找到 acquireFileLock。重复实例不再生成第二条内部监视链。信号停止释放租约并退出 0；非预期错误保留非零退出，触发任务的有限重试。将 task-wiring.mjs 加入独立 Codex 包和聚合运行时过滤/必需清单。

~~~js
export async function acquireCodexGuardianLease(home) {
  return acquireFileLock(path.join(home, "guardian.lock"), {
    purpose: "Codex guardian",
    staleMs: 10_000,
  });
}
~~~

- [ ] **Step 4: 运行绿测。** Run: node --test packages/adapter-codex/test/codex-lifecycle.test.js && npm run plugin:pack-codex。检查包内没有用户绝对路径。
- [ ] **Step 5: 仅提交本任务 hunk。** 提交 fix: keep the Codex outer guardian single-instance。

### Task 3: Codex 分层只读 health

**Files:** Create integrations/codex-desktop/health.mjs、packages/adapter-codex/test/codex-health.test.js；Modify integrations/codex-desktop/cli.js、packages/beauticode-desktop/src/index.mjs、packages/beauticode-desktop/bin/beauticode-desktop.mjs、packages/beauticode-desktop/test/route.test.mjs。

**Interfaces:** Consumes Task 1 任务注册状态、Task 2 租约及现有 listCodexProcesses/listPageTargets/connectPageTarget。Produces probeCodexHealth(deps) JSON 和 beauticode-desktop codex health；status/all status 输出不变。

- [ ] **Step 1: 写失败测试。** 用完整边界快照覆盖 closed→wait-for-launch、旧 blind→manual-restart-available、错误端口→wrong-host、入口视口外→offscreen、探针超时→unknown；确认无启动/停止调用。

~~~js
test("old blind Codex is reported without an automatic restart", async () => {
  const result = await probeCodexHealth({
    installation: async () => ({ runtimeReady: true, taskOwned: true }),
    guardian: async () => "running",
    host: async () => [{ pid: 42, ageMs: 30_000, port: null }],
    cdp: async () => ({ state: "missing" }),
    entry: async () => "not-checked",
  });
  assert.equal(result.host, "running");
  assert.equal(result.cdp, "missing");
  assert.equal(result.action, "manual-restart-available");
});
~~~

- [ ] **Step 2: 运行红测。** Run: node --test packages/adapter-codex/test/codex-health.test.js packages/beauticode-desktop/test/route.test.mjs。Expected: health API 和路由缺失。
- [ ] **Step 3: 最小实现。** 仅从已验证 Codex 主进程及受限端口发现 CDP；复用 loopback/浏览器身份校验。只对最佳主页面 evaluate 背景入口的矩形与 elementFromPoint，返回 visible/offscreen/not-mounted，候选主页面数单独报告。每层错误转为有界 reason code，不泄漏 URL、标题或路径。CLI 输出 JSON，不隐式安装。

~~~js
export function classifyEntry(node) {
  if (!node?.exists) return "not-mounted";
  if (!node.inViewport || !node.hitTest) return "offscreen";
  return "visible";
}
~~~

- [ ] **Step 4: 运行绿测。** Run: node --test packages/adapter-codex/test/codex-health.test.js packages/beauticode-desktop/test/route.test.mjs packages/beauticode-desktop/test/cli-status.test.mjs。确认原 status JSON 字段不变。
- [ ] **Step 5: 仅提交本任务 hunk。** 提交 feat: report Codex guardian and CDP health separately。

### Task 4: 打包、文档和 Windows 真机验收

**Files:** Modify scripts/pack-codex-plugin.mjs、scripts/pack-desktop-aggregate.mjs、packages/beauticode-desktop/README.md、docs/beauticode-desktop-test-guide.md、packages/beauticode-desktop/test/pack.test.mjs。

**Interfaces:** Consumes 前三项接口。Produces 自包含 Codex 与聚合包，不改其它四宿主运行时。

- [ ] **Step 1: 写失败打包测试。** 运行打包函数，验证 task-wiring.mjs 和 health.mjs 存在且 health 路由可解析。

~~~js
import { stageCodexPlugin } from "../../../scripts/pack-codex-plugin.mjs";
test("packed Codex runtime contains task wiring and health probe", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-codex-pack-"));
  try {
    await stageCodexPlugin(root, { build: false });
    await fs.access(path.join(root, "task-wiring.mjs"));
    await fs.access(path.join(root, "health.mjs"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
~~~

- [ ] **Step 2: 运行红测。** Run: node --test packages/beauticode-desktop/test/pack.test.mjs。Expected: 新模块尚未打包。
- [ ] **Step 3: 更新包清单和指南。** 说明 status/health 区别、任务权限/卸载、异常退出重试上限、旧无 CDP 宿主需用户自主重开。只改必要文件，不自动发布 npm。
- [ ] **Step 4: 全量验证。** Run: npm run build && npm run typecheck && npm test && npm run desktop:pack。Windows 真机按 spec 的四种启动时序验收；涉及当前 Codex 窗口关闭的步骤请用户配合，不由测试脚本自动执行。主动关闭后观察 30 秒确认不重开；仅终止本产品外层守护验证有界恢复。记录任务设置与 health 枚举，不记录页面 URL。
- [ ] **Step 5: 检查 scoped diff 并提交。** 若既有未提交 hunk 无法安全分离，停止暂存并报告；否则提交 test: verify Codex guardian recovery and health。
