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

import { loadEnvFiles } from "../cli/dotenv"

loadEnvFiles([".env.dev", ".env.local", ".env"])

import { type LLMPort, pickProvider, tryCreateLLM } from "@/llm"
import { logger, runtimeConfig } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { buildDefaultTools, ToolRegistry } from "@/tool"
import type { AssembleRequest } from "./assemble"
import { type AgentArgs, AgentArgsError, formatHelp, parseAgentArgs } from "./cli-args"
import type { RunOutcome } from "./run"

/** Build the `AgentConfig` base from CLI args. Per-mode runners can override
 *  individual fields (e.g. ci-bot replaces `registry` with the restricted
 *  git+gh tool set), but having a baseline avoids each runner duplicating
 *  the LLM construction logic.
 *
 *  Provider pick + key lookup + adapter construction are delegated to the
 *  shared `@/llm` factory (OCP/DIP). `process.env` is handed to the factory
 *  HERE — the single composition-root touchpoint — so the factory stays env-
 *  agnostic and the canonical {@link DEFAULT_MODEL} (no local copy) is used. */
const buildBaseFromArgs = (p: AssembleRequestPartial): AssembleRequest["base"] => {
  // QUANTA_PROVIDER drives the factory pick; an explicit `--provider` flag must
  // still win, so seed it into the env view the factory reads.
  const env =
    p.provider !== undefined ? { ...process.env, QUANTA_PROVIDER: p.provider } : process.env
  const provider = pickProvider(env)
  // model omitted ⇒ factory fills canonical DEFAULT_MODEL[provider].
  const llm: LLMPort | null = tryCreateLLM(
    provider,
    p.model !== undefined ? { model: p.model } : {},
    env,
  )
  if (llm === null) {
    logger.error(
      `no API key for provider '${provider}'. Set OPENAI_API_KEY or ANTHROPIC_API_KEY (or --provider <other>).`,
    )
    process.exit(2)
  }
  // Minimal stream — error events surface to stderr so a wrapper failure is
  // diagnosable even when a runner doesn't replace the stream. Per-mode
  // runners typically override with their own observability (REPL stdout,
  // structured JSONL, etc).
  const stream: StreamPort = {
    emit: (e: AgentEvent): void => {
      if (e.type === "error") {
        process.stderr.write(`[stream-error] ${JSON.stringify(e)}\n`)
      }
    },
  }
  return {
    llm,
    // DIP: route through the factory (no app-specific ports at this baseline
    // entry — modes/CLI wire their own fs/diagnostics ports). Behavior is
    // byte-identical to the `defaultTools` singleton.
    registry: new ToolRegistry(buildDefaultTools()),
    stream,
    permission: { mode: "acceptEdits" },
    messages: [],
    system: "",
    cwd: process.cwd(),
    maxTurns: p.dials?.maxTurns ?? 30,
    signal: new AbortController().signal,
  } as AssembleRequest["base"]
}

/** Per-mode dispatcher contract. Each `./mode-presets/<mode>.ts` exports this. */
export interface ModeDispatcher {
  runMode: (req: AssembleRequest) => Promise<RunOutcome>
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
  predictions?: string
  report?: string
  pr?: string
  /** ci-bot only: stub the PR comment write at the runner edge. */
  ciBotDryRun?: boolean
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
  if (args.predictions !== undefined) out.predictions = args.predictions
  if (args.report !== undefined) out.report = args.report
  if (args.pr !== undefined) out.pr = args.pr
  if (args.ciBotDryRun) out.ciBotDryRun = true
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
  // Translate flat CLI shape → nested AssembleRequest the runners consume
  // (each runner reads its own mode-specific extras: req.headless / req.batch
  // / req.ciBot). The `base` is a stub — runners build the real AgentConfig
  // internally; assemble.ts only needs `base` populated for modePolicy +
  // budgetMeter, which the runners assemble themselves.
  const fullReq = liftToAssembleRequest(partial)
  const outcome = await dispatcher.runMode(fullReq)
  exit(outcome.exitCode)
}

/** Translate the flat CLI projection to the nested AssembleRequest shape
 *  the mode runners consume. Per-mode extras are populated only for the
 *  active mode; other slots stay undefined. The `base` is populated with
 *  an LLM built from provider/model (operator flags + env API keys) so the
 *  per-mode runner can rely on `req.base.llm` being a real adapter. */
const liftToAssembleRequest = (p: AssembleRequestPartial): AssembleRequest => {
  const base = buildBaseFromArgs(p)
  const out: AssembleRequest = { mode: p.mode, base }
  if (p.dials !== undefined) out.dials = p.dials
  if (p.exhaustion !== undefined) out.exhaustion = p.exhaustion
  if (p.mode === "headless" && p.prompt !== undefined) {
    out.headless = { prompt: p.prompt }
  } else if (p.mode === "batch" && p.corpus !== undefined) {
    out.batch = {
      corpus: p.corpus,
      ...(p.instance !== undefined ? { instance: p.instance } : {}),
      ...(p.predictions !== undefined ? { predictionsPath: p.predictions } : {}),
      ...(p.report !== undefined ? { reportPath: p.report } : {}),
    }
  } else if (p.mode === "ci-bot" && p.pr !== undefined) {
    out.ciBot = { pr: p.pr, ...(p.ciBotDryRun ? { dryRun: true } : {}) }
  }
  return out
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
