/**
 * `ci-bot` mode preset wiring — RFC may-22 Phase 5.
 *
 * Bridges the data-only `MODE_PRESETS["ci-bot"]` into a runnable AgentConfig:
 *
 *   - toolSurface  ⇒ ci-safe tool set = defaultTools (read/edit/grep/bash/
 *                    test_runner) + gitTools + ghTools. NO MCP, NO hooks,
 *                    NO write-to-host-fs outside workspace.
 *   - promptPack   ⇒ pr-agent rules already wired via prompt.ts opt.
 *   - gitWrite     ⇒ branch-only — exposed for the dispatch seam to consult
 *                    when bash invokes git.
 *   - network      ⇒ allowlist — same.
 *   - secrets      ⇒ CI-scoped — `scrubEnv` with CI-only allowlist.
 *
 * This file is the SINGLE place that knows ci-bot's concrete wiring. New
 * lever implementations land here (e.g. when ci-bot adds a webhook hook).
 */
import { defaultGitRunner, gitTools } from "@/tool"
import { defaultGhRunner, ghTools, type GhRunner } from "@/tool/gh"
import { CI_BOT_DEFAULT_ALLOWLIST } from "@/runtime/network-allowlist"
import { DEFAULT_PROTECTED_BRANCHES, decideBranchOnly } from "@/permission/branch-only"
import type { Tool } from "@/tool"

/** CI-scoped env var allowlist. Excludes user secrets (OPENAI_API_KEY etc).
 *  Includes only what `gh` and the test runners need. */
export const CI_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  // runtime essentials
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  // GitHub auth
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_REPOSITORY",
  "GITHUB_REF",
  "GITHUB_SHA",
  "GITHUB_ACTIONS",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_NUMBER",
  "GITHUB_WORKFLOW",
  // git config
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
])

/** Per-process options the ci-bot preset accepts (operator-tunable). */
export interface CiBotPresetOptions {
  /** Override the gh CLI runner (tests inject a fake). */
  ghRunner?: GhRunner
  /** Extra hosts to allow beyond the CI default. */
  extraAllowedHosts?: readonly string[]
  /** Extra branches to mark protected (beyond main/master/develop/production). */
  extraProtectedBranches?: readonly string[]
}

export interface CiBotWiring {
  /** Tool set to register in the agent's ToolRegistry. */
  tools: Tool[]
  /** Effective network allowlist (default + operator extras, deduped). */
  networkAllowlist: readonly string[]
  /** Effective protected-branch list. */
  protectedBranches: readonly string[]
  /** CI-scoped env allowlist for child processes (scrubEnv argument). */
  envAllowlist: readonly string[]
  /** Propositional helper: is this bash command allowed under branch-only? */
  isGitWriteAllowed: (command: string, currentBranch?: string) => boolean
  /** Diagnostic helper — the reason a command was rejected. */
  branchOnlyReason: (command: string, currentBranch?: string) => string | undefined
}

const dedupe = (a: readonly string[], b: readonly string[]): readonly string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of [...a, ...b]) {
    if (!seen.has(x)) {
      seen.add(x)
      out.push(x)
    }
  }
  return Object.freeze(out)
}

/** Build the ci-bot wiring bundle. Pure: returns a frozen plan; the caller
 *  feeds the tool list into `apps/agent/assemble.ts` and the helpers into
 *  the dispatch seam. */
export const buildCiBotWiring = (opts: CiBotPresetOptions = {}): CiBotWiring => {
  const allowlist = dedupe(CI_BOT_DEFAULT_ALLOWLIST, opts.extraAllowedHosts ?? [])
  const branches = dedupe(DEFAULT_PROTECTED_BRANCHES, opts.extraProtectedBranches ?? [])
  const tools: Tool[] = [...gitTools(defaultGitRunner), ...ghTools(opts.ghRunner ?? defaultGhRunner)]

  return Object.freeze({
    tools,
    networkAllowlist: allowlist,
    protectedBranches: branches,
    envAllowlist: CI_ENV_ALLOWLIST,
    isGitWriteAllowed: (command: string, currentBranch?: string) =>
      decideBranchOnly(command, branches, currentBranch).allowed,
    branchOnlyReason: (command: string, currentBranch?: string) => {
      const v = decideBranchOnly(command, branches, currentBranch)
      return v.allowed ? undefined : v.reason
    },
  })
}
