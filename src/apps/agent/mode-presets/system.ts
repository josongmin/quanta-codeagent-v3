import type { RunMode } from "@/agent"
import { loadRepoRules, type RepoRules } from "@/agent/repo-rules"
import { buildSystemPromptForRunMode, promptSurfaceProfileForRunMode } from "@/agent/system-prompt"
import type { PromptSurfaceProfileSnapshot } from "@/shared"

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
 * EXHAUSTIVE per-mode repo-rules policy — the regression-prevention device.
 *
 * `Record<RunMode, …>` makes this total by construction: adding a new `AgentMode`
 * to the type FAILS TO COMPILE here until it is explicitly classified, so no new
 * surface can silently skip the load/rule-less (feature + SECURITY) decision.
 *
 *   `"load"`      — a TRUSTED user-repo surface: the tree is a repo the end user
 *                   personally chose, so honor its AGENTS.md/CLAUDE.md.
 *   `"rule-less"` — NEVER auto-load: a hermetic bench sandbox (`batch`) OR an
 *                   UNTRUSTED tree (`ci-bot` = PR checkout, `daemon` = host-created
 *                   PR/webhook worktree). Auto-loading their AGENTS.md would smuggle
 *                   attacker-authored text into the TRUSTED system-prompt
 *                   `project_md` (authoritative "Rules"), defeating ci-bot's
 *                   `<pr_untrusted_data>` fence (a malicious PR could self-approve).
 *                   A trusted host may still inject vetted rules via `override`.
 */
export const MODE_REPO_RULES_POLICY: Record<RunMode, "load" | "rule-less"> = {
  interactive: "load",
  headless: "load",
  ide: "load",
  batch: "rule-less",
  "ci-bot": "rule-less",
  daemon: "rule-less",
}

/**
 * WS4 (jul-12 OmO absorption + hell-audit R3/R4/R5) — the ONE place that decides
 * whether a preset loads repo-local rules (AGENTS.md / CLAUDE.md), so the policy
 * cannot drift per-preset. A caller-supplied `override` always wins (trusted host
 * code). Otherwise {@link MODE_REPO_RULES_POLICY} decides. Fail-open: a broken/
 * unreadable rule source must never crash session start.
 *
 * Mirrors {@link resolveModePresetSystemPrompt} / {@link
 * resolveModePresetPromptSurfaceProfile}: a mode-keyed resolver each preset's
 * base-builder calls, rather than N divergent inline loads. (The web/Tauri
 * surface mirrors this policy for its interactive-class trust in
 * `web-daemon/runtime-factory.ts` — surface isolation forbids importing this.)
 */
export const resolveModePresetRepoRules = async (
  mode: RunMode,
  override: RepoRules | undefined,
  cwd: string,
): Promise<RepoRules | undefined> => {
  if (override !== undefined) return override
  if (MODE_REPO_RULES_POLICY[mode] === "rule-less") return undefined
  return loadRepoRules(cwd).catch(() => undefined)
}
