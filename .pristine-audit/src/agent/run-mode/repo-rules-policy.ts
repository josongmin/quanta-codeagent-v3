import type { AgentMode } from "./types"

/**
 * EXHAUSTIVE per-mode repo-local-rules policy — the regression-prevention device
 * (hell-audit R3–R8). Lives in the surface-AGNOSTIC `run-mode` layer so EVERY
 * surface links to the SAME decision at compile time: the `apps/agent` presets
 * (via `resolveModePresetRepoRules`) AND the `apps/web-daemon` factory (surface
 * isolation forbids apps importing each other, but both may import `@/agent`).
 *
 * `Record<AgentMode, …>` makes this total by construction: adding a new mode to
 * the `AgentMode` union FAILS TO COMPILE here until it is explicitly classified,
 * so no surface can silently skip the load/rule-less (feature + SECURITY)
 * decision.
 *
 *   `"load"`      — a TRUSTED user-repo surface: the tree is a repo the end user
 *                   personally chose, so honor its AGENTS.md/CLAUDE.md.
 *   `"rule-less"` — NEVER auto-load: a hermetic bench sandbox (`batch`) OR an
 *                   UNTRUSTED tree (`ci-bot` = PR checkout, `daemon` = host-created
 *                   PR/webhook worktree). Auto-loading their AGENTS.md would smuggle
 *                   attacker-authored text into the TRUSTED system-prompt
 *                   `project_md` (rendered as authoritative "Rules"), defeating
 *                   ci-bot's `<pr_untrusted_data>` fence (a malicious PR could
 *                   self-approve). A trusted host may still inject vetted rules via
 *                   an explicit override at the resolver.
 */
export const MODE_REPO_RULES_POLICY: Record<AgentMode, "load" | "rule-less"> = {
  interactive: "load",
  headless: "load",
  ide: "load",
  batch: "rule-less",
  "ci-bot": "rule-less",
  daemon: "rule-less",
}

/** Does `mode` auto-load repo-local rules from its working tree? The single
 *  predicate both the preset resolver and the web/Tauri factory gate on, so
 *  their trust decisions can never drift apart. */
export const modeLoadsRepoRules = (mode: AgentMode): boolean =>
  MODE_REPO_RULES_POLICY[mode] === "load"
