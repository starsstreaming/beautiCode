import type { CdpTargetInfo } from "./cdp.js";

/** Shared by the injector and read-only health probe, so both inspect one shell. */
export function selectCodexPrimaryTargets(
  targets: CdpTargetInfo[],
  { urlPrefix = "app://", requireAppProtocol = true } = {},
): CdpTargetInfo[] {
  const scored = targets
    .map((target) => {
      let score = 0;
      const url = target.url ?? "";
      const title = target.title ?? "";
      if (requireAppProtocol && !/^(?:app:\/\/-)(?:\/|$)/i.test(url)) return { target, score: -1_000 };
      if (/avatar-overlay|titlebar|utility-overlay|detached-window|initialRoute=%2Favatar/i.test(url)) {
        return { target, score: -1_000 };
      }
      if (url.startsWith(urlPrefix)) score += 10;
      if (url.startsWith("app://")) score += 5;
      if (/\/index\.html(?:$|\?)/i.test(url) && !/[?&]initialRoute=/i.test(url)) score += 20;
      if (/codex|chatgpt|openai/i.test(title)) score += 4;
      else if (!title.trim()) score += 1;
      return { target, score };
    })
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  const best = scored[0]!.score;
  return scored.filter(({ score }) => score === best)
    .sort((a, b) => a.target.id.localeCompare(b.target.id))
    .slice(0, 1)
    .map(({ target }) => target);
}
