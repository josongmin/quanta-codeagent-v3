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
 * The modes that NEVER auto-load repo-local rules from the working tree. All are
 * surfaces where the tree is NOT a repo the end user personally chose to trust:
 *   - `batch`  — hermetic bench sandbox: rule-less + byte-identical.
 *   - `ci-bot` — reviews an UNTRUSTED PR checkout (the PR author controls the
 *     tree, including its AGENTS.md/CLAUDE.md).
 *   - `daemon` — a scheduled/webhook single-task executor whose documented job is
 *     "review PR #42 / respond to webhook X" on a host-created per-instance
 *     worktree (daemon.ts exterior-adapter contract) — same untrusted-input class
 *     as ci-bot (hell-audit R5).
 * Auto-loading their AGENTS.md would smuggle attacker-authored text into the
 * TRUSTED system-prompt `project_md` (rendered as authoritative "Rules"),
 * defeating ci-bot's `<pr_untrusted_data>` fence (a malicious PR could
 * self-approve). A trusted host may still inject vetted rules via `override`.
 */
const RULE_LESS_MODES: ReadonlySet<RunMode> = new Set<RunMode>(["batch", "ci-bot", "daemon"])

/**
 * WS4 (jul-12 OmO absorption + hell-audit R3/R4) — the ONE place that decides
 * whether a preset loads repo-local rules (AGENTS.md / CLAUDE.md), so the policy
 * cannot drift per-preset. A caller-supplied `override` always wins (trusted host
 * code). Otherwise every HUMAN/AUTOMATION surface on a TRUSTED real repo loads
 * them; {@link RULE_LESS_MODES} stay rule-less. Fail-open: a broken/unreadable
 * rule source must never crash session start.
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
  if (RULE_LESS_MODES.has(mode)) return undefined
  return loadRepoRules(cwd).catch(() => undefined)
}
