import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

const scripts = [
  "scripts/start-beauticode.ps1",
  "scripts/start-beauticode-engine.ps1",
  "scripts/codex-launch.ps1",
  "scripts/install-dsh-plugin.ps1",
  "apps/tray/start-tray.ps1",
];

test("host scripts parse", () => {
  for (const relative of scripts) {
    const full = path.join(repoRoot, relative);
    const command = [
      "$errors = $null",
      `$null = [System.Management.Automation.Language.Parser]::ParseFile('${full.replace(/'/g, "''")}', [ref]$null, [ref]$errors)`,
      "if ($errors -and $errors.Count) { $errors | ForEach-Object { $_.ToString() }; exit 1 }",
    ].join("; ");
    const result = spawnSync(
      "powershell.exe",
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
});

test("picker DryRun routes DSH to the tray and Codex to its launcher", () => {
  const script = path.join(repoRoot, "scripts/start-beauticode.ps1");
  for (const [host, needle] of [
    ["dsh", "start-tray.ps1"],
    ["codex", "start-beauticode-engine.ps1"],
  ]) {
    const result = spawnSync(
      "powershell.exe",
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

test("install-dsh-plugin wires a missing DSH home and can uninstall", () => {
  const script = path.join(repoRoot, "scripts/install-dsh-plugin.ps1");
  const pluginRoot = path.join(repoRoot, "integrations/deepseek-harness");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bc-dsh-home-"));
  try {
    const add = spawnSync(
      "powershell.exe",
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
    fs.writeFileSync(
      path.join(web, "package.json"),
      JSON.stringify({
        name: "dsh-profile-web",
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(web, "cordis.patch.yml"), "[]\n", "utf8");
    const migrate = spawnSync(
      "powershell.exe",
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
    assert.match(webPatch, /@beauticode\/dsh-plugin/);
    assert.equal(fs.existsSync(path.join(home, "cordis.patch.yml")), false);
    const pkgBytes = fs.readFileSync(path.join(web, "package.json"));
    assert.notEqual(pkgBytes[0], 0xef, "profile package.json must not have a UTF-8 BOM");
    JSON.parse(pkgBytes.toString("utf8"));
    assert.ok(
      fs.existsSync(
        path.join(web, "node_modules", "@beauticode", "dsh-plugin", "index.mjs"),
      ),
    );

    const remove = spawnSync(
      "powershell.exe",
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
      fs.existsSync(path.join(web, "node_modules", "@beauticode", "dsh-plugin")),
      false,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
