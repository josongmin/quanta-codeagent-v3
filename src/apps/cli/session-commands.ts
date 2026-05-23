/**
 * CLI surface shim for the surface-agnostic `@/runner/session-ops` slice.
 *
 * Phase-3 of the surface decomposition (RFC may-22): the dispatcher itself
 * (argv routing + all subcommand bodies except `import`) lives in
 * `src/runner/session-ops/index.ts`. That slice is forbidden from importing
 * `@/migration` (biome rule, ADR-0038/runner-slice §): the migration-translator
 * is a one-off surface concern, not a Layer-2 orchestration concern.
 *
 * This shim wires the CLI-side migration handler (`runImport` + import-log
 * append) into the runner via `deps.importHandler` so consumers (`repl.ts`,
 * the CLI-scoped unit + integration tests) keep their existing
 * `runSessionCommand(args, deps)` contract — byte-identical default-OFF.
 *
 * Removing this shim later is a one-line touch at each call site (switch the
 * import path to `@/runner/session-ops` and pass `importHandler: makeCliImportHandler()`
 * yourself). See the closing PR for the receiver list.
 */
import { homedir } from "node:os"
import {
  appendImportLog,
  type ExternalAgentProvider,
  type ImportEvent,
  runImport,
} from "@/migration"
import {
  runSessionCommand as runSessionCommandInner,
  type SessionCommandDeps,
} from "@/runner/session-ops"

export type { SessionCommandDeps } from "@/runner/session-ops"

/** Providers the `import` subcommand accepts. `unknown` is intentionally
 *  excluded — it is a typed sentinel, never a user-supplied value. */
const IMPORT_PROVIDERS: readonly Exclude<ExternalAgentProvider, "unknown">[] = [
  "claude_code",
  "cursor",
  "aider",
]

const hasFlag = (args: string[], flag: string): boolean => args.includes(flag)
const errLine = (verb: string, reason: string): string => `session ${verb}: ${reason}\n`

/** CLI `session import` handler. Wired into the runner slice via
 *  `deps.importHandler` so `@/runner/session-ops` does not depend on
 *  `@/migration` (slice isolation). The body is verbatim from the prior
 *  inline `cmdImport` so behavior is byte-identical for callers. */
const cliImportHandler = async (args: string[], deps: SessionCommandDeps): Promise<number> => {
  // checkUnknownArgs lives in the runner slice; for the import-only case the
  // arg shape is fixed (one positional + one boolean flag), so we inline a
  // minimal equivalent rather than re-export the helper through the slice
  // boundary just for this surface adapter.
  const allowedBool = new Set(["--no-skills"])
  const consumed = new Set<number>()
  let positional = 0
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (allowedBool.has(a)) {
      consumed.add(i)
      continue
    }
    if (positional < 1) {
      positional += 1
      consumed.add(i)
      continue
    }
    deps.err(errLine("import", `unexpected argument: ${a}`))
    return 1
  }

  const provider = args.find((a) => !a.startsWith("--"))
  if (provider === undefined) {
    deps.err(errLine("import", "missing <provider> (claude_code | cursor | aider)"))
    return 1
  }
  if (!IMPORT_PROVIDERS.includes(provider as Exclude<ExternalAgentProvider, "unknown">)) {
    deps.err(
      errLine("import", `unknown provider: ${provider} (expected claude_code | cursor | aider)`),
    )
    return 1
  }
  const home = deps.homeDir ?? homedir()
  const includeSkills = !hasFlag(args, "--no-skills")

  const events: ImportEvent[] = []
  const result = await runImport(
    provider as Exclude<ExternalAgentProvider, "unknown">,
    { homeDir: home, includeSkills },
    (e) => events.push(e),
  )

  const ok = result.errors.length === 0
  // Record the run in the persisted import log (best-effort; a busy-lock or
  // write error is surfaced but does not change the import's own exit code,
  // which reflects whether the translation succeeded).
  try {
    await appendImportLog(home, {
      timestamp: new Date().toISOString(),
      provider: result.provider,
      stage: "import_finished",
      ok,
      detail: `sessions=${result.sessionsImported}, skills=${result.skillsImported}`,
    })
  } catch (e) {
    deps.err(`session import: warning: failed to write import log: ${(e as Error).message}\n`)
  }

  if (!ok) {
    deps.err(errLine("import", `failed: ${result.errors.join("; ")}`))
    return 1
  }
  deps.out(
    `imported ${result.provider}: ${result.sessionsImported} session(s), ${result.skillsImported} skill(s)\n`,
  )
  return 0
}

/** CLI `quanta session …` entry point — preserves the prior signature so
 *  every existing caller (`repl.ts`, unit + integration tests) keeps working
 *  with no edits. We inject `cliImportHandler` here so `import` continues to
 *  function on the CLI surface. */
export const runSessionCommand = async (
  args: string[],
  deps: SessionCommandDeps,
): Promise<number> =>
  runSessionCommandInner(args, {
    ...deps,
    importHandler: deps.importHandler ?? cliImportHandler,
  })
