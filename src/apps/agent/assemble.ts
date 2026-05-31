/**
 * Unified AgentConfig assembler — RFC may-22-unified-agent-runtime / Phase 4.
 *
 * SINGLE wiring point for `ModePolicy + BudgetMeter + BudgetCaps`. Apps that
 * want a unified surface (`apps/agent/index.ts`) call this; legacy entry points
 * (`apps/cli/index.ts`, `apps/bench/index.ts`) can adopt incrementally.
 *
 * Lever propagation: this is where the 12-lever discriminated union from
 * `ModePolicy` translates to concrete AgentConfig fields. New levers added to
 * `ModePolicy` MUST be wired here AND in `apps/agent/mode-presets/<mode>.ts`
 * — the per-mode preset owns the lever→implementation mapping, while THIS
 * file owns the unified type-narrow + budget meter construction.
 *
 * Default-OFF / byte-identical: callers may pass `modePolicy: undefined` to
 * skip the whole RFC may-22 layer — the returned config is identical to a
 * pre-RFC manually-assembled AgentConfig (no budgetMeter, no modePolicy).
 */

import type { BudgetDials, BudgetExhaustionPolicy } from "@/agent"
import {
  type AgentConfig,
  type AgentOutcome,
  assertModeMatrix,
  BUDGET_PRESETS,
  type BudgetMeter,
  BudgetMeter as BudgetMeterCtor,
  clampDials,
  runAgent as defaultRunAgent,
  MODE_PRESETS,
  type ModePolicy,
  type RunMode,
} from "@/agent"
import { installCodexR2Wires } from "@/agent/codex-r2-wire-install"
import { captureSnapshot } from "@/agent/context-change"
import { buildNetworkDispatchGuard } from "@/agent/dispatch-guard"
import { CI_BOT_DEFAULT_ALLOWLIST } from "@/runtime/network-allowlist"
import { buildDefaultMentionResolver } from "@/agent/mention-runner"
import { autoWirePluginActivation } from "@/agent/plugin-activation-handler"
import { getGlobalSessionResourceRegistry } from "@/agent/session-resource-registry"
import { buildCallerOwnedRegistryWithTelemetry } from "@/agent/session-resource-registry/caller-owned-builder"
import { buildMentionSymbolDeps } from "@/host/runtime/internal/mention-symbol-deps"
import {
  createInMemorySystemPromptCache,
  type SystemPromptCachePort,
} from "@/llm/system-prompt-cache"
import { createInMemoryTypedHistoryEventStore } from "@/memory/typed-event"
import {
  adaptMetricsRegistryToEmitter,
  looksLikeMetricsRegistry,
  type MetricEmitterPort,
  withCacheMetrics,
} from "@/observability/codex-r2-metrics"
import type { RuntimeAgentConfigBase } from "@/sdk/runtime"

/** Mode-preset-extra payloads (RFC may-22 Phase 4+). Each field is OPTIONAL
 *  on `AssembleRequest` so legacy callers (the assemble unit test, anything
 *  that wants ONLY the modePolicy+budgetMeter wiring) continue to work
 *  byte-identically. Mode-preset runners validate the relevant field is
 *  present on entry and throw with a clear message otherwise. */
export interface HeadlessExtras {
  /** Single prompt for one-shot execution. */
  prompt: string
  /** When `"json"`, stream as structured events instead of plain stdout. */
  output?: "text" | "json"
}

export interface BatchExtras {
  /** Corpus root path (or pre-loaded instance list). */
  corpus: string
  /** Optional id substring filter applied BEFORE limit slice. */
  instance?: string
  /** Cap on instances after filtering. */
  limit?: number | null
  /** Predictions output path. Absent ⇒ skip writing. */
  predictionsPath?: string
  /** Report output path. Absent ⇒ skip writing. */
  reportPath?: string
}

export interface CiBotExtras {
  /** PR ref (`owner/repo#NNN` or full URL — opaque to assemble). */
  pr: string
  /** Repo working dir (a branch-only clone). Defaults to caller cwd. */
  cwd?: string
  /** `--dry-run`: read the PR and run the agent, but do NOT post the summary
   *  comment back to GitHub (the `gh pr comment` write is skipped). The run
   *  still produces its outcome + exit code. Default = false (comment posted). */
  dryRun?: boolean
  /** Track A1 — extra hosts to allow beyond the ci-bot default egress set when
   *  the active mode's network posture is `allowlist`. Deduped against
   *  {@link CI_BOT_DEFAULT_ALLOWLIST}. Absent ⇒ default set only. */
  extraAllowedHosts?: readonly string[]
  /** Track A1 — honor `NetworkPolicy.perRequestApproval`: when true, an
   *  off-allowlist egress host routes to HITL `ask` (preview `"guard-ask"`)
   *  instead of a terminal deny. Absent / false ⇒ off-list host ⇒ hard deny. */
  perRequestApproval?: boolean
}

/** Run-outcome envelope returned by every mode runner. Mirrors the shape
 *  Track A uses to bridge into `process.exit(cfg.exitCode)`. */
export interface RunOutcome {
  exitCode: number
  outcome?: AgentOutcome
}

/** Injectable seams for hermetic testing. The TYPED shape lives per-preset
 *  (each runner imports its own bench/cli types — assemble.ts stays slice-
 *  isolated from `apps/bench` and `apps/cli`). The presence of a seams bag
 *  is the only contract assemble cares about; it never reads any field. */
export interface AssembleRequestSeams {
  /** Replace `runAgent` (loop.ts). Default = the real loop. Tests can stub
   *  to skip every LLM/tool call and return a fixed AgentOutcome. */
  runAgent?: (cfg: AgentConfig) => Promise<AgentOutcome>
  /** Replace the REPL entry (used by `interactive`). Default = `runRepl`. */
  runRepl?: () => Promise<void>
  /** Replace the bench `runInstance` driver (typed as `unknown` HERE so
   *  assemble.ts does not import `apps/bench` types; the `batch.ts` preset
   *  narrows via its own typed wrapper). */
  runInstance?: (instance: unknown) => Promise<unknown>
  /** Replace `loadCorpus` (same untyped-here-typed-in-preset pattern). */
  loadCorpus?: (root: string) => Promise<unknown[]>
  /** GitHub `gh` runner for ci-bot. Default = a real `Bun.spawn(["gh", …])`. */
  ghRun?: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  /** Inner git runner for ci-bot (BEFORE the branch-only guard wraps it).
   *  Default = the real `defaultGitRunner`. Tests inject a fake to assert the
   *  branch-only guard rejects protected-branch writes without touching git. */
  gitRun?: (
    args: readonly string[],
    cwd: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>
}

/** Operator input for assemble: mode + dials override + base AgentConfig core
 *  + (optional) mode-specific extras + (optional) hermetic test seams. */
export interface AssembleRequest {
  /** Which runtime mode the agent runs in. */
  mode: RunMode
  /** Caller-supplied AgentConfig core (llm, registry, stream, permission,
   *  messages, system, maxTurns, …). The assembler does NOT construct these
   *  — they are surface-specific (REPL stdin, bench sandbox, etc.). */
  base: RuntimeAgentConfigBase
  /** Operator-requested budget dials. Defaults from `BUDGET_PRESETS[mode]`,
   *  clamped to `MODE_PRESETS[mode].budgetCaps` if any. */
  dials?: Partial<BudgetDials>
  /** Override the mode's exhaustion policy. Default = preset value. */
  exhaustion?: BudgetExhaustionPolicy
  /** Mode-specific extras. Each preset reads its own; assemble itself never
   *  touches these (kept on the request so a CLI wrapper passes one object). */
  headless?: HeadlessExtras
  batch?: BatchExtras
  ciBot?: CiBotExtras
  /** Hermetic test seams. Absent ⇒ real implementations. */
  seams?: AssembleRequestSeams
}

/** Pick the right `runAgent` implementation: caller-stub > real. Exported so
 *  every mode-preset uses the same resolution rule (test-seam ➝ default). */
export const resolveRunAgent = (
  seams: AssembleRequestSeams | undefined,
): ((cfg: AgentConfig) => Promise<AgentOutcome>) => seams?.runAgent ?? defaultRunAgent

/** ADR-0422 — mention resolver dep via the DRY `buildDefaultMentionResolver`.
 *  @file (workspace root = cwd) + @symbol are wired here; @skill is gracefully
 *  omitted because no read-only skill registry exists at config-assembly time
 *  (the per-turn inventory is built inside the loop). @symbol is now BACKED in
 *  production (ADR-0422 follow-up): `buildMentionSymbolDeps` supplies a
 *  deterministically-anchored LSP union lookup PLUS a semantic-index fallback
 *  (`auto` priority), each lazily built on first use so config assembly stays
 *  synchronous + zero-cost when no `@symbol` is mentioned. Each kind is
 *  independently gated by its `QUANTA_MENTION_*` knob (default-ON). The
 *  resulting composite is always set; with every knob `=off` it resolves every
 *  mention to `null` (byte-identical to the legacy 3-kind path). Extracted so
 *  the assembleAgentConfig closure stays under biome's cognitive-complexity
 *  cap. */
const mentionResolverDep = (cwd: string) => ({
  mentionResolver: buildDefaultMentionResolver({
    cwd,
    env: process.env,
    ...buildMentionSymbolDeps(cwd, process.env),
  }),
})

/**
 * Track A1 — derive the network-egress {@link DispatchGuard} from the active
 * mode's `NetworkLever`, closing the "defined-but-not-enforced" hole.
 *
 * Returns `undefined` when the mode imposes NO network restriction
 * (`network.kind === "open"`) — the caller then leaves `cfg.dispatchGuard`
 * unset so dispatch is BYTE-IDENTICAL to the pre-wire path. Only the
 * restrictive postures (`allowlist` / `denied`) activate enforcement; this is
 * the natural default-OFF.
 *
 *   - `allowlist` ⇒ guard over the ci-bot default allowlist (+ operator extras
 *                   from `req.ciBot` when present, deduped). When the mode's
 *                   `PermissionProfile.network.perRequestApproval` is true an
 *                   off-list host routes to HITL `ask` rather than a hard deny.
 *   - `denied`    ⇒ guard over an EMPTY allowlist ⇒ every egress-bearing tool
 *                   call is denied.
 *
 * Extracted so the `assembleAgentConfig` closure stays under biome's
 * cognitive-complexity cap.
 */
const networkDispatchGuardFor = (req: AssembleRequest, policy: ModePolicy) => {
  const posture = policy.network.kind
  if (posture === "open") return undefined
  // For the allowlist posture, the effective hosts are the audited ci-bot
  // default set (the single source of truth for "small + audited" egress)
  // plus any operator-supplied extras on the ci-bot request, deduped.
  const extras = req.ciBot?.extraAllowedHosts ?? []
  const hosts =
    extras.length > 0
      ? Array.from(new Set([...CI_BOT_DEFAULT_ALLOWLIST, ...extras]))
      : CI_BOT_DEFAULT_ALLOWLIST
  return buildNetworkDispatchGuard({
    posture,
    hosts,
    ...(req.ciBot?.perRequestApproval === true ? { perRequestApproval: true } : {}),
  })
}

/** Single source of truth for "config for this mode" assembly. */
export const assembleAgentConfig = (req: AssembleRequest): AgentConfig => {
  const policy: ModePolicy = MODE_PRESETS[req.mode]
  assertModeMatrix(policy)

  const presetDials = BUDGET_PRESETS[req.mode]
  // operator dials override preset; both then clamp to caps (with surface log)
  const merged: BudgetDials = { ...presetDials, ...(req.dials ?? {}) }
  const caps = "budgetCaps" in policy ? (policy.budgetCaps as Partial<BudgetDials>) : {}
  const clamped = clampDials(merged, caps)

  const exhaustion: BudgetExhaustionPolicy =
    req.exhaustion ??
    ("budgetExhaustion" in policy ? (policy.budgetExhaustion as BudgetExhaustionPolicy) : "stop")

  const meter: BudgetMeter = new BudgetMeterCtor({
    dials: clamped,
    caps,
    exhaustion,
  })

  const cfg: AgentConfig = {
    ...req.base,
    modePolicy: policy,
    budgetMeter: meter,
    // ADR-0405 — resolve the LSP-diagnostics post-edit hook gate HERE (the
    // composition root owns env). The agent slice takes a plain boolean so it
    // never reads `process.env` itself (slice-boundary invariant). Caller
    // override on `req.base` wins; otherwise `QUANTA_LSP_DIAGNOSTICS_HOOK=1`.
    lspDiagnosticsHookEnabled:
      req.base.lspDiagnosticsHookEnabled ?? process.env.QUANTA_LSP_DIAGNOSTICS_HOOK === "1",
    // ADR-0412 — resolve the check_secrets tool gate HERE. Caller override on
    // `req.base` wins; otherwise `QUANTA_SECRET_CHECK_TOOL=on`.
    secretCheckToolEnabled:
      req.base.secretCheckToolEnabled ?? process.env.QUANTA_SECRET_CHECK_TOOL === "on",
  }
  // Track A1 — network-egress enforcement. Derive the dispatch guard from the
  // active mode's NetworkLever. Caller-override-precedence (ADR-0332): a
  // pre-set `req.base.dispatchGuard` wins. When the mode is `open`-network the
  // helper returns undefined and we leave the slot UNSET ⇒ dispatch is
  // byte-identical to the pre-wire path (the natural default-OFF — only
  // restrictive modes activate enforcement).
  if (cfg.dispatchGuard === undefined) {
    const networkGuard = networkDispatchGuardFor(req, policy)
    if (networkGuard !== undefined) cfg.dispatchGuard = networkGuard
  }
  // ADR-0334 — populate the ADR-0327-family wire slots on the freshly
  // assembled cfg. Idempotent + caller-override-precedence (ADR-0332):
  // any slot the caller already set on `req.base` is preserved verbatim.
  //
  // ADR-0347 — when `sessionId` is present, look up `{ store, cache }`
  // via the process-level singleton registry so a same-`sessionId`
  // re-assemble REUSES prior typed-history events and warmed
  // system-prompt cache entries. When `sessionId` is absent (legacy
  // callers / one-shot bench-style usage) fall back to the fresh
  // factory pair — byte-identical to the ADR-0334 baseline.
  //
  // ADR-0358 — when `cfg.metrics` is structurally a MetricsRegistry
  // (ADR-0144 port) AND the caller has NOT pre-supplied a cache, wrap
  // the session-scoped cache with `withCacheMetrics` so cache hit/miss/
  // invalidation counters land on the operator registry. NO-THROW
  // (looksLikeMetricsRegistry is a pure shape check + adapter is pure
  // delegation).
  const metricsEmitter: MetricEmitterPort | undefined =
    cfg.metrics !== undefined && looksLikeMetricsRegistry(cfg.metrics)
      ? adaptMetricsRegistryToEmitter(cfg.metrics)
      : undefined
  // ADR-0372 — Caller-owned registry path for flock telemetry. When
  // `cfg.metrics` is a real MetricsRegistry (i.e. `metricsEmitter` is
  // set), mint a FRESH disk-adapter with the emitter injected so the
  // ADR-0364 lock counters land on the same registry instead of being
  // dropped on the floor (ADR-0368 documented why the global singleton
  // cannot accept the emitter). When `metricsEmitter` is absent, the
  // legacy global-singleton path is preserved verbatim ⇒ byte-identical
  // for hosts that do NOT thread metrics through.
  const sessionResources =
    cfg.sessionId !== undefined
      ? metricsEmitter !== undefined
        ? buildCallerOwnedRegistryWithTelemetry({
            emitter: metricsEmitter,
            sessionId: cfg.sessionId,
          }).getOrCreate(cfg.sessionId)
        : getGlobalSessionResourceRegistry().getOrCreate(cfg.sessionId)
      : null
  // Caller-override-precedence (ADR-0332): a pre-set
  // `cfg.systemPromptCache` is preserved by `installCodexR2Wires`,
  // so the wrap here only affects the default cache we are about to
  // install — we never re-wrap a caller-supplied cache. Bench surface
  // (sessionResources === null) ⇒ wrap skipped ⇒ byte-identical replay.
  const baseCache: SystemPromptCachePort =
    sessionResources?.cache ?? createInMemorySystemPromptCache()
  const wrappedCache: SystemPromptCachePort =
    metricsEmitter !== undefined && sessionResources !== null && cfg.systemPromptCache === undefined
      ? withCacheMetrics(baseCache, { emitter: metricsEmitter })
      : baseCache
  // ADR-0360 — expose the adapted emitter on `cfg` via structural side-
  // channel so `resolvePluginActivationForTurn` (ADR-0346) can emit
  // per-turn activation telemetry. Structural-only — does NOT mutate
  // AgentConfig type surface; absent emitter ⇒ field stays unset ⇒
  // the activation hook degrades to legacy no-emit.
  if (metricsEmitter !== undefined) {
    ;(cfg as { metricsEmitter?: MetricEmitterPort }).metricsEmitter = metricsEmitter
  }
  installCodexR2Wires(cfg, {
    ...(cfg.sessionId !== undefined ? { sessionId: cfg.sessionId } : {}),
    systemPromptCache: wrappedCache,
    store: sessionResources?.store ?? createInMemoryTypedHistoryEventStore(),
    // ADR-0418 — @file mention resolver (helper keeps this closure under the
    // cognitive-complexity cap). Default-ON; QUANTA_MENTION_FILE=off opts out.
    ...mentionResolverDep(cfg.cwd),
    getSnapshot: () =>
      captureSnapshot({
        cwd: cfg.cwd,
        mode: typeof cfg.mode === "string" ? cfg.mode : "default",
        model: (cfg.llm as { model?: string }).model ?? "",
        repoRulesPaths:
          cfg.repoRules?.layers?.map((l) => l.sourcePath) ??
          (cfg.repoRules !== undefined ? [cfg.repoRules.sourcePath] : []),
        activeSkills: [],
      }),
  })
  // ADR-0350 — auto-wire `cfg.activatePlugins` from a workspace-anchored
  // plugin scan so the ADR-0346 loop hook gets a real activator instead
  // of remaining a no-op. NO-THROW + caller-override-precedence: a host
  // that pre-sets `cfg.activatePlugins` keeps its own activator; an empty
  // / missing plugin root leaves the slot undefined ⇒ loop hook short-
  // circuits ⇒ byte-identical legacy. Intentionally NOT called from the
  // bench composition root (ADR-0334 row 4): bench cfg has no sessionId
  // and stays empty-deps for replay determinism.
  autoWirePluginActivation(cfg)
  return cfg
}
