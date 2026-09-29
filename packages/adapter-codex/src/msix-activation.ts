import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PACKAGE_PATH = /[\\/]WindowsApps[\\/](OpenAI\.Codex_[^\\/]+)[\\/]app[\\/]ChatGPT\.exe$/i;

export interface CodexMsixTarget {
  kind: "msix";
  packageFullName: string;
  executable: string;
  port: number;
}

export function codexMsixPackageFullName(executable: string): string | null {
  return PACKAGE_PATH.exec(path.win32.normalize(executable))?.[1] ?? null;
}

function psString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** The package and manifest are checked again in PowerShell before activation. */
export function buildCodexMsixActivationScript(
  target: CodexMsixTarget,
  withCdp = true,
  probeOnly = false,
): string {
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
    throw new Error("Invalid Codex CDP port");
  }
  if (codexMsixPackageFullName(target.executable) !== target.packageFullName) {
    throw new Error("Codex MSIX package path mismatch");
  }
  const argumentsText = withCdp
    ? `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${target.port}`
    : "";
  return `
$ErrorActionPreference = 'Stop'
try {
  $expectedPackage = ${psString(target.packageFullName)}
  $expectedExecutable = ${psString(target.executable)}
  $package = @(Get-AppxPackage -Name OpenAI.Codex | Where-Object { $_.PackageFullName -eq $expectedPackage })
  if ($package.Count -ne 1) { throw 'package-not-found' }
  $resolvedExecutable = [IO.Path]::GetFullPath([IO.Path]::Combine($package[0].InstallLocation, 'app', 'ChatGPT.exe'))
  if ($resolvedExecutable -ine [IO.Path]::GetFullPath($expectedExecutable)) { throw 'package-path-mismatch' }
  $manifest = Get-AppxPackageManifest -Package $expectedPackage
  $apps = @($manifest.Package.Applications.Application | Where-Object {
    $_.Id -eq 'App' -and ([string]$_.Executable).Replace('/', [char]92) -ieq ('app' + [char]92 + 'ChatGPT.exe')
  })
  if ($apps.Count -ne 1) { throw 'manifest-app-mismatch' }
  $aumid = $package[0].PackageFamilyName + '!App'
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IApplicationActivationManager {
  [PreserveSig] int ActivateApplication(
    [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
    [MarshalAs(UnmanagedType.LPWStr)] string arguments,
    uint options,
    out uint processId);
}
public static class CodexMsixActivation {
  public static void CheckAvailable() {
    var type = Type.GetTypeFromCLSID(new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C"));
    var manager = (IApplicationActivationManager)Activator.CreateInstance(type);
    Marshal.ReleaseComObject(manager);
  }
  public static uint Activate(string appUserModelId, string arguments) {
    var type = Type.GetTypeFromCLSID(new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C"));
    var manager = (IApplicationActivationManager)Activator.CreateInstance(type);
    uint pid;
    int hr = manager.ActivateApplication(appUserModelId, arguments, 0, out pid);
    Marshal.ThrowExceptionForHR(hr);
    return pid;
  }
}
'@
  if (${probeOnly ? "$true" : "$false"}) {
    [CodexMsixActivation]::CheckAvailable()
    [Console]::Out.WriteLine('ready')
  } else {
    $pidValue = [CodexMsixActivation]::Activate($aumid, ${psString(argumentsText)})
    if ($pidValue -le 0) { throw 'empty-activation-pid' }
    [Console]::Out.WriteLine($pidValue)
  }
} catch {
  [Console]::Error.WriteLine('msix-activation-failed:' + $_.Exception.GetType().Name + ':' + $_.Exception.HResult.ToString('X8'))
  exit 2
}
`;
}

async function runMsixScript(script: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 },
    );
    return stdout.trim();
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    const code = /msix-activation-failed:[A-Za-z]+:[0-9A-F]{8}/.exec(stderr)?.[0]
      ?? "msix-activation-failed:unknown";
    throw new Error(`Codex ${code}`, { cause: error });
  }
}

export async function preflightCodexMsix(target: CodexMsixTarget): Promise<void> {
  const result = await runMsixScript(buildCodexMsixActivationScript(target, true, true));
  if (result !== "ready") throw new Error("Codex MSIX activation preflight failed");
}

export async function activateCodexMsix(
  target: CodexMsixTarget,
  withCdp = true,
): Promise<number> {
  const result = await runMsixScript(buildCodexMsixActivationScript(target, withCdp));
  const pid = Number(result);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("MSIX activation returned an invalid PID");
  }
  return pid;
}
