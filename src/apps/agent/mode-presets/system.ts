import type { RunMode } from "@/agent"
import { type GlobRule, loadGlobRulesWithVendors } from "@/agent/glob-rules"
import { loadRepoRules, type RepoRules } from "@/agent/repo-rules"
import { modeLoadsRepoRules } from "@/agent/run-mode"
import { buildSystemPromptForRunMode, promptSurfaceProfileForRunMode } from "@/agent/system-prompt"
import { redactSecrets } from "@/security"
import { errMessage, logger, type PromptSurfaceProfileSnapshot } from "@/shared"

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

export interface ModePresetRulesLoadOpts {
  readonly warn?: (info: { cwd: string; cause: string }) => void
  readonly load?: (cwd: string) => Promise<RepoRules | undefined>
}

const emitRulesWarning = (
  warn: ((info: { cwd: string; cause: string }) => void) | undefined,
  cwd: string,
  cause: string,
  fallback: (info: { cwd: string; cause: string }) => void,
): void => {
  try {
    ;(warn ?? fallback)({ cwd, cause })
  } catch {
    // Diagnostic failure must not convert fail-open into throw.
  }
}

const scrubCause = (cause: string): string =>
  redactSecrets(cause, { origin: "envelope_jsonl" }).text

const defaultRepoRulesWarn = (info: { cwd: string; cause: string }): void => {
  logger.warn("mode preset repo rules load failed; continuing without local rules", {
    cwd: info.cwd,
    error: scrubCause(info.cause),
  })
}

/**
 * WS4 (jul-12 OmO absorption + hell-audit R3/R4/R5/R8) — the ONE place a PRESET
 * decides whether to load repo-local rules (AGENTS.md / CLAUDE.md). A caller
 * `override` always wins (trusted host code); otherwise the SSOT policy
 * {@link modeLoadsRepoRules} (in `@/agent/run-mode`, shared with web-daemon)
 * decides. Fail-open: a broken/unreadable rule source must never crash session
 * start. Load failure is warned exactly once (G-F13).
 */
export const resolveModePresetRepoRules = async (
  mode: RunMode,
  override: RepoRules | undefined,
  cwd: string,
  opts: ModePresetRulesLoadOpts = {},
): Promise<RepoRules | undefined> => {
  if (override !== undefined) return override
  if (!modeLoadsRepoRules(mode)) return undefined
  try {
    return await (opts.load ?? loadRepoRules)(cwd)
  } catch (e) {
    emitRulesWarning(opts.warn, cwd, scrubCause(errMessage(e)), defaultRepoRulesWarn)
    return undefined
  }
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
const defaultGlobRulesWarn = (info: { cwd: string; cause: string }): void => {
  logger.warn("mode preset glob rules load failed; continuing without vendor rules", {
    cwd: info.cwd,
    error: info.cause,
  })
}

export const resolveModePresetGlobRules = async (
  mode: RunMode,
  cwd: string,
  enabled: boolean,
): Promise<GlobRule[]> => {
  if (!modeLoadsRepoRules(mode)) return [] // SECURITY: untrusted/hermetic ⇒ nothing
  if (!enabled) return [] // FEATURE gate: default-OFF
  try {
    return await loadGlobRulesWithVendors(cwd, { vendorDetectorEnabled: true })
  } catch (e) {
    emitRulesWarning(undefined, cwd, scrubCause(errMessage(e)), defaultGlobRulesWarn)
    return []
  }
}
