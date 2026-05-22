/**
 * `apps/agent/index.ts` — RFC may-22-unified-agent-runtime / Phase 4 entry.
 *
 * The single argv→mode dispatcher. Owns ZERO mode wiring: each mode-preset
 * module under `./mode-presets/<mode>.ts` exports its own `runMode(req)` and
 * builds its own surface-specific AgentConfig core. The entry just routes.
 *
 * Hard rules (RFC may-22 / Phase 4):
 *  • NO `process.env.X` reads here. Env values come from `runtimeConfig()`.
 *  • NO silent defaults. Defaults flow from `BUDGET_PRESETS` via
 *    `assembleAgentConfig`, not from this file.
 *  • mode-presets are loaded via DYNAMIC import so this file is decoupled
 *    from Worker B's per-mode wiring contract (different presets ship at
 *    different times).
 *
 * Exit codes are owned by `./run.ts` (POSIX-style); this file only emits
 *   • exit 64 (EX_USAGE) on argv error, plus a usage dump to stderr;
 *   • exit 0 on `--help` (after a usage dump to stdout).
 */

import { runtimeConfig } from "@/shared"
import type { AssembleRequest } from "./assemble"
import { type AgentArgs, AgentArgsError, formatHelp, parseAgentArgs } from "./cli-args"
import type { RunOutcome } from "./run"

/** Per-mode dispatcher contract. Each `./mode-presets/<mode>.ts` exports this. */
export interface ModeDispatcher {
  runMode: (req: AssembleRequestPartial) => Promise<RunOutcome>
}

/**
 * What `index.ts` hands a mode-preset: a partial AssembleRequest (no `base` —
 * the preset constructs its own surface-specific base) plus the mode-specific
 * fields lifted off {@link AgentArgs}. The preset is responsible for building
 * `AssembleRequest.base` and calling `assembleAgentConfig`.
 */
export interface AssembleRequestPartial {
  mode: AssembleRequest["mode"]
  dials: AssembleRequest["dials"]
  exhaustion?: AssembleRequest["exhaustion"]
  model?: string
  provider?: "openai" | "anthropic"
  prompt?: string
  corpus?: string
  instance?: string
  pr?: string
}

/** Lift mode + dials + per-mode fields out of `AgentArgs`. Pure projection. */
export const toAssembleRequest = (args: AgentArgs): AssembleRequestPartial => {
  const out: AssembleRequestPartial = {
    mode: args.mode,
    dials: args.dials,
  }
  if (args.exhaustion !== undefined) out.exhaustion = args.exhaustion
  if (args.model !== undefined) out.model = args.model
  if (args.provider !== undefined) out.provider = args.provider
  if (args.prompt !== undefined) out.prompt = args.prompt
  if (args.corpus !== undefined) out.corpus = args.corpus
  if (args.instance !== undefined) out.instance = args.instance
  if (args.pr !== undefined) out.pr = args.pr
  return out
}

/**
 * Test seam — `runMain` accepts injected `argv`, `loadDispatcher`, and IO
 * sinks so unit tests can route to spy dispatchers without forking a process.
 */
export interface MainDeps {
  argv?: readonly string[]
  loadDispatcher?: (mode: AssembleRequest["mode"]) => Promise<ModeDispatcher>
  stdout?: (s: string) => void
  stderr?: (s: string) => void
  exit?: (code: number) => void
}

/** Default loader — dynamic import keeps `index.ts` decoupled from preset shape. */
const defaultLoadDispatcher = async (
  mode: AssembleRequest["mode"],
): Promise<ModeDispatcher> => {
  const mod = (await import(`./mode-presets/${mode}`)) as ModeDispatcher
  return mod
}

/**
 * The entry function. Pure routing — every effectful concern (IO, exit) is
 * injectable via {@link MainDeps}. Production caller at the bottom of this
 * file wires the defaults: real argv, dynamic import, stdout/stderr writers,
 * `process.exit`.
 */
export const runMain = async (deps: MainDeps = {}): Promise<void> => {
  // Touch runtimeConfig once so any startup-validation env errors surface
  // here (not deep inside a mode-preset). Result is intentionally unused —
  // we only want the validator side-effect of `loadFromEnv`. This is the
  // ONLY env touchpoint in this file, and it goes through `@/shared`.
  runtimeConfig()

  const argv = deps.argv ?? process.argv.slice(2)
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s))
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s))
  const exit = deps.exit ?? ((code) => process.exit(code))
  const loadDispatcher = deps.loadDispatcher ?? defaultLoadDispatcher

  let args: AgentArgs
  try {
    args = parseAgentArgs(argv)
  } catch (e) {
    if (e instanceof AgentArgsError) {
      stderr(`${e.message}\n${formatHelp()}\n`)
      exit(64) // POSIX EX_USAGE
      return
    }
    throw e
  }

  if (args.help) {
    stdout(formatHelp())
    return
  }

  const dispatcher = await loadDispatcher(args.mode)
  const req = toAssembleRequest(args)
  const outcome = await dispatcher.runMode(req)
  exit(outcome.exitCode)
}

// Production entry — only fires when this module is the process entry point.
// We guard so `import "./index"` in tests does NOT trigger the real loop.
// `import.meta.main` is the Bun-native check (also true under `bun run`).
if (import.meta.main) {
  runMain().catch((e) => {
    process.stderr.write(`fatal: ${(e as Error).message}\n`)
    process.exit(1)
  })
}
