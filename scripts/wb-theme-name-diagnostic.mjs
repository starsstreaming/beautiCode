import { createHmac } from "node:crypto";

export function fingerprintThemeName(name, key) {
  const bytes = Buffer.from(String(name), "utf8");
  return {
    byteLength: bytes.length,
    digest: createHmac("sha256", key).update(bytes).digest("hex").slice(0, 16),
  };
}

/** A per-process key makes fingerprints uncorrelatable across launches. */
export function compareThemeNameStages({ catalog, renderer, persisted }, key) {
  if ([catalog, renderer, persisted].some((value) => typeof value !== "string")) {
    return { firstMismatch: "unavailable", lengths: [], hashes: [] };
  }
  const values = [catalog, renderer, persisted].map((value) => fingerprintThemeName(value, key));
  return {
    firstMismatch: values[0].digest !== values[1].digest ? "renderer"
      : values[1].digest !== values[2].digest ? "persisted" : null,
    lengths: values.map((value) => value.byteLength),
    hashes: values.map((value) => value.digest),
  };
}
