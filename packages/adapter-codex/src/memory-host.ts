import type {
  HostApplyPayload,
  HostApplier,
  VerifyExpectation,
  VerifyResult,
} from "@beauticode/core";

export interface MemoryHostOptions {
  verifyStatus?: VerifyResult["status"];
  verifyReason?: string;
}

/**
 * In-process host applier for unit tests — records payloads and exposes the
 * last generation for assertions. Not used against a real Codex window.
 */
export class MemoryHostApplier implements HostApplier {
  payloads: HostApplyPayload[] = [];
  verifyStatus: VerifyResult["status"];
  verifyReason: string;

  constructor(opts: MemoryHostOptions = {}) {
    this.verifyStatus = opts.verifyStatus ?? "pass";
    this.verifyReason = opts.verifyReason ?? "memory host";
  }

  async apply(payload: HostApplyPayload): Promise<void> {
    this.payloads.push(payload);
  }

  async verify(
    expected: VerifyExpectation,
    _opts: { deadlineMs: number },
  ): Promise<VerifyResult> {
    const last = this.payloads[this.payloads.length - 1];
    if (!last) {
      return { status: "fail", reason: "no payload applied" };
    }
    if (last.generation !== expected.generation) {
      return {
        status: "fail",
        reason: `generation mismatch: host=${last.generation} expected=${expected.generation}`,
      };
    }
    return {
      status: this.verifyStatus,
      reason: this.verifyReason,
      details: { media: last.media },
    };
  }
}
