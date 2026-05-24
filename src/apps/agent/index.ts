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

import { buildSystemPrompt } from "@/agent"
import { defaultIdentityProvider, type IdentityMode } from "@/agent/identity"
import { type LLMPort, pickProvider, tryCreateLLM } from "@/llm"
import { type CapabilityNegotiator, defaultNegotiator, fullNegotiator } from "@/mcp"
import { buildRetrievalStackCore, type RetrievalStack } from "@/runner/assemble"
import { logger, runtimeConfig } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { buildDefaultTools, ToolRegistry } from "@/tool"
import type { AssembleRequest } from "./assemble"
import { type AgentArgs, AgentArgsError, formatHelp, parseAgentArgs } from "./cli-args"
import type { RunOutcome } from "./run"

/** ADR-0198 identity slot — resolve the per-mode identity from the
 *  composition-root env view. Default-OFF: returns `undefined` unless
 *  `QUANTA_IDENTITY=1`. When opted in, `QUANTA_IDENTITY_MODE` selects the
 *  posture (default / plan / review / audit / onboarding); absent ⇒
 *  `"default"`. The single canonical env touchpoint for identity wiring
 *  in the unified-agent surface; mode-presets read `req.base.system` and
 *  never touch the env themselves. */
const resolveIdentityFromEnv = (env: NodeJS.ProcessEnv): readonly string[] | undefined => {
  if (env.QUANTA_IDENTITY !== "1") return undefined
  const raw = env.QUANTA_IDENTITY_MODE ?? "default"
  return defaultIdentityProvider().identityFor(raw as IdentityMode)
}

/** Resolve the retrieval-stack opt-in flag from the composition-root env view.
 *  Single canonical knob — `QUANTA_RETRIEVAL_HYBRID="1"` enables; any other
 *  value (incl. absent / `"0"` / `"true"` — explicit "1" only) ⇒ disabled.
 *  Strict-equals to "1" so a typo like "true" is treated as off (loud
 *  silent-default avoidance: the operator either set the canonical value or
 *  they did not).
 *
 *  ENV-touchpoint discipline: this is the ONLY retrieval-related env read in
 *  the entire codebase. `@/runner/assemble/retrieval.ts` is env-free; the
 *  surface (this file) projects ENV → typed input. */
const isRetrievalHybridEnabled = (env: NodeJS.ProcessEnv): boolean =>
  env.QUANTA_RETRIEVAL_HYBRID === "1"

/** ADR-0196 — pick the MCP capability negotiator from env. `QUANTA_MCP_CAPS=full`
 *  swaps to {@link fullNegotiator} which advertises `{tools, sampling,
 *  elicitation, tasks}`. Any other value (including absent) yields the
 *  byte-identical `{}` default. Single canonical knob; no aliases. */
export const pickMcpNegotiator = (env: NodeJS.ProcessEnv): CapabilityNegotiator =>
  env.QUANTA_MCP_CAPS === "full" ? fullNegotiator() : defaultNegotiator

/** Build the retrieval stack at the composition root. Default-OFF: when the
 *  env knob is absent or not exactly "1", returns `undefined` and every
 *  legacy caller is byte-identical (no allocation, no registry).
 *
 *  Returns `undefined` on builder failure (e.g. an unknown reranker kind
 *  surfaces as a `RetrievalError`); we LOG and continue rather than crashing
 *  the surface entry — the loop is fully functional without the stack, and
 *  blocking startup on a misconfigured optional knob is wrong. */
const buildRetrievalStackFromEnv = (env: NodeJS.ProcessEnv): RetrievalStack | undefined => {
  if (!isRetrievalHybridEnabled(env)) return undefined
  try {
    return buildRetrievalStackCore({ enabled: true })
  } catch (e) {
    logger.warn(
      `retrieval-stack disabled (build failed): ${(e as Error).message}. ` +
        `set QUANTA_RETRIEVAL_HYBRID=1 with a registered reranker to re-enable.`,
    )
    return undefined
  }
}

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
  const retrievalStack = buildRetrievalStackFromEnv(env)
  // ADR-0198 identity slot — when opted in via QUANTA_IDENTITY=1, prebuild
  // the system prompt HERE so every mode-preset (headless / ide / daemon /
  // batch / ci-bot / interactive) sees the identity-baked prompt via
  // `req.base.system`. Default-OFF: identity is `undefined` ⇒ system is the
  // empty-string sentinel and each preset's `req.base.system ?? buildSystemPrompt(cwd)`
  // path runs unchanged (byte-identical).
  const identity = resolveIdentityFromEnv(env)
  const system = identity !== undefined ? buildSystemPrompt(process.cwd(), { identity }) : ""
  return {
    llm,
    // DIP: route through the factory (no app-specific ports at this baseline
    // entry — modes/CLI wire their own fs/diagnostics ports). Behavior is
    // byte-identical to the `defaultTools` singleton.
    registry: new ToolRegistry(buildDefaultTools()),
    stream,
    permission: { mode: "acceptEdits" },
    messages: [],
    system,
    cwd: process.cwd(),
    maxTurns: p.dials?.maxTurns ?? 30,
    signal: new AbortController().signal,
    // ADR-0159 wire: when the operator opted in (QUANTA_RETRIEVAL_HYBRID=1),
    // hand the surface-built stack to every mode runner via the shared base.
    // Absent ⇒ slot is omitted entirely (`exactOptionalPropertyTypes` → no
    // `undefined` literal on the config) and the loop is byte-identical.
    ...(retrievalStack !== undefined ? { retrievalStack } : {}),
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
