/**
 * In-process host applier for unit tests — records payloads and exposes the
 * last generation for assertions. Not used against a real Codex window.
 */
export class MemoryHostApplier {
  constructor(opts = {}) {
    this.payloads = [];
    this.verifyStatus = opts.verifyStatus ?? "pass";
    this.verifyReason = opts.verifyReason ?? "memory host";
  }

  async apply(payload) {
    this.payloads.push(payload);
  }

  async verify(expected, _opts) {
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
