/**
 * `@/sdk/embed` — `createAnalysisAgent`: the batteries-included façade over
 * quanta's agent loop (Phase 2). Hides the 133-field `AgentConfig` behind ~10
 * options; `runAgent` is the main loop.
 *
 * Assembly path is env-PURE (audit G): we call the host assembler
 * `@/host/runtime/agent-config-assembler#assembleAgentConfig(req, env)`
 * directly, NOT the `@/apps/agent/assemble` shim that binds `process.env`.
 */

import { buildSystemPrompt, MODE_PRESETS, runAgent, wireOptionalAgentPorts } from "@/agent"
import { buildNetworkDispatchGuard, type DispatchGuard } from "@/agent/dispatch-guard"
import { assembleAgentConfig } from "@/host/runtime/agent-config-assembler"
import { type LLMPort, type Message, type Provider, pickProvider, tryCreateLLM } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { RuntimeAgentConfigBase } from "@/sdk/runtime"
import type { AgentEvent } from "@/stream"
import { buildDefaultTools, type Tool, ToolRegistry } from "@/tool"
import { NoCredentialError, ToolRegistrationError } from "./errors"
import {
  type AnalysisProfile,
  DEFAULT_PROFILE,
  isReadOnlyProfile,
  modeForProfile,
} from "./profiles"
import { type AgentRun, makeAgentRun, type RunHooks } from "./run"

export interface AnalysisAgentOptions {
  /** Repo root the agent analyses (also the tool sandbox cwd). */
  cwd: string
  /** Model id, e.g. `"claude-opus-4-8"`. */
  model: string

  // ── LLM (pick one; precedence llm > apiKey/env) ──
  /** Inject your own LLM stack. When set, `apiKey`/`env`/`provider` are ignored. */
  llm?: LLMPort
  /** Provider API key. When omitted, resolved from `env`. */
  apiKey?: string
  /** Provider to build. When omitted, resolved from `env` via `pickProvider`
   *  (which does NOT consult `apiKey`) — set this to pair an explicit `apiKey`
   *  with the RIGHT provider instead of whatever the env happens to select. */
  provider?: Provider
  /** Environment view for provider resolution. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv

  // ── Tools ──
  /** Your analysis tools (author via `defineTool`). A tool whose `name`
   *  collides with a default tool OVERRIDES the default; duplicate names WITHIN
   *  this list throw `ToolRegistrationError`. */
  tools?: readonly Tool[]
  /** Merge your tools with quanta's default tool set. Default `true`. */
  includeDefaultTools?: boolean

  // ── Execution policy ──
  /** Capability profile. Default `"analysis"`. */
  profile?: AnalysisProfile
  /** Max agent turns. Default `200`. */
  maxTurns?: number
  /** System prompt override. Default `buildSystemPrompt(cwd)`. */
  system?: string
  /** Context prepended before the run prompt. */
  seedMessages?: readonly Message[]

  // ── Observation ──
  /** Low-level raw event sink (runs alongside `run(prompt, hooks)`). */
  onEvent?: (e: AgentEvent) => void
  /** Async-iteration buffer cap (drop-oldest past it). */
  eventBufferSize?: number
}

export interface AnalysisAgent {
  /** Run one prompt as a full agent session. The returned handle is both an
   *  `AsyncIterable<AgentEvent>` and a `PromiseLike<AgentOutcome>`. */
  run(prompt: string, hooks?: RunHooks): AgentRun
  /** Cancel EVERY in-flight run (each surfaces as `outcome.reason ===
   *  "aborted"`). */
  abort(): void
}

const resolveLlm = (opts: AnalysisAgentOptions, env: NodeJS.ProcessEnv): LLMPort => {
  if (opts.llm !== undefined) return opts.llm
  const provider = opts.provider ?? pickProvider(env)
  const llm = tryCreateLLM(
    provider,
    opts.apiKey !== undefined ? { model: opts.model, apiKey: opts.apiKey } : { model: opts.model },
    env,
  )
  if (llm === null) {
    throw new NoCredentialError(
      `no LLM provided and no credential for provider "${provider}" (set opts.llm, opts.apiKey (+ opts.provider), or the provider env var)`,
    )
  }
  return llm
}

const resolveRegistry = (opts: AnalysisAgentOptions, profile: AnalysisProfile): ToolRegistry => {
  const custom = opts.tools ?? []
  // Duplicate names WITHIN the consumer's own list are ambiguous — fail loud.
  const names = new Set<string>()
  for (const t of custom) {
    if (names.has(t.name)) {
      throw new ToolRegistrationError(`duplicate tool name in options.tools: ${t.name}`)
    }
    names.add(t.name)
  }
  // A consumer tool with a default's name OVERRIDES that default (drop the
  // default), so `Map.set`'s last-wins can never SILENTLY shadow the consumer.
  const defaults =
    (opts.includeDefaultTools ?? true) ? buildDefaultTools().filter((t) => !names.has(t.name)) : []
  const combined: Tool[] = [...custom, ...defaults]
  // `read-only` strips every mutating tool — including the whole shell tool
  // (`bash.isReadOnly()` is statically false; there is no per-command lever) —
  // so the model physically cannot mutate, the enforcement the frozen mode
  // matrix can't express per-lever.
  const gated = isReadOnlyProfile(profile) ? combined.filter((t) => t.isReadOnly()) : combined
  return new ToolRegistry(gated)
}

const hostAwareNetworkGuard = (
  mode: ReturnType<typeof modeForProfile>,
  hostTools: AnalysisAgentOptions["tools"],
): { dispatchGuard?: DispatchGuard } => {
  const guard = buildNetworkDispatchGuard({
    posture: MODE_PRESETS[mode].network.kind,
    hostTools: (hostTools ?? []).map((t) => t.name),
  })
  return guard === undefined ? {} : { dispatchGuard: guard }
}

export const createAnalysisAgent = (opts: AnalysisAgentOptions): AnalysisAgent => {
  const env = opts.env ?? process.env
  const profile = opts.profile ?? DEFAULT_PROFILE
  const readOnly = isReadOnlyProfile(profile)
  const llm = resolveLlm(opts, env)
  const registry = resolveRegistry(opts, profile)
  // Autonomous posture (no operator to answer prompts). The gate reads
  // `config.permission`, NOT `modePolicy.permission`, so a `"default"` context
  // would route every mutating tool to `ask` → (no onConfirm) → hard deny,
  // silently breaking edits. Mutating profiles therefore run `bypass` (no
  // interactive `ask`) PLUS `hitl.autoApprove` (auto-runs always-confirm floor
  // tools). CRUCIALLY this is NOT a blanket yes: the HARD_DENY floor (rm -rf,
  // force-push, credential-exfil) still fires (it runs before the bypass
  // fast-path), and `hitl.autoApprove` NEVER opts out `hand-off-required`. So a
  // blanket `onConfirm: () => true` (which would defeat both) is avoided.
  // `read-only` keeps deny-by-default + already-stripped mutating tools.
  const permission: PermissionContext = { mode: readOnly ? "default" : "bypass" }
  const mode = modeForProfile(profile)
  const system = opts.system ?? buildSystemPrompt(opts.cwd)
  const maxTurns = opts.maxTurns ?? 200

  const controllers = new Set<AbortController>()

  return {
    run(prompt, hooks) {
      const c = new AbortController()
      controllers.add(c)
      const messages: Message[] = [
        ...(opts.seedMessages ?? []),
        { role: "user", content: [{ type: "text", text: prompt }] },
      ]
      const agentRun = makeAgentRun(
        (stream) => {
          const base: RuntimeAgentConfigBase = {
            llm,
            registry,
            stream,
            permission,
            messages,
            system,
            cwd: opts.cwd,
            maxTurns,
            signal: c.signal,
            ...(readOnly ? {} : { hitl: { autoApprove: true } }),
            // The mode's network guard, set here so the tools this host registered are
            // permitted under a deny-all posture: they are the host's own code. Without it
            // the assembler's guard refused every tool the permitted table does not name,
            // and the analysis profile could not run the host's `apply_change`.
            ...hostAwareNetworkGuard(mode, opts.tools),
          }
          // ALBB-12 claim 2 — run the FINAL composition transform every other
          // surface runs (CLI/daemon/ide/headless/bench), using embed's own env
          // view (slice-boundary invariant). Gives SDK consumers parity: the
          // env-gated refusal-fallback / subagent tool-gates / closeout critic /
          // fast-apply / stream taps become LIVE when their gates are set.
          // MEASURE-FIRST / default-OFF: no `QUANTA_*` gate ⇒ every gate stays off
          // ⇒ cfg is returned UNCHANGED ⇒ embed is byte-identical to before.
          const cfg = wireOptionalAgentPorts(assembleAgentConfig({ mode, base }, env), env)
          return runAgent(cfg)
        },
        hooks,
        opts.onEvent,
        opts.eventBufferSize,
      )
      // Release the controller once the run settles so `abort()` never fans out
      // to a finished run and the set does not grow across sequential runs.
      void Promise.resolve(agentRun)
        .catch(() => undefined)
        .finally(() => controllers.delete(c))
      return agentRun
    },
    abort() {
      for (const c of controllers) c.abort()
      controllers.clear()
    },
  }
}
