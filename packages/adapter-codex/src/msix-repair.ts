export interface GuardedMsixRepairOperations {
  preflight: () => Promise<void>;
  stillFresh: () => Promise<boolean>;
  stop: () => Promise<void>;
  launchWithCdp: () => Promise<void>;
  verifyCdp: () => Promise<boolean>;
  markFailure: () => Promise<void>;
  restorePlain: () => Promise<void>;
  clearFailure: () => Promise<void>;
}

export async function runGuardedMsixRepair(
  ops: GuardedMsixRepairOperations,
): Promise<boolean> {
  await ops.preflight();
  if (!(await ops.stillFresh())) return false;
  await ops.stop();
  try {
    await ops.launchWithCdp();
    if (!(await ops.verifyCdp())) {
      throw new Error("Codex MSIX 激活后未出现已验证的 CDP 主页面");
    }
  } catch (error) {
    // The persistent marker must precede the plain launch: the watcher may
    // immediately observe that replacement as another fresh blind process.
    await ops.markFailure();
    await ops.restorePlain();
    throw error;
  }
  await ops.clearFailure();
  return true;
}
