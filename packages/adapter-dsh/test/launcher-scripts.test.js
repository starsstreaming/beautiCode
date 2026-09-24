import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const powerShellExecutable = process.platform === "win32" ? "powershell.exe" : "pwsh";
const powerShellAvailable =
  spawnSync(powerShellExecutable, ["-NoProfile", "-Command", "exit 0"], {
    encoding: "utf8",
    windowsHide: true,
  }).status === 0;
const requiresPowerShell = {
  skip: powerShellAvailable ? false : "PowerShell is not available on this runner.",
};
const requiresWindowsPowerShell = {
  skip:
    process.platform === "win32" && powerShellAvailable
      ? false
      : "This installer integration requires Windows PowerShell and junctions.",
};

const scripts = [
  "scripts/start-beauticode.ps1",
  "scripts/start-beauticode-engine.ps1",
  "scripts/codex-launch.ps1",
  "scripts/install-dsh-plugin.ps1",
  "apps/tray/start-tray.ps1",
];

test("host scripts parse", requiresPowerShell, () => {
  for (const relative of scripts) {
    const full = path.join(repoRoot, relative);
    const command = [
      "$errors = $null",
      `$null = [System.Management.Automation.Language.Parser]::ParseFile('${full.replace(/'/g, "''")}', [ref]$null, [ref]$errors)`,
      "if ($errors -and $errors.Count) { $errors | ForEach-Object { $_.ToString() }; exit 1 }",
    ].join("; ");
    const result = spawnSync(
      powerShellExecutable,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(
      result.status,
      0,
      `${relative} failed to parse:\n${result.stdout}\n${result.stderr}`,
    );
  }
});

test("DSH runtime launcher and installer are gone", () => {
  assert.equal(
    fs.existsSync(path.join(repoRoot, "scripts/start-beauticode-dsh.ps1")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(repoRoot, "scripts/install-dsh-runtime.ps1")),
    false,
  );
  assert.equal(
    fs.existsSync(
      path.join(repoRoot, "integrations/deepseek-harness/compatibility.json"),
    ),
    false,
  );
});

test("tray lifecycle owns leftover session-host and second-click show-panel", () => {
  const tray = fs.readFileSync(
    path.join(repoRoot, "apps/tray/start-tray.ps1"),
    "utf8",
  );
  const host = fs.readFileSync(
    path.join(repoRoot, "apps/tray/session-host.mjs"),
    "utf8",
  );
  assert.match(tray, /BeautiCodeJob/);
  assert.match(tray, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.match(tray, /Stop-BcSessionHost/);
  assert.match(tray, /Write-BcTrayClaim/);
  assert.match(tray, /Use-BcAdoptedControl/);
  assert.match(tray, /existing tray signaled to show panel/);
  assert.match(tray, /--parent-pid/);
  assert.doesNotMatch(tray, /\$pid\s*=/);
  assert.match(host, /--parent-pid/);
  assert.match(host, /writeSessionHostFile/);
});

test("README documents installer auto-wiring, npx, and custom install paths", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  assert.match(readme, /不需要(?:安装)? ?pnpm/);
  assert.match(readme, /npx @deepseek-ai\/dsh web/);
  assert.match(readme, /npx @deepseek-ai\/dsh plugin/);
  assert.match(readme, /集成说明\.txt/);
  assert.match(readme, /(?:一般|也)不需要再执行 `dsh plugin add`/);
});

test("install-dsh-plugin writes an integration note for the actual install root", requiresPowerShell, () => {
  const script = path.join(repoRoot, "scripts/install-dsh-plugin.ps1");
  const pluginRoot = path.join(repoRoot, "integrations/deepseek-harness");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bc-dsh-home-"));
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bc-install-"));
  try {
    const add = spawnSync(
      powerShellExecutable,
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-PluginRoot",
        pluginRoot,
        "-DshHome",
        home,
        "-InstallRoot",
        installRoot,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(add.status, 0, add.stderr || add.stdout);
    const note = fs.readFileSync(path.join(installRoot, "集成说明.txt"), "utf8");
    assert.match(note, /不需要安装 pnpm/);
    assert.match(note, /npx @deepseek-ai\/dsh web/);
    assert.match(note, new RegExp(installRoot.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
    const remove = spawnSync(
      powerShellExecutable,
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-PluginRoot",
        pluginRoot,
        "-DshHome",
        home,
        "-InstallRoot",
        installRoot,
        "-Remove",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(remove.status, 0, remove.stderr || remove.stdout);
    assert.equal(fs.existsSync(path.join(installRoot, "集成说明.txt")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(installRoot, { recursive: true, force: true });
  }
});

test("picker and tray never spawn a DSH process", () => {
  const picker = fs.readFileSync(
    path.join(repoRoot, "scripts/start-beauticode.ps1"),
    "utf8",
  );
  const tray = fs.readFileSync(
    path.join(repoRoot, "apps/tray/start-tray.ps1"),
    "utf8",
  );
  const installer = fs.readFileSync(
    path.join(repoRoot, "scripts/build-windows-installer.ps1"),
    "utf8",
  );
  for (const [name, source] of [
    ["start-beauticode.ps1", picker],
    ["start-tray.ps1", tray],
    ["build-windows-installer.ps1", installer],
  ]) {
    assert.doesNotMatch(source, /start-beauticode-dsh/, `${name} must not launch DSH`);
    assert.doesNotMatch(source, /install-dsh-runtime/, `${name} must not install DSH`);
  }
  assert.match(installer, /agent\.mjs/);
  assert.match(installer, /control-client\.mjs/);
  assert.match(installer, /host-apply\.mjs/);
  assert.match(installer, /integration-note\.zh\.txt/);
});

test("picker DryRun routes DSH to the tray and Codex to its launcher", requiresPowerShell, () => {
  const script = path.join(repoRoot, "scripts/start-beauticode.ps1");
  for (const [host, needle] of [
    ["dsh", "start-tray.ps1"],
    ["codex", "start-beauticode-engine.ps1"],
  ]) {
    const result = spawnSync(
      powerShellExecutable,
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-DryRun",
        "-TargetHost",
        host,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, new RegExp(needle.replace(/[.]/g, "\\.")));
  }
});

test("install-dsh-plugin wires a missing DSH home and can uninstall", requiresWindowsPowerShell, () => {
  const script = path.join(repoRoot, "scripts/install-dsh-plugin.ps1");
  const pluginRoot = path.join(repoRoot, "integrations/deepseek-harness");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bc-dsh-home-"));
  try {
    const add = spawnSync(
      powerShellExecutable,
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-PluginRoot",
        pluginRoot,
        "-DshHome",
        home,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(add.status, 0, add.stderr || add.stdout);
    const homePatch = fs.readFileSync(path.join(home, "cordis.patch.yml"), "utf8");
    assert.match(homePatch, /id: beauticode-bridge/);
    assert.match(homePatch, /file:\/\//);

    const web = path.join(home, "profiles", "web");
    fs.mkdirSync(web, { recursive: true });
    // Start from the pre-1.0.1 installer / npx state: both dep names point at
    // another copy and the legacy scoped junction already exists.
    fs.writeFileSync(
      path.join(web, "package.json"),
      JSON.stringify({
        name: "dsh-profile-web",
        private: true,
        dependencies: {
          "beauticode-dsh": "link:C:/elsewhere/beauticode-dsh",
          "@beauticode/dsh-plugin": "link:C:/elsewhere/beauticode-dsh",
        },
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(web, "cordis.patch.yml"), "[]\n", "utf8");
    fs.mkdirSync(path.join(web, "node_modules", "@beauticode", "dsh-plugin"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(web, "node_modules", "@beauticode", "dsh-plugin", "index.mjs"),
      "export {}\n",
      "utf8",
    );
    const migrate = spawnSync(
      powerShellExecutable,
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-PluginRoot",
        pluginRoot,
        "-DshHome",
        home,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(migrate.status, 0, migrate.stderr || migrate.stdout);
    const webPatch = fs.readFileSync(path.join(web, "cordis.patch.yml"), "utf8");
    assert.doesNotMatch(webPatch, /id:\s*beauticode-bridge/);
    assert.doesNotMatch(webPatch, /@beauticode\/dsh-plugin/);
    assert.match(fs.readFileSync(path.join(pluginRoot, "cordis.patch.yml"), "utf8"), /id:\s*beauticode-bridge/);
    assert.equal(fs.existsSync(path.join(home, "cordis.patch.yml")), false);
    const pkgBytes = fs.readFileSync(path.join(web, "package.json"));
    assert.notEqual(pkgBytes[0], 0xef, "profile package.json must not have a UTF-8 BOM");
    const pkg = JSON.parse(pkgBytes.toString("utf8"));
    assert.equal(pkg.dependencies["beauticode-dsh"], `link:${pluginRoot.replace(/\\/g, "/")}`);
    assert.equal(pkg.dependencies["@beauticode/dsh-plugin"], undefined);
    assert.ok(
      fs.existsSync(
        path.join(web, "node_modules", "beauticode-dsh", "index.mjs"),
      ),
    );
    assert.equal(
      fs.existsSync(
        path.join(web, "node_modules", "@beauticode", "dsh-plugin"),
      ),
      false,
    );

    const remove = spawnSync(
      powerShellExecutable,
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-PluginRoot",
        pluginRoot,
        "-DshHome",
        home,
        "-Remove",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(remove.status, 0, remove.stderr || remove.stdout);
    assert.equal(
      fs.existsSync(path.join(web, "node_modules", "beauticode-dsh")),
      false,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("install-dsh-plugin deduplicates a loader already shipped by the plugin", requiresWindowsPowerShell, () => {
  const script = path.join(repoRoot, "scripts/install-dsh-plugin.ps1");
  const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bc-dsh-plugin-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bc-dsh-duplicate-"));
  try {
    fs.writeFileSync(path.join(pluginRoot, "index.mjs"), "export {};\n", "utf8");
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({ name: "beauticode-dsh", version: "test" }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "cordis.patch.yml"),
      "- insert:\n    - id: beauticode-bridge\n      name: beauticode-dsh\n      inject: [webServer]\n",
      "utf8",
    );
    const web = path.join(home, "profiles", "web");
    fs.mkdirSync(web, { recursive: true });
    fs.writeFileSync(
      path.join(web, "package.json"),
      JSON.stringify({ name: "dsh-profile-web", dependencies: {} }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(web, "cordis.patch.yml"),
      "- insert:\n    - id: user-loader\n      name: user-plugin\n      inject: [webServer]\n\n# beauticode-bridge (installer)\n- insert:\n    - id: beauticode-bridge\n      name: beauticode-dsh\n      inject: [webServer]\n",
      "utf8",
    );

    const result = spawnSync(
      powerShellExecutable,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-PluginRoot", pluginRoot, "-DshHome", home],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const webPatch = fs.readFileSync(path.join(web, "cordis.patch.yml"), "utf8");
    assert.match(webPatch, /id: user-loader/);
    assert.doesNotMatch(webPatch, /id: beauticode-bridge/);
    const backups = fs.readdirSync(web).filter((name) => name.startsWith("cordis.patch.yml.beauticode-backup-"));
    assert.equal(backups.length, 1);
    assert.match(fs.readFileSync(path.join(web, backups[0]), "utf8"), /id: beauticode-bridge/);
    assert.match(fs.readFileSync(path.join(pluginRoot, "cordis.patch.yml"), "utf8"), /id: beauticode-bridge/);
  } finally {
    fs.rmSync(pluginRoot, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
