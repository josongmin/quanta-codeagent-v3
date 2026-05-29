/**
 * CLI surface adapter — `session import` handler factory.
 *
 * Wires the migration translator into the surface-agnostic
 * `@/runner/session-ops` slice via `SessionCommandDeps#importHandler`. The
 * runner slice is FORBIDDEN from importing `@/migration` (slice isolation,
 * ADR-0038), so the CLI surface injects this handler at the call site.
 *
 * Extracted from the now-deleted `src/apps/cli/session-commands.ts` shim
 * (CLI-05, ADR-0305). Body is verbatim — behavior is byte-identical for
 * existing callers.
 */
import { homedir } from "node:os"
import {
  appendImportLog,
  type ExternalAgentProvider,
  type ImportEvent,
  runImport,
} from "@/migration"
import type { SessionCommandDeps } from "@/runner/session-ops"
import { errMessage } from "@/shared"

/** Concrete (non-optional) shape of the runner's optional importHandler.
 *  We export this so factory consumers get a non-undefined type — the
 *  runner field is `(...) => Promise<number> | undefined`, but the factory
 *  always returns a callable. */
type ImportHandlerFn = (args: string[], deps: SessionCommandDeps) => Promise<number>

/** Providers the `import` subcommand accepts. `unknown` is intentionally
 *  excluded — it is a typed sentinel, never a user-supplied value. */
const IMPORT_PROVIDERS: readonly Exclude<ExternalAgentProvider, "unknown">[] = [
  "claude_code",
  "cursor",
  "aider",
]

const hasFlag = (args: string[], flag: string): boolean => args.includes(flag)
const errLine = (verb: string, reason: string): string => `session ${verb}: ${reason}\n`

/** CLI `session import` handler body. Same shape as
 *  `SessionCommandDeps["importHandler"]` (typed via runner slice). */
const cliImportHandler: ImportHandlerFn = async (args, deps) => {
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
  // Record the translation audit in the persisted import log (best-effort; a
  // busy-lock or write error is surfaced but does not change the command's
  // own exit code, which reflects whether the translation scan succeeded).
  try {
    await appendImportLog(home, {
      timestamp: new Date().toISOString(),
      provider: result.provider,
      stage: "import_finished",
      ok,
      detail: `translated_sessions=${result.sessionsTranslated}, counted_skills=${result.skillsCounted}, persisted_sessions=0`,
    })
  } catch (e) {
    deps.err(`session import: warning: failed to write import log: ${errMessage(e)}\n`)
  }

  if (!ok) {
    deps.err(errLine("import", `failed: ${result.errors.join("; ")}`))
    return 1
  }
  deps.out(
    `translated ${result.provider}: ${result.sessionsTranslated} session transcript(s), ${result.skillsCounted} skill file(s); no local sessions persisted\n`,
  )
  return 0
}

/** Factory — returns the CLI `session import` handler ready to be injected
 *  into `SessionCommandDeps#importHandler`. The return type is the concrete
 *  callable (not the runner's optional alias) so callers can assign it
 *  under `exactOptionalPropertyTypes: true` without `| undefined` leakage.
 *
 *  Callers (`repl.ts`, tests) just write
 *  `importHandler: createCliImportHandler()`. */
export const createCliImportHandler = (): ImportHandlerFn => cliImportHandler
