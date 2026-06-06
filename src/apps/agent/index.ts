/**
 * `apps/agent/index.ts` — RFC may-22-unified-agent-runtime / Phase 4 entry.
 *
 * The single argv→mode dispatcher. Owns ZERO mode wiring: each mode-preset
 * module under `./mode-presets/<mode>.ts` exports its own `runMode(req)` and
 * builds its own surface-specific AgentConfig core. The entry just routes.
 *
 * Hard rules (RFC may-22 / Phase 4):
 *  • NO scattered `process.env.X` reads here. `runtimeConfig()` owns the
 *    typed env knobs; provider/key resolution is delegated to the `@/llm`
 *    factory, which receives `process.env` ONCE at this composition root
 *    (the factory itself never touches the global env — see factory.ts).
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

import { join } from "node:path"
import { buildSearchPipelineFromEnv, clearSearchPipelineWireForTests } from "@/runner/assemble"
import { loadEnvFiles } from "@/shared/env-files"

loadEnvFiles([".env.dev", ".env.local", ".env"])

import { loadNamedAgents } from "@/agent"
import { loadCommandHookBindings } from "@/agent/command-hooks"
// ADR-0303 thin-surface relocation — the env-READING "argv → AgentConfig base"
// composition builder + the pure argv parser moved DOWN into `@/host/runtime`
// so `apps/cli`'s `batch` subcommand reaches them without a sideways
// `cli → apps/agent` cross-surface import. This surface entry imports the
// symbols `runMain`/`liftToAssembleRequest` still call (a surface reaching DOWN
// into `@/host` is allowed) and re-exports the full public API below so the
// existing `@/apps/agent` barrel importers (mode-presets + the unit/hellgate
// tests) are byte-identical.
import {
  type AssembleRequestPartial,
  buildBaseFromArgs,
  resolveLocalEnvSelection,
  toAssembleRequest,
} from "@/host/runtime/agent-arg-builder"
import {
  type AgentArgs,
  AgentArgsError,
  formatHelp,
  parseAgentArgs,
} from "@/host/runtime/agent-args"
import { errMessage, gateOn, runtimeConfig, setTerminalIo } from "@/shared"
import type { AssembleRequest } from "./assemble"

export { buildSearchPipelineFromEnv, clearSearchPipelineWireForTests }

import type { RunOutcome } from "./run"

setTerminalIo({
  stdout: (chunk) => {
    void process.stdout.write(chunk)
  },
  stderr: (chunk) => {
    void process.stderr.write(chunk)
  },
  stdoutIsTTY: process.stdout.isTTY,
  stderrIsTTY: process.stderr.isTTY,
})

export {
  assembleMemoryAuto,
  buildProfileDefinitionRegistry,
  installCommandHooksIntoBase,
  PERMISSION_PROFILE_SESSION_THREAD,
  pickMcpNegotiator,
  resolveLayeredProfileSlots,
  resolveObservabilityWire,
  resolvePermissionModeFromProfile,
  resolvePermissionProfileManager,
  resolvePolicyMergeStrategy,
} from "@/host/runtime/agent-arg-builder"
export type {
  IdentityModeToken,
  PermissionProfileToken,
  ProviderToken,
  ToolProfileToken,
} from "@/host/runtime/agent-args"
// ADR-0303 thin-surface relocation — re-export the moved composition-builder +
// parser symbols so existing `@/apps/agent` barrel importers (mode-presets and
// the unit/hellgate tests) resolve them unchanged. The definitions now live in
// `@/host/runtime/{agent-arg-builder,agent-args}`. Symbols `runMain` already
// imports above are re-exported as LOCAL bindings; the rest are pass-through
// `export … from` re-exports.
export type { AgentArgs, AssembleRequestPartial }
export {
  AgentArgsError,
  buildBaseFromArgs,
  formatHelp,
  parseAgentArgs,
  resolveLocalEnvSelection,
  toAssembleRequest,
}

const applyModeSpecificRequestFields = (out: AssembleRequest, p: AssembleRequestPartial): void => {
  if (p.mode === "headless" && p.prompt !== undefined) {
    // P26 — fold the structured-output flags onto HeadlessExtras. Absent ⇒ each
    // spread is `{}` ⇒ `out.headless` is exactly `{ prompt }` as before (the
    // byte-identical legacy text path).
    out.headless = {
      prompt: p.prompt,
      ...(p.outputFormat ? { output: p.outputFormat } : {}),
      ...(p.includePartial ? { includePartial: true } : {}),
    }
    return
  }
  if (p.mode === "batch" && p.corpus !== undefined) {
    out.batch = {
      corpus: p.corpus,
      ...(p.instance !== undefined ? { instance: p.instance } : {}),
      ...(p.predictions !== undefined ? { predictionsPath: p.predictions } : {}),
      ...(p.report !== undefined ? { reportPath: p.report } : {}),
    }
    return
  }
  if (p.mode === "ci-bot" && p.pr !== undefined) {
    out.ciBot = { pr: p.pr, ...(p.ciBotDryRun ? { dryRun: true } : {}) }
  }
}

/** Per-mode dispatcher contract. Each `./mode-presets/<mode>.ts` exports this. */
export interface ModeDispatcher {
  runMode: (req: AssembleRequest) => Promise<RunOutcome>
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
  /** T01 (audit L5 H-2): test seam to inject the cancellation signal instead of
   *  letting `runMain` own a SIGINT-wired controller. Tests that don't want a
   *  real `process.on("SIGINT")` side effect pass their own signal here. */
  signal?: AbortSignal
}

/** Default loader — dynamic import keeps `index.ts` decoupled from preset shape. */
const defaultLoadDispatcher = async (mode: AssembleRequest["mode"]): Promise<ModeDispatcher> => {
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
  const partial = toAssembleRequest(args)
  // ADR-0455 jun-02 wire — load the local-env config at the async composition
  // root and thread the resolved selection onto the partial. Default-OFF: no
  // config / no selection ⇒ field stays absent ⇒ ambient env byte-identical.
  const localEnvSelection = await resolveLocalEnvSelection(process.env, process.cwd())
  if (localEnvSelection !== undefined) partial.localEnv = localEnvSelection
  // ADR-0454 jun-02 wire — load command-hook bindings from settings.json#hooks at
  // the async root, ONLY when opted in, and thread onto the partial. Default-OFF:
  // knob unset ⇒ not loaded ⇒ no command hooks. The enabled-without-ack fail-fast
  // throw happens later in buildBaseFromArgs (startup, never mid-turn).
  if (gateOn(process.env, "QUANTA_COMMAND_HOOKS")) {
    partial.commandHookBindings = await loadCommandHookBindings(
      join(process.cwd(), "settings.json"),
    )
  }
  // Named-agent registry — load `.quanta/agents` (+ native dir) ONCE per session
  // at the async root and thread the resolver onto the partial; `buildBaseFromArgs`
  // lifts it onto `AgentConfig.namedAgentResolver` (read by the subagent runner per
  // spawn). Default-OFF byte-identical: no agent dir ⇒ EMPTY registry ⇒ field stays
  // absent ⇒ no named agent ever resolves. FAIL-OPEN: the loader already swallows an
  // absent/unreadable dir, but we guard defensively so a registry-load fault can
  // NEVER throw on the assembly path — a thrown loader yields an empty resolver.
  const namedAgents = await loadNamedAgents(process.cwd()).catch(() => undefined)
  if (namedAgents !== undefined && namedAgents.size > 0) {
    partial.namedAgentResolver = namedAgents
  }

  // T01 (audit L5 H-2 / M-6): the composition root owns ONE real cancellation
  // controller and wires SIGINT to it exactly once — previously every preset
  // inherited a dead `new AbortController().signal` so Ctrl+C was silently
  // ignored in 5 of 6 modes. Tests inject `deps.signal` to avoid the real
  // `process.on` side effect; production installs the handler and detaches it
  // in `finally` so a long-lived host process never leaks listeners.
  let owned: AbortController | undefined
  let signal: AbortSignal
  let onSigint: (() => void) | undefined
  if (deps.signal !== undefined) {
    signal = deps.signal
  } else {
    owned = new AbortController()
    signal = owned.signal
    onSigint = (): void => owned?.abort()
    process.on("SIGINT", onSigint)
  }

  // Translate flat CLI shape → nested AssembleRequest the runners consume
  // (each runner reads its own mode-specific extras: req.headless / req.batch
  // / req.ciBot). The `base` is a stub — runners build the real AgentConfig
  // internally; assemble.ts only needs `base` populated for modePolicy +
  // budgetMeter, which the runners assemble themselves.
  // L5 M-11 — process-lifetime disposer registry. The search wire built inside
  // `buildBaseFromArgs` pushes its per-wire `dispose` (delta-scan setInterval +
  // indexer) here; `runMain` runs each in `finally` so this composition root
  // tears down THE wire it built, threaded per-process instead of via the
  // module singleton. Each disposer is idempotent + surfaces (does not rethrow)
  // its failure so one leaky teardown cannot mask the SIGINT-listener detach.
  const disposers: Array<() => void> = []
  const fullReq = liftToAssembleRequest(partial, signal, disposers)
  try {
    const outcome = await dispatcher.runMode(fullReq)
    exit(outcome.exitCode)
  } finally {
    runProcessDisposers(disposers, stderr)
    if (onSigint !== undefined) process.off("SIGINT", onSigint)
  }
}

/** L5 M-11 — run each process-lifetime disposer (today: the search wire's
 *  delta-scan interval + indexer teardown) exactly once on shutdown. Each is
 *  idempotent; a throw is surfaced to stderr (NOT rethrown) so one leaky
 *  teardown cannot mask the rest or the SIGINT-listener detach. Kept as a free
 *  function so the loop lives OUTSIDE `runMain`'s cognitive-complexity budget. */
const runProcessDisposers = (
  disposers: ReadonlyArray<() => void>,
  stderr: (s: string) => void,
): void => {
  for (const dispose of disposers) {
    try {
      dispose()
    } catch (e) {
      stderr(`[teardown] search wire dispose failed: ${errMessage(e)}\n`)
    }
  }
}

/** Translate the flat CLI projection to the nested AssembleRequest shape
 *  the mode runners consume. Per-mode extras are populated only for the
 *  active mode; other slots stay undefined. The `base` is populated with
 *  an LLM built from provider/model (operator flags + env API keys) so the
 *  per-mode runner can rely on `req.base.llm` being a real adapter. */
const liftToAssembleRequest = (
  p: AssembleRequestPartial,
  signal?: AbortSignal,
  /** L5 M-11 — forwarded to `buildBaseFromArgs` so the search wire's teardown
   *  is collected for the composition root to run on process shutdown. */
  disposers?: Array<() => void>,
): AssembleRequest => {
  const base = buildBaseFromArgs(p, signal, disposers)
  const out: AssembleRequest = { mode: p.mode, base }
  if (p.dials !== undefined) out.dials = p.dials
  if (p.exhaustion !== undefined) out.exhaustion = p.exhaustion
  applyModeSpecificRequestFields(out, p)
  return out
}

// Production entry — only fires when this module is the process entry point.
// We guard so `import "./index"` in tests does NOT trigger the real loop.
// `import.meta.main` is the Bun-native check (also true under `bun run`).
if (import.meta.main) {
  runMain().catch((e) => {
    process.stderr.write(`fatal: ${errMessage(e)}\n`)
    // ADR-0303 — honor a typed launcher error's exit code (e.g.
    // ProviderKeyMissingError ⇒ 2, preserving the prior missing-credentials
    // POSIX exit); generic errors stay exit 1.
    const code =
      typeof (e as { exitCode?: unknown })?.exitCode === "number"
        ? (e as { exitCode: number }).exitCode
        : 1
    process.exit(code)
  })
}
