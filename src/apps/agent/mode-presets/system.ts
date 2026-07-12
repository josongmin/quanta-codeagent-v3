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
 * WS4 (jul-12 OmO absorption + hell-audit R3) — the ONE place that decides
 * whether a preset loads repo-local rules (AGENTS.md / CLAUDE.md), so the policy
 * cannot drift per-preset. A caller-supplied `override` always wins (a host that
 * already resolved rules, or wants to suppress them). Otherwise every
 * HUMAN/AUTOMATION-driven surface on a real repo loads them; only `batch` (the
 * hermetic bench sandbox) stays rule-less + byte-identical. Fail-open: a broken
 * or unreadable rule source must never crash session start.
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
  if (mode === "batch") return undefined
  return loadRepoRules(cwd).catch(() => undefined)
}
