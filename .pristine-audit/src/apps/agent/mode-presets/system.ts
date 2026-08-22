import type { RunMode } from "@/agent"
import { type GlobRule, loadGlobRulesWithVendors } from "@/agent/glob-rules"
import { loadRepoRules, type RepoRules } from "@/agent/repo-rules"
import { modeLoadsRepoRules } from "@/agent/run-mode"
import { buildSystemPromptForRunMode, promptSurfaceProfileForRunMode } from "@/agent/system-prompt"
import type { PromptSurfaceProfileSnapshot } from "@/shared"

// Re-export the SSOT policy (now in the surface-agnostic `@/agent/run-mode`
// layer so web-daemon can link to the SAME decision) for callers/tests that
// imported it from here.
export { MODE_REPO_RULES_POLICY } from "@/agent/run-mode"

export const resolveModePresetSystemPrompt = (
  mode: RunMode,
  system: string | undefined,
  cwd: string,
): string =>
  typeof system === "string" && system.trim().length > 0
    ? system
    : buildSystemPromptForRunMode({ runMode: mode, cwd })

export const resolveModePresetPromptSurfaceProfile = (
  mode: RunMode,
  system: string | undefined,
): PromptSurfaceProfileSnapshot | undefined =>
  typeof system === "string" && system.trim().length > 0
    ? undefined
    : promptSurfaceProfileForRunMode(mode)

/**
 * WS4 (jul-12 OmO absorption + hell-audit R3/R4/R5/R8) — the ONE place a PRESET
 * decides whether to load repo-local rules (AGENTS.md / CLAUDE.md). A caller
 * `override` always wins (trusted host code); otherwise the SSOT policy
 * {@link modeLoadsRepoRules} (in `@/agent/run-mode`, shared with web-daemon)
 * decides. Fail-open: a broken/unreadable rule source must never crash session
 * start.
 *
 * Mirrors {@link resolveModePresetSystemPrompt} / {@link
 * resolveModePresetPromptSurfaceProfile}: a mode-keyed resolver each preset's
 * base-builder calls, rather than N divergent inline loads.
 */
export const resolveModePresetRepoRules = async (
  mode: RunMode,
  override: RepoRules | undefined,
  cwd: string,
): Promise<RepoRules | undefined> => {
  if (override !== undefined) return override
  if (!modeLoadsRepoRules(mode)) return undefined
  return loadRepoRules(cwd).catch(() => undefined)
}

/**
 * WS4 follow-on (jul-19) — the ONE place a PRESET decides whether to surface
 * multi-source vendor glob-rules (`.cursor/rules`, `.clinerules`, `.windsurfrules`,
 * aider/roo, …) via {@link loadGlobRulesWithVendors} → the detector's `detectAll`.
 *
 * SECURITY (load-bearing): `loadGlobRulesWithVendors` is trust-BLIND — it reads
 * repo-provided rule files with no mode awareness. So this resolver gates on the
 * SAME {@link modeLoadsRepoRules} SSOT the repo-rules path uses: an untrusted /
 * hermetic surface (ci-bot / daemon / batch) gets `[]`, never a repo-controlled
 * `.windsurfrules` spliced into the trusted system prompt (self-approve vector).
 * `enabled` is the default-OFF feature gate (`QUANTA_VENDOR_RULES`). Fail-open:
 * a broken detector/loader must never crash session start. Empty ⇒ the caller
 * leaves `cfg.globRules` unset ⇒ OFF byte-identical.
 */
export const resolveModePresetGlobRules = async (
  mode: RunMode,
  cwd: string,
  enabled: boolean,
): Promise<GlobRule[]> => {
  if (!modeLoadsRepoRules(mode)) return [] // SECURITY: untrusted/hermetic ⇒ nothing
  if (!enabled) return [] // FEATURE gate: default-OFF
  return loadGlobRulesWithVendors(cwd, { vendorDetectorEnabled: true }).catch(() => [])
}
