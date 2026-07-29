import type { VerifyExpectation, VerifyResult } from "@beauticode/core";

export interface ReadinessSnapshot {
  generation: number;
  active: boolean;
  media: string | null;
  videoReady: boolean;
  videoFailed?: boolean;
  hasStage: boolean;
  hasImage: boolean;
  imageLoaded?: boolean;
  imageFailed?: boolean;
  hasVideo: boolean;
  hasPlayableSrc?: boolean;
  stagePointerEvents: string | null;
  horizontalOverflow: boolean;
  documentHidden?: boolean;
  documentVisibility?: string | null;
}

/**
 * Evaluate a pure readiness snapshot (no CDP). Shared contract so platform
 * injectors do not drift (upstream #277 / #294 / #298).
 */
export function assessReadiness(
  snap: ReadinessSnapshot,
  expected: VerifyExpectation,
): VerifyResult {
  if (!snap || typeof snap !== "object") {
    return { status: "inconclusive", reason: "empty readiness snapshot" };
  }
  if (typeof snap.generation !== "number") {
    return { status: "inconclusive", reason: "snapshot missing generation" };
  }
  if (snap.generation !== expected.generation) {
    return {
      status: "fail",
      reason: `generation mismatch (page=${snap.generation}, expected=${expected.generation})`,
    };
  }
  if (expected.media === "clear") {
    if (snap.active || snap.hasStage) {
      return {
        status: "fail",
        reason: "clear expected but background still active",
      };
    }
    return { status: "pass", reason: "cleared" };
  }
  if (!snap.active || !snap.hasStage) {
    return { status: "fail", reason: "background stage missing" };
  }
  if (!snap.hasImage) {
    return { status: "fail", reason: "poster/image missing" };
  }
  if (snap.imageFailed) {
    return { status: "fail", reason: "poster/image decode failed" };
  }
  if (snap.stagePointerEvents && snap.stagePointerEvents !== "none") {
    return {
      status: "fail",
      reason: `stage pointer-events must be none (got ${snap.stagePointerEvents})`,
    };
  }
  if (snap.horizontalOverflow) {
    return {
      status: "fail",
      reason: "horizontal document overflow detected",
    };
  }

  const docHidden =
    snap.documentHidden === true || snap.documentVisibility === "hidden";

  if (expected.media === "video") {
    if (snap.videoFailed) {
      return { status: "fail", reason: "video decode/playback failed" };
    }
    if (snap.media !== "video" && snap.media !== "video-pending") {
      return {
        status: "fail",
        reason: `video expected but renderer reports ${snap.media ?? "no media"}`,
      };
    }
    if (!snap.hasVideo && !snap.videoReady) {
      return { status: "fail", reason: "video node missing" };
    }
    if (
      (snap.media === "video" || snap.media === "video-pending") &&
      snap.videoReady
    ) {
      if (snap.hasPlayableSrc === false) {
        return { status: "fail", reason: "video has no playable local source" };
      }
      // Video ready is a DOM/media fact; hidden window must not false-rollback (#267).
      // handoffReady also reports videoReady while media may still be pending.
      return {
        status: "pass",
        reason: docHidden
          ? "video ready (document hidden; structural pass)"
          : "video ready",
      };
    }
    if (
      (snap.media === "video" || snap.media === "video-pending") &&
      snap.hasImage
    ) {
      // Still decoding/painting — wait. Hidden just extends the same wait (#294).
      return {
        status: "inconclusive",
        reason: docHidden
          ? "document is hidden; video not ready yet; poster present"
          : "video present but not ready yet; poster visible",
        details: { documentVisibility: snap.documentVisibility ?? null },
      };
    }
  }
  if (expected.media === "image") {
    if (snap.media !== "image") {
      return {
        status: "fail",
        reason: `image expected but renderer reports ${snap.media ?? "no media"}`,
      };
    }
    if (!snap.imageLoaded) {
      return {
        status: "inconclusive",
        reason: docHidden
          ? "document is hidden; image has not decoded yet"
          : "image has not decoded yet",
        details: { documentVisibility: snap.documentVisibility ?? null },
      };
    }
    return {
      status: "pass",
      reason: docHidden
        ? "image background ready (document hidden; structural pass)"
        : "image background ready",
    };
  }
  if (docHidden) {
    return {
      status: "inconclusive",
      reason: "document is hidden; deferring hard verify",
      details: { documentVisibility: snap.documentVisibility ?? null },
    };
  }
  return { status: "inconclusive", reason: "unclassified readiness state" };
}

/** Expression run inside the host page to collect a readiness snapshot. */
export const SNAPSHOT_EXPRESSION = `(() => {
  const api = window.__BEAUTICODE_BG__;
  if (!api || typeof api.snapshot !== "function") {
    return {
      generation: -1,
      active: false,
      media: null,
      videoReady: false,
      videoFailed: false,
      hasStage: false,
      hasImage: false,
      imageLoaded: false,
      imageFailed: false,
      hasVideo: false,
      hasPlayableSrc: false,
      stagePointerEvents: null,
      horizontalOverflow:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1,
      documentHidden: document.hidden === true,
      documentVisibility: document.visibilityState ?? null,
      missingRuntime: true,
    };
  }
  const snap = api.snapshot();
  snap.videoFailed = Boolean(api.videoFailed);
  snap.documentHidden = document.hidden === true;
  snap.documentVisibility = document.visibilityState ?? null;
  return snap;
})()`;
