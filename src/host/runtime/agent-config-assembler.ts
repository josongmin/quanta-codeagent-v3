/**
 * Host-level AgentConfig assembler — ADR-0303 thin-surface relocation.
 *
 * SINGLE wiring point for `ModePolicy + BudgetMeter + BudgetCaps`. Lives in the
 * `@/host/runtime` composition layer (NOT a surface) so EVERY surface — the CLI
 * launcher (`apps/agent`), the bench/eval drivers, AND the web daemon
 * (`apps/web-daemon`) — consumes ONE shared assembler by reaching DOWN into
 * `@/host`, never sideways into a sibling surface. Before this relocation
 * `apps/web-daemon/runtime-factory.ts` imported `buildInteractiveTurnAssembler`
 * straight out of `apps/agent`, a cross-surface runtime edge that violated the
 * §3.1 thin-surface rule (and was invisible to the surface-coupling ratchet,
 * which did not scan `web-daemon`). The shared semantics now live below
 * `src/apps/**`; the surfaces keep only their own `process.env` read.
 *
 * Env discipline (the reason this can live below `src/apps/**`): this module
 * NEVER touches the `process.env` global. Each surface owns its env read and
 * threads a plain `EnvLike` view in as the `env` parameter — the same pattern
 * `@/llm/factory.ts` uses (`createLLM(provider, opts, env)`). Reading
 * `env.QUANTA_X` off the injected view keeps the `no-process-env-outside-config`
 * scanner green and preserves byte-identical output (the surface passes the
 * very same `process.env`, so every gate resolves identically).
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
import { editRepairLoopEnabled } from "@/agent/edit-repair-loop"
import { lspDiagnosticsProvider } from "@/agent/lsp-bridge"
import { buildDefaultMentionResolver } from "@/agent/mention-runner"
import { createObjectiveStore, type ObjectivePort } from "@/agent/objective"
import { autoWirePluginActivation } from "@/agent/plugin-activation-handler"
import { getGlobalSessionResourceRegistry } from "@/agent/session-resource-registry"
import { buildCallerOwnedRegistryWithTelemetry } from "@/agent/session-resource-registry/caller-owned-builder"
import { buildSkillMcpSession } from "@/agent/skill-mcp-wire"
import {
  type BackgroundSubagentScheduler,
  defaultBackgroundSubagentScheduler,
} from "@/agent/subagent-background"
import { createSubagentMailbox, type MailboxPort } from "@/agent/subagent-mailbox"
import { createSubagentRunner } from "@/agent/subagent-runner"
import {
  type BrowserPort,
  createCdpBrowser,
  defaultBrowserFs,
  defaultCdpTransport,
  defaultProcessSpawner,
  realClock,
  realScheduler,
} from "@/browser"
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
import { defaultPromptCacheObserver } from "@/observability/prompt-cache"
import { CI_BOT_DEFAULT_ALLOWLIST } from "@/runtime/network-allowlist"
import type { RuntimeAgentConfigBase } from "@/sdk/runtime"
import type { RuntimeAgentTurnAssembler, RuntimeAgentTurnDeps } from "@/sdk/runtime/base"
import { resolveJailed } from "@/storage"
import { type DnsResolver, nodeDnsResolver } from "@/tool/browser"
import { ReadFileState, staleReadGuardEnabled } from "@/tool/stale-read-guard"
import type { WebSearchProvider } from "@/tool/web"
import { providerFromEnv } from "@/tool/web/providers"
import { buildMentionSymbolDeps } from "./internal/mention-symbol-deps"

/** Minimal env view this assembler reads. The surface owns the actual
 *  `process.env` global read (allowed in `src/apps/**`) and threads this view
 *  in, so the module stays `process.env`-free and lives below the surfaces. */
export type AssemblerEnv = Record<string, string | undefined>

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
 *  (each runner imports its own bench/cli types — assemble stays slice-
 *  isolated from `apps/bench` and `apps/cli`). The presence of a seams bag
 *  is the only contract assemble cares about; it never reads any field. */
export interface AssembleRequestSeams {
  /** Replace `runAgent` (loop.ts). Default = the real loop. Tests can stub
   *  to skip every LLM/tool call and return a fixed AgentOutcome. */
  runAgent?: (cfg: AgentConfig) => Promise<AgentOutcome>
  /** Replace the REPL entry (used by `interactive`). Default = `runRepl`. */
  runRepl?: () => Promise<void>
  /** Replace the bench `runInstance` driver (typed as `unknown` HERE so
   *  assemble does not import `apps/bench` types; the `batch.ts` preset
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
 *  cap. Reads env off the injected `env` view (never `process.env`). */
const mentionResolverDep = (cwd: string, env: AssemblerEnv) => ({
  mentionResolver: buildDefaultMentionResolver({
    cwd,
    env,
    ...buildMentionSymbolDeps(cwd, env),
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

/** ADR-0427 — env-gated browser wiring. Mutates `cfg` to add the duck-typed
 *  `browser` slot when `QUANTA_BROWSER_TOOL=on` and a system chrome is present.
 *  No-op (byte-identical registry) otherwise. Reads env off the injected
 *  `env` view (never `process.env`). */
const maybeWireBrowser = (cfg: AgentConfig, env: AssemblerEnv): void => {
  if (env.QUANTA_BROWSER_TOOL !== "on") return
  const slot = cfg as AgentConfig & { browser?: { port: BrowserPort; resolver?: DnsResolver } }
  if (slot.browser !== undefined) return // caller-override-precedence (ADR-0332)
  const port = createCdpBrowser({
    spawner: defaultProcessSpawner,
    transport: defaultCdpTransport,
    fs: defaultBrowserFs,
    scheduler: realScheduler,
    clock: realClock,
    profileRoot: resolveJailed(".quanta/browser", cfg.cwd),
  })
  // availability() double-gate: only wire when a chrome/chromium binary exists,
  // so the model is never offered tools that would fail with backend-missing.
  if (port.availability() !== null) slot.browser = { port, resolver: nodeDnsResolver }
}

/** ADR-0394 — objective tools (`objective_set`/`objective_update`/`objective_get`).
 *  Default-ON: an in-memory `ObjectivePort` is wired unless
 *  `QUANTA_OBJECTIVE_TOOLS="0"`. Lightweight (no I/O / external dep).
 *  Caller-override-precedence (ADR-0332): a pre-set slot is preserved. */
const maybeWireObjective = (cfg: AgentConfig, env: AssemblerEnv): void => {
  // Opt-in (not default-OFF→ON here): this assembler is SHARED by bench/eval +
  // web-daemon, so a default-ON would change their tool menu (and SWE-bench
  // reproducibility). The CLI host seeds `QUANTA_OBJECTIVE_TOOLS=1` (index.ts)
  // to opt in; other surfaces stay byte-identical unless they set it.
  if (env.QUANTA_OBJECTIVE_TOOLS !== "1") return
  const slot = cfg as AgentConfig & { objective?: ObjectivePort }
  if (slot.objective !== undefined) return
  slot.objective = createObjectiveStore()
}

/** ADR-0416 — inter-subagent mailbox (`subagent_send_message`/`subagent_read_messages`).
 *  Default-ON in-memory unless `QUANTA_SUBAGENT_MAILBOX="0"`. Pairs with the
 *  parallel-worker router so spawned children can exchange messages. */
const maybeWireMailbox = (cfg: AgentConfig, env: AssemblerEnv): void => {
  // Opt-in (shared assembler — see maybeWireObjective). CLI seeds it ON.
  if (env.QUANTA_SUBAGENT_MAILBOX !== "1") return
  const slot = cfg as AgentConfig & { subagentMailbox?: MailboxPort }
  if (slot.subagentMailbox !== undefined) return
  slot.subagentMailbox = createSubagentMailbox()
}

/** ADR-0142 — `web_search` provider. SELF-GATING: wired ONLY when a provider
 *  resolves from env (`BRAVE_SEARCH_API_KEY`, or `QUANTA_WEB_SEARCH_DUCKDUCKGO=1`).
 *  No key ⇒ slot unset ⇒ no `web_search` tool (never a dead "no provider" tool). */
const maybeWireWebSearch = (cfg: AgentConfig, env: AssemblerEnv): void => {
  const slot = cfg as AgentConfig & { webSearch?: { provider: WebSearchProvider } }
  if (slot.webSearch !== undefined) return
  const provider = providerFromEnv(env)
  if (provider !== undefined) slot.webSearch = { provider }
}

/** ADR-0151 — background-subagent scheduler (`subagent_fork`/`subagent_poll`/
 *  `subagent_await`). OPT-IN (`QUANTA_SUBAGENT_BG="on"`): it OVERLAPS the 6-tool
 *  `spawn_agent` router (the default parallel-worker surface), so it stays OFF
 *  by default to avoid handing the model two redundant parallel-spawn APIs. When
 *  on, children run through the same depth-guarded `SubagentRunner`. */
const maybeWireBackgroundSubagent = (cfg: AgentConfig, env: AssemblerEnv): void => {
  if (env.QUANTA_SUBAGENT_BG !== "on") return
  const slot = cfg as AgentConfig & {
    subagentBackground?: { scheduler: BackgroundSubagentScheduler }
  }
  if (slot.subagentBackground !== undefined) return
  slot.subagentBackground = {
    scheduler: defaultBackgroundSubagentScheduler({ runner: createSubagentRunner(cfg) }),
  }
}

/** Open the optional agent-capability slots (browser / objective / mailbox /
 *  web_search / background-subagent) in one call. Keeps `assembleAgentConfig`
 *  under the cognitive-complexity cap; each helper is independently env-gated,
 *  caller-override-safe, and a no-op when its gate/resource is absent. */
const wireOptionalCapabilitySlots = (cfg: AgentConfig, env: AssemblerEnv): void => {
  maybeWireBrowser(cfg, env)
  maybeWireObjective(cfg, env)
  maybeWireMailbox(cfg, env)
  maybeWireWebSearch(cfg, env)
  maybeWireBackgroundSubagent(cfg, env)
  maybeWireReadFileState(cfg, env)
  maybeWireDiagnostics(cfg, env)
  maybeWireSkillMcp(cfg, env)
  maybeWirePromptCacheObserver(cfg, env)
}

/** ADR-0182 — mint ONE per-session `PromptCacheObserver` when the prompt-cache
 *  status tool is opted in (`QUANTA_PROMPT_CACHE_STATUS=1`). The SAME instance
 *  is read by `buildPromptCacheBlock` (the `prompt_cache_status` tool) and by
 *  the loop's `emitUsage` feed, so the snapshot reflects the session's real
 *  cache buckets. Caller-override-safe; absent gate ⇒ slot unset ⇒ no feed, no
 *  tool (byte-identical default-OFF). */
const maybeWirePromptCacheObserver = (cfg: AgentConfig, env: AssemblerEnv): void => {
  if (env.QUANTA_PROMPT_CACHE_STATUS !== "1") return
  if (cfg.promptCacheObserver !== undefined) return
  cfg.promptCacheObserver = defaultPromptCacheObserver()
}

/** ADR-0474 — mint ONE per-session `ReadFileState` when the stale-read-guard is
 *  opted in (`QUANTA_STALE_READ_GUARD=1`), so `read` records mtimes that
 *  `write`/`edit` of the same session consult. Caller-override-safe; absent gate
 *  ⇒ slot stays unset ⇒ no tracking, no guard (byte-identical default-OFF). */
const maybeWireReadFileState = (cfg: AgentConfig, env: AssemblerEnv): void => {
  if (!staleReadGuardEnabled(env)) return
  if (cfg.readFileState !== undefined) return
  cfg.readFileState = new ReadFileState()
}

/** ADR-0472 — populate `cfg.diagnosticsProvider` with the REAL LSP provider when
 *  the edit-repair-loop is opted in (`QUANTA_EDIT_REPAIR_LOOP=1`), so dispatch's
 *  post-edit `openLintBracket` can snapshot pre/post diagnostics and (when an LLM
 *  is present) drive the active repair loop. Reuses the SAME `lspDiagnosticsProvider`
 *  the ADR-0405 post-edit hook uses — one provider shape, two consumers.
 *  Caller-override-safe; absent gate ⇒ slot stays unset ⇒ dispatch is
 *  byte-identical (no bracketing, no provider call). */
const maybeWireDiagnostics = (cfg: AgentConfig, env: AssemblerEnv): void => {
  if (!editRepairLoopEnabled(env)) return
  if (cfg.diagnosticsProvider !== undefined) return
  cfg.diagnosticsProvider = lspDiagnosticsProvider()
}

/** ADR-0476 — mint ONE per-session skill→MCP coordinator when opted in
 *  (`QUANTA_SKILL_MCP_DEPS=1`), bound to the REAL stdio launcher + HTTP-SSE
 *  connect port (dual-transport, via `buildSkillMcpSession`). The loop then
 *  reconciles it per turn over the active skills' lifted `dependencies` blocks
 *  and tears it down at session end. Caller-override-safe; absent gate ⇒ slot
 *  stays unset ⇒ reconcile + shutdown are pure no-ops (byte-identical). */
const maybeWireSkillMcp = (cfg: AgentConfig, env: AssemblerEnv): void => {
  if (env.QUANTA_SKILL_MCP_DEPS !== "1") return
  if (cfg.skillMcpSession !== undefined) return
  cfg.skillMcpSession = buildSkillMcpSession(env)
}

/** Single source of truth for "config for this mode" assembly. `env` is the
 *  surface-owned env view (see file header) — this module never reads the
 *  `process.env` global. */
export const assembleAgentConfig = (req: AssembleRequest, env: AssemblerEnv): AgentConfig => {
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
      req.base.lspDiagnosticsHookEnabled ?? env.QUANTA_LSP_DIAGNOSTICS_HOOK === "1",
    // ADR-0412 — resolve the check_secrets tool gate HERE. Caller override on
    // `req.base` wins; otherwise `QUANTA_SECRET_CHECK_TOOL=on`.
    secretCheckToolEnabled:
      req.base.secretCheckToolEnabled ?? env.QUANTA_SECRET_CHECK_TOOL === "on",
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
  // ADR-0427 + jun-03 — open the optional agent-capability slots (browser /
  // objective / mailbox / web_search / background-subagent). Each is env-gated +
  // caller-override-safe + byte-identical when its gate/resource is absent (see
  // the per-helper docs); the single call keeps this fn under the complexity cap.
  wireOptionalCapabilitySlots(cfg, env)
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
    ...mentionResolverDep(cfg.cwd, env),
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

/** Request shape for the interactive turn-assembler: everything `assemble`
 *  accepts EXCEPT `base`/`mode` (the runtime supplies those per turn). */
export type InteractiveTurnAssemblerRequest = Omit<AssembleRequest, "base" | "mode">

/**
 * Build the per-turn `RuntimeAgentTurnAssembler` the runtime invokes once per
 * turn with `(messages, turnDeps)`. Pins `mode: "interactive"` and threads the
 * surface-owned `env` view (captured at build time) into every assembly. Shared
 * by `apps/agent` (interactive REPL) and `apps/web-daemon` (WS sessions) so
 * neither surface re-implements interactive AgentConfig assembly.
 */
export const buildInteractiveTurnAssembler = (
  req: InteractiveTurnAssemblerRequest,
  env: AssemblerEnv,
): RuntimeAgentTurnAssembler => {
  return (messages, turnDeps: RuntimeAgentTurnDeps): AgentConfig =>
    assembleAgentConfig(
      {
        mode: "interactive",
        ...req,
        base: {
          ...turnDeps,
          messages,
        },
      },
      env,
    )
}
