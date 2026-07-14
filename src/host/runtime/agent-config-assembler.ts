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
import { defaultBudgetLedger } from "@/agent/budget-ledger"
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
import { wireSideAgentDaemons } from "@/agent/side-agent-runner"
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
import type { PassiveVcsEventSink, VcsEvent } from "@/git/passive-classify"
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
import { gateOn, runtimeConfig, runtimeConfigFromEnv } from "@/shared"
import { createProcessSideAgentDaemonRegistry } from "@/side-agent"
import { skillMcpDepsEnabled } from "@/skill/skill-mcp-deps"
import { resolveJailed } from "@/storage"
import type { AgentEvent, StreamPort } from "@/stream"
import type { AppshotArtifactSink, AppshotSlot } from "@/tool"
import { createSessionWriteBudget } from "@/tool/_shared/write-budget"
import { type BrowserNetSink, type DnsResolver, nodeDnsResolver } from "@/tool/browser"
import { ReadFileState, staleReadGuardEnabled } from "@/tool/stale-read-guard"
import type { WebSearchProvider } from "@/tool/web"
import { providerFromEnv } from "@/tool/web/providers"
import { buildAppshotPortWire } from "./appshot-port-wire"
import { persistBudgetLedger } from "./budget-ledger-persist"
import { buildMentionSymbolDeps } from "./internal/mention-symbol-deps"
import { maybeWirePeerTeamMessaging } from "./peer-team-wire"
import { maybeWireProgressSink } from "./progress-sink-wire"
import { maybeWireBashSandboxEscalation } from "./sandbox-escalation-wire"
import { nodeProcessForkPort, sideAgentWorkerModulePath } from "./side-agent-fork-port"

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
  /** P26 — headless stdout contract (CLI `--output-format`):
   *    • `"text"` / absent ⇒ legacy human stdout (byte-identical default),
   *    • `"json"` ⇒ one well-formed top-level JSON value (an array of the
   *      session-protocol events) flushed at run end,
   *    • `"stream-json"` ⇒ one versioned NDJSON `SessionEvent` line per event.
   *  The legacy `"json"` callers keep working (the union is a superset). */
  output?: "text" | "json" | "stream-json"
  /** P26 — when true, the `json`/`stream-json` sink ALSO emits streaming-delta
   *  (partial assistant-text) events. Absent ⇒ milestone events only (the small,
   *  stable default machine contract). No effect on `text`. */
  includePartial?: boolean
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
  if (!gateOn(env, "QUANTA_BROWSER_TOOL")) return
  const slot = cfg as AgentConfig & {
    browser?: {
      port: BrowserPort
      resolver?: DnsResolver
      bounds?: boolean
      highlight?: boolean
      tabs?: boolean
      network?: boolean
      netHolder?: BrowserNetSink
    }
    /** S1 (jul-04) — the surface-owned `/browser-net` capture holder, threaded
     *  DOWN from the CLI via `RuntimeFacadeComposeOptions.browserNet` → the
     *  runtime-context snapshot → the per-turn base. Duck-typed here (same as the
     *  `browser` slot itself). Absent ⇒ no mirror (byte-identical). */
    browserNet?: BrowserNetSink
  }
  if (slot.browser !== undefined) return // caller-override-precedence (ADR-0332)
  // S1 — the surface holder rides down as `base.browserNet` (the compose seam);
  // it is threaded into the toolset ONLY when QUANTA_BROWSER_NETWORK is also on
  // (the mirror rides the gated `browser_network` tool). Absent ⇒ undefined.
  const netHolder = slot.browserNet
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
  if (port.availability() !== null) {
    // TICKET-24 — per-feature default-OFF sub-gates on top of QUANTA_BROWSER_TOOL.
    slot.browser = {
      port,
      resolver: nodeDnsResolver,
      bounds: gateOn(env, "QUANTA_BROWSER_BOUNDS"),
      highlight: gateOn(env, "QUANTA_BROWSER_HIGHLIGHT"),
      tabs: gateOn(env, "QUANTA_BROWSER_TABS"),
      network: gateOn(env, "QUANTA_BROWSER_NETWORK"),
      // S1 (jul-04) — the surface `/browser-net` sink, threaded ONLY when present
      // (CLI down-thread). `buildBrowserBlock` passes it to the toolset, which
      // mirrors each `browser_network` drain into it. Absent ⇒ omitted.
      ...(netHolder !== undefined ? { netHolder } : {}),
    }
  }
}

/** G1 (RFC jun-6-appgen-appshot) — env-gated appshot verify-loop wiring. Mutates
 *  `cfg` to assemble the REAL {@link AppshotPort} into `cfg.appshot` — but ONLY
 *  when ALL of:
 *    - `QUANTA_APPSHOT=1` (the strict opt-in knob), AND
 *    - a live `BrowserPort` is wired (`cfg.browser.port`, set by
 *      {@link maybeWireBrowser} above when QUANTA_BROWSER_TOOL=on + a system Chrome
 *      exists) — appshot's render/screenshot arrows RIDE that browser, AND
 *    - a judge `LLMPort` is in scope (`cfg.llm`, always present on a real base).
 *  This is the one layer where the browser + judge are both reachable; the
 *  pre-assembler `agent-arg-builder` cannot mint this slot (no BrowserPort there).
 *  When wired, render/screenshot → the live browser, verify → `cfg.llm` (cheap
 *  LLM-judge), scaffold → `makeJailedScaffold(cfg.cwd)`, and — when the Canvas
 *  store is ALSO on (`cfg.artifactRegistry`, threaded from the composition root) —
 *  the final scaffold registers into that SAME registry the `artifact_*` tools
 *  read. Missing knob / browser / judge ⇒ slot unset ⇒ no tool (byte-identical
 *  default-OFF). Caller-override-safe: a pre-set `cfg.appshot` is preserved.
 *  Reads env off the injected `env` view (never `process.env`). */
const maybeWireAppshot = (cfg: AgentConfig, env: AssemblerEnv): void => {
  if (!gateOn(env, "QUANTA_APPSHOT")) return
  const slot = cfg as AgentConfig & {
    appshot?: AppshotSlot
    browser?: { port: BrowserPort }
    artifactRegistry?: AppshotArtifactSink
    appshotDispose?: () => Promise<void>
  }
  if (slot.appshot !== undefined) return // caller-override-precedence (ADR-0332)
  const browser = slot.browser?.port
  // No browser wired (Chrome absent or QUANTA_BROWSER_TOOL off) ⇒ render/
  // screenshot are unreachable ⇒ leave the slot unset (byte-identical). The
  // judge is `cfg.llm`, always a real adapter on a production base.
  if (browser === undefined) return
  const wire = buildAppshotPortWire({ browser, judge: cfg.llm, cwd: cfg.cwd })
  slot.appshot = {
    port: wire.port,
    now: () => Date.now(),
    ...(slot.artifactRegistry !== undefined ? { artifactSink: slot.artifactRegistry } : {}),
  }
  // The lazily-spawned appshot browser session shares the SAME BrowserPort the
  // browser block already disposes; `wire.dispose` is idempotent and closes only
  // the handle appshot itself spawned. The tier-1 appshot block registers it into
  // teardown (mirrors browserDispose).
  slot.appshotDispose = wire.dispose
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
  if (!gateOn(env, "QUANTA_OBJECTIVE_TOOLS")) return
  const slot = cfg as AgentConfig & { objective?: ObjectivePort }
  if (slot.objective !== undefined) return
  slot.objective = createObjectiveStore()
}

/** ADR-0416 — inter-subagent mailbox (`subagent_send_message`/`subagent_read_messages`).
 *  Default-ON in-memory unless `QUANTA_SUBAGENT_MAILBOX="0"`. Pairs with the
 *  parallel-worker router so spawned children can exchange messages. */
const maybeWireMailbox = (cfg: AgentConfig, env: AssemblerEnv): void => {
  // Opt-in (shared assembler — see maybeWireObjective). CLI seeds it ON.
  if (!gateOn(env, "QUANTA_SUBAGENT_MAILBOX")) return
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
  if (!gateOn(env, "QUANTA_SUBAGENT_BG")) return
  const slot = cfg as AgentConfig & {
    subagentBackground?: { scheduler: BackgroundSubagentScheduler }
  }
  if (slot.subagentBackground !== undefined) return
  // ADR-0487 — opt into the admission wait-queue when QUANTA_SUBAGENT_QUEUE is
  // on; absent ⇒ the scheduler throws-at-cap (byte-identical pre-queue behavior).
  // `maxQueued` (QUANTA_BG_MAX_QUEUED) is honored ONLY when the queue is on;
  // absent ⇒ the scheduler's built-in DEFAULT_MAX_QUEUED (64). Default-OFF path
  // is byte-identical.
  const subagentQueue = runtimeConfig().subagentQueue
  const maxQueued = parseAssemblerPositiveInt(env.QUANTA_BG_MAX_QUEUED)
  slot.subagentBackground = {
    scheduler: defaultBackgroundSubagentScheduler({
      runner: createSubagentRunner(cfg),
      // Phase 0-a (jul-13 nesting-control RFC §6.5): the scheduler is built FROM
      // the parent's config, so background children run at `parentDepth + 1`
      // (0 = root). Reviving the runner's `req.depth > maxDepth` reject that the
      // prior hardcoded `depth: 0` never reached.
      parentDepth: cfg.depth ?? 0,
      ...(subagentQueue ? { admissionQueue: true } : {}),
      ...(subagentQueue && maxQueued !== undefined ? { maxQueued } : {}),
    }),
  }
}

/** Parse a strictly-positive integer env value (used for the admission-queue
 *  `maxQueued` cap). A non-numeric / non-positive value yields `undefined` so
 *  the scheduler falls back to its built-in default. */
const parseAssemblerPositiveInt = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** Open the optional agent-capability slots (browser / objective / mailbox /
 *  web_search / background-subagent) in one call. Keeps `assembleAgentConfig`
 *  under the cognitive-complexity cap; each helper is independently env-gated,
 *  caller-override-safe, and a no-op when its gate/resource is absent. */
const wireOptionalCapabilitySlots = (cfg: AgentConfig, env: AssemblerEnv): void => {
  const config = runtimeConfigFromEnv(env)
  maybeWireBrowser(cfg, env)
  // G1 — runs AFTER maybeWireBrowser so it can read the freshly-wired
  // `cfg.browser.port`; no-op unless QUANTA_APPSHOT=1 AND a browser is present.
  maybeWireAppshot(cfg, env)
  maybeWireObjective(cfg, env)
  maybeWireMailbox(cfg, env)
  maybeWireWebSearch(cfg, env)
  maybeWireBackgroundSubagent(cfg, env)
  maybeWireReadFileState(cfg, env)
  maybeWireDiagnostics(cfg, env)
  maybeWireSkillMcp(cfg, env)
  maybeWirePromptCacheObserver(cfg, env)
  maybeWireVcsEventSink(cfg, env)
  maybeWireProgressSink(cfg, env)
  maybeWireSideAgent(cfg, config)
  maybeWireWriteBudget(cfg, config)
  maybeWireBudgetLedger(cfg, env)
}

/** Parse a USD cost cap (`QUANTA_BUDGET_LEDGER_*_USD`) from the env bag: a
 *  positive, finite dollar amount (fractional allowed, e.g. `5.50`), else
 *  `undefined`. No magic default — the cap is operator-supplied (measure-first /
 *  no-heuristics), so an enabled-but-uncapped config stays inert. */
const parseLedgerUsd = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const n = Number.parseFloat(raw.trim())
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** Operator cost-cap dial overrides from env (`QUANTA_MAX_COST_USD` /
 *  `QUANTA_MAX_COST_PER_TURN_USD`). Each is a positive USD amount (fractional
 *  allowed) with NO default; an absent/garbage value omits that dial so the
 *  preset's own value stands (byte-identical). Lets a human pin a cost ceiling
 *  on any mode — including the otherwise-uncapped interactive/ide modes —
 *  without code. */
const envCostDialOverrides = (env: AssemblerEnv): Partial<BudgetDials> => {
  const maxCostUsd = parseLedgerUsd(env["QUANTA_MAX_COST_USD"])
  const maxCostPerTurnUsd = parseLedgerUsd(env["QUANTA_MAX_COST_PER_TURN_USD"])
  return {
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(maxCostPerTurnUsd !== undefined ? { maxCostPerTurnUsd } : {}),
  }
}

/** ADR-0136 activation — mint ONE per-session cross-run `BudgetLedger` when it
 *  is opted in (`QUANTA_BUDGET_LEDGER=1`) AND at least one HARD USD cap is set
 *  (`QUANTA_BUDGET_LEDGER_SESSION_USD` / `QUANTA_BUDGET_LEDGER_DAILY_USD`). BOTH
 *  the gate and a cap are required: the caps are operator values with NO
 *  hardcoded default (no-heuristics — campaign spend is measured, not guessed),
 *  so an enabled-but-uncapped config stays inert. This is the activation seam
 *  that makes the L4 cross-run cost governance REACHABLE: the loop's `emitUsage`
 *  records into this ledger and `turn-loop` stops the run on a hard breach. The
 *  ledger's UNIQUE value over the per-run `maxCostUsd` meter is the DAILY scope
 *  (a cap that spans turns/sessions in a UTC day) + the `budget_status` tool's
 *  per-model breakdown. Cross-process PERSISTENCE (hydrate/serialize a
 *  `~/.quanta/budget.json` so several runs share one daily budget) is a separate
 *  follow-up driven by the campaign runner. Caller-override-safe; absent gate /
 *  no cap ⇒ slot UNSET ⇒ no record, no enforcement (byte-identical default-OFF). */
const maybeWireBudgetLedger = (cfg: AgentConfig, env: AssemblerEnv): void => {
  if (cfg.budgetLedger !== undefined) return
  if (!gateOn(env, "QUANTA_BUDGET_LEDGER")) return
  const sessionHardLimit = parseLedgerUsd(env["QUANTA_BUDGET_LEDGER_SESSION_USD"])
  const dailyHardLimit = parseLedgerUsd(env["QUANTA_BUDGET_LEDGER_DAILY_USD"])
  if (sessionHardLimit === undefined && dailyHardLimit === undefined) return
  const ledger = defaultBudgetLedger({
    policy: {
      ...(sessionHardLimit !== undefined ? { sessionHardLimit } : {}),
      ...(dailyHardLimit !== undefined ? { dailyHardLimit } : {}),
    },
  })
  // Cross-PROCESS persistence — when a path is configured, hydrate prior runs'
  // spend on construction and write-through after each record, so several runs
  // (a campaign / daemon) share ONE rolling budget (the "Cline $50/afternoon"
  // case). Absent path ⇒ in-memory only (per-session enforcement still live).
  const path = env["QUANTA_BUDGET_LEDGER_PATH"]
  cfg.budgetLedger =
    path !== undefined && path.length > 0 ? persistBudgetLedger(ledger, path) : ledger
}

/** jun-6 exfil-rail (a) — mint ONE per-session `SessionWriteBudget` when the
 *  write-budget is opted in (`QUANTA_WRITE_BUDGET=1`) AND a cap is configured
 *  (`QUANTA_WRITE_BUDGET_MAX=<N>`, a positive integer). BOTH must be present —
 *  the cap is a KNOB value with NO hardcoded default (no-heuristics rule), so an
 *  enabled-but-uncapped config stays inert. `untrustedContext` is resolved from
 *  the EXISTING untrusted-envelope gate (`QUANTA_UNTRUSTED_ENVELOPE`): the budget
 *  fires ONLY when the session is operating on untrusted input — a trusted
 *  codegen session keeps unlimited writes. The over-cap verdict is `confirm` (the
 *  narrow default per RFC §7 — the user can wave it through). Dispatch binds the
 *  current turn so the counter resets per turn. Caller-override-safe; absent gate
 *  / no cap ⇒ slot unset ⇒ no counter, byte-identical (default-OFF). */
const maybeWireWriteBudget = (
  cfg: AgentConfig,
  config: ReturnType<typeof runtimeConfigFromEnv>,
): void => {
  if (cfg.writeBudget !== undefined) return
  if (!config.writeBudget) return
  const max = config.writeBudgetMax
  if (max === undefined) return
  cfg.writeBudget = createSessionWriteBudget({
    untrustedContext: config.untrustedEnvelope,
    maxWritesPerTurn: max,
    overVerdict: "confirm",
  })
}

/** N1 — mint the live side-agent daemon registry when opted in
 *  (`QUANTA_SIDE_AGENT=1`). Two interchangeable backers (both satisfy
 *  `SideAgentDaemonRegistry`/`SideAgentDaemonPort`, so the `side_agent_*` tools
 *  see the same surface):
 *
 *    - DEFAULT (in-process): `wireSideAgentDaemons` (`@/agent/side-agent-runner`)
 *      bridges the pure `@/side-agent` supervise loop to the real substrate — the
 *      ADR-0130 subagent runner (one bounded read-biased pass per wake) + the
 *      ADR-0416 mailbox (findings push) + real timers/clock. Runs the daemon on
 *      the MAIN thread.
 *    - §4.3 (`QUANTA_SIDE_AGENT_PROCESS` ALSO on): `createProcessSideAgentDaemonRegistry`
 *      (`@/side-agent`) backs EACH daemon with a SUPERVISED FORKED CHILD over
 *      `nodeProcessForkPort` + the production worker (`worker-entry.mjs`) — fork /
 *      IPC / crash-respawn, in a separate OS process. (See the worker header for
 *      exactly what the child does today vs the LLM follow-up.)
 *
 *  The returned registry structurally satisfies `AgentConfig.sideAgentDaemons`, so
 *  `buildSideAgentBlock` exposes `side_agent_*` over it. Runs AFTER
 *  `maybeWireMailbox` so the in-process path reuses the session mailbox when
 *  present. Caller-override-safe; absent `QUANTA_SIDE_AGENT` ⇒ slot unset ⇒ no
 *  daemons, no tools (byte-identical default-OFF). `QUANTA_SIDE_AGENT_PROCESS`
 *  unset ⇒ the EXACT legacy in-process path (byte-identical).
 *
 *  Budget note: the in-process backer mints a DEDICATED subagent runner for daemon
 *  passes; sharing the foreground subagent block's runner (one budget) is a
 *  follow-up — functionally the dedicated runner still honors the per-pass
 *  `maxTurns` + the registry's `maxConcurrent` guard. */
const maybeWireSideAgent = (
  cfg: AgentConfig,
  config: ReturnType<typeof runtimeConfigFromEnv>,
): void => {
  if (!config.sideAgent) return
  const slot = cfg as AgentConfig & { sideAgentDaemons?: unknown }
  if (slot.sideAgentDaemons !== undefined) return
  // §4.3 — OS-PROCESS backer selection. When `QUANTA_SIDE_AGENT_PROCESS` is ALSO
  // on, back each daemon with a SUPERVISED FORKED CHILD (the process registry)
  // instead of the in-process supervise loop. The two backers are interchangeable
  // (both satisfy `SideAgentDaemonRegistry`/`SideAgentDaemonPort`), so the
  // `side_agent_*` tools are byte-identical from the model's view. Gate OFF ⇒ the
  // EXACT legacy in-process path below (byte-identical default).
  if (config.sideAgentProcess) {
    cfg.sideAgentDaemons = createProcessSideAgentDaemonRegistry({
      fork: nodeProcessForkPort,
      scheduler: {
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      },
      now: () => Date.now(),
      workerModulePath: sideAgentWorkerModulePath(),
      // Thread the SPAWNING agent's real lineage depth across the fork boundary
      // (registry injects it as QUANTA_SIDE_AGENT_PARENT_DEPTH). `cfg.depth` is
      // the same depth the daemon-creation authority (`admitsDaemonChild`) gates
      // on; the forked worker's daemon config then runs at its TRUE lineage
      // instead of the always-floor. `?? 0` mirrors the root-is-depth-0 contract
      // used at the subagent block wire above (`parentDepth: cfg.depth ?? 0`).
      parentDepth: cfg.depth ?? 0,
      cwd: cfg.cwd,
    })
    return
  }
  const mailbox = (cfg as AgentConfig & { subagentMailbox?: MailboxPort }).subagentMailbox
  cfg.sideAgentDaemons = wireSideAgentDaemons({
    runner: createSubagentRunner(cfg),
    mailbox: mailbox ?? createSubagentMailbox(),
    mainRecipient: cfg.mailboxAgentId ?? "main",
    setInterval: (handler, ms) => setInterval(handler, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    now: () => Date.now(),
  })
}

/** ADR-0182 — mint ONE per-session `PromptCacheObserver` when the prompt-cache
 *  status tool is opted in (`QUANTA_PROMPT_CACHE_STATUS=1`). The SAME instance
 *  is read by `buildPromptCacheBlock` (the `prompt_cache_status` tool) and by
 *  the loop's `emitUsage` feed, so the snapshot reflects the session's real
 *  cache buckets. Caller-override-safe; absent gate ⇒ slot unset ⇒ no feed, no
 *  tool (byte-identical default-OFF). */
const maybeWirePromptCacheObserver = (cfg: AgentConfig, env: AssemblerEnv): void => {
  if (!gateOn(env, "QUANTA_PROMPT_CACHE_STATUS")) return
  if (cfg.promptCacheObserver !== undefined) return
  cfg.promptCacheObserver = defaultPromptCacheObserver()
}

/** ADR-0474 (+ default-ON upgrade) — mint ONE per-session `ReadFileState` so
 *  `read` records mtimes that `write`/`edit`/`apply_patch` of the same session
 *  consult (TOCTOU clobber protection). DEFAULT-ON safety control: minted unless
 *  the operator sets the EXACT strict kill-switch literal
 *  (`QUANTA_STALE_READ_GUARD=off`). Caller-override-safe; the literal `off` ⇒
 *  slot stays unset ⇒ no tracking, no guard (byte-identical legacy path). A
 *  stray falsy token does NOT disable it (`gateDisabledStrict`). */
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

/**
 * H6 (jun-3-misc §3) — serialize a classified {@link VcsEvent}'s present facets
 * into a compact, DETERMINISTIC `detail` string for the `recovery` AgentEvent.
 *
 * Order is fixed (commit → push → branch → pr) and only present facets appear,
 * so the same `VcsEvent` always yields the same string (drives a hellgate matrix
 * directly). Pure — no I/O, no `Date.now`/`Math.random`. NOT a billing/secret
 * surface: a git/gh stdout classification carries only shas / ref names / PR
 * numbers, all already model-visible in the bash output.
 */
const serializeVcsEvent = (event: VcsEvent): string => {
  const parts: string[] = []
  if (event.commit !== undefined) {
    parts.push(
      event.commit.sha !== undefined
        ? `commit:${event.commit.kind}@${event.commit.sha}`
        : `commit:${event.commit.kind}`,
    )
  }
  if (event.push !== undefined) {
    const local = event.push.localRef ?? "?"
    const remote = event.push.remoteRef ?? "?"
    parts.push(`push:${local}->${remote}`)
  }
  if (event.branch !== undefined) parts.push(`branch:${event.branch.action}`)
  if (event.pr !== undefined) {
    parts.push(
      event.pr.url !== undefined
        ? `pr:#${event.pr.number}:${event.pr.url}`
        : `pr:#${event.pr.number}`,
    )
  }
  return parts.join(" ")
}

/**
 * H6 (jun-3-misc §3) — build the host adapter that turns a classified
 * {@link VcsEvent} into an {@link AgentEvent} on the EXISTING stream (NOT a
 * second bus). The event is emitted as a `recovery` variant tagged
 * `reason:"vcs_event"` with the serialized facets as `detail` — the documented
 * catch-all family every adapter (stdout / jsonl-recorder / sse) already
 * renders + records (same posture as `plan_*` / `turn_diff_updated` /
 * `response_queued`), so no new AgentEvent variant + no exhaustiveness break in
 * the stream adapters (which this slice does not own). `emit` is NO-THROW: a
 * dead stream can never poison a bash turn (the hook also guards). Exported so a
 * hellgate test can assert the VcsEvent→AgentEvent mapping directly.
 */
export const createPassiveVcsStreamSink = (stream: StreamPort): PassiveVcsEventSink => ({
  emit(event: VcsEvent): void {
    const ev: AgentEvent = {
      type: "recovery",
      reason: "vcs_event",
      detail: serializeVcsEvent(event),
    }
    try {
      stream.emit(ev)
    } catch {
      // NO-THROW boundary: best-effort observability, a broken stream must never
      // break the bash turn that produced the event.
    }
  },
})

/** H6 (jun-3-misc §3) — wire the passive-VCS event sink onto `cfg` so the bash
 *  tool's post-exec hook (gated by `QUANTA_PASSIVE_VCS`) forwards classified
 *  git/gh stdout events onto the existing AgentEvent stream. OPT-IN
 *  (`QUANTA_PASSIVE_VCS=1`): off by default for every surface (this assembler is
 *  shared by bench/eval + web-daemon, so a default-ON would change their event
 *  stream + SWE-bench reproducibility). Caller-override-safe (ADR-0332): a
 *  pre-set slot is preserved. Absent gate ⇒ slot stays unset ⇒ the dispatch seam
 *  omits the ctx field, the hook resolves its noop, and the bash post-exec path
 *  is byte-identical (default-OFF). The sink emits onto `cfg.stream` — the SAME
 *  stream the loop's other AgentEvents ride. */
const maybeWireVcsEventSink = (cfg: AgentConfig, env: AssemblerEnv): void => {
  if (!gateOn(env, "QUANTA_PASSIVE_VCS")) return
  if (cfg.vcsEventSink !== undefined) return
  cfg.vcsEventSink = createPassiveVcsStreamSink(cfg.stream)
}

/** ADR-0476 — mint ONE per-session skill→MCP coordinator when opted in
 *  (`QUANTA_SKILL_MCP_DEPS=1`), bound to the REAL stdio launcher + HTTP-SSE
 *  connect port (dual-transport, via `buildSkillMcpSession`). The loop then
 *  reconciles it per turn over the active skills' lifted `dependencies` blocks
 *  and tears it down at session end. Caller-override-safe; absent gate ⇒ slot
 *  stays unset ⇒ reconcile + shutdown are pure no-ops (byte-identical). */
const maybeWireSkillMcp = (cfg: AgentConfig, env: AssemblerEnv): void => {
  if (!skillMcpDepsEnabled(env)) return
  if (cfg.skillMcpSession !== undefined) return
  cfg.skillMcpSession = buildSkillMcpSession(env)
}

/** Single source of truth for "config for this mode" assembly. `env` is the
 *  surface-owned env view (see file header) — this module never reads the
 *  `process.env` global. */
/**
 * Wire the ADR-0347/0358/0360/0372 session-resource + system-prompt-cache +
 * Codex-R2 history block onto a freshly-assembled `cfg`. Extracted verbatim from
 * `assembleAgentConfig` so that closure stays under the god-function line cap;
 * input is the cfg (read for sessionId/metrics/cwd/…, mutated for the wires) +
 * the surface env (for the @file mention resolver). Behaviour-identical — every
 * caller-override-precedence + byte-identical-replay note moved with the code.
 */
const wireSessionResourcesAndCodexR2 = (cfg: AgentConfig, env: AssemblerEnv): void => {
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
  // ALBB-19 #3 — LIVE skill-set side-channel. The `getSnapshot` closure below is
  // captured ONCE at the composition root and reads `cfg.*`; the per-turn active
  // skill set is computed downstream in `context-assembler.ts` and is NOT in this
  // closure's scope. Publish a MUTABLE cursor (mirroring the `metricsEmitter`
  // structural side-channel above) that the loop updates each turn BEFORE
  // consuming `contextEventsForTurn()`; the closure reads `cursor.ids`. Absent
  // update ⇒ stays `[]` ⇒ byte-identical to the frozen-empty legacy behaviour, so
  // `skill_activation` degrades to unreachable (fail-closed) rather than emitting
  // spurious events.
  const skillCursor: { ids: readonly string[] } = { ids: [] }
  ;(cfg as { activeSkillCursor?: { ids: readonly string[] } }).activeSkillCursor = skillCursor
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
        // ALBB-19 #3 — read the LIVE per-turn skill ids published by the loop.
        activeSkills: skillCursor.ids,
      }),
  })
}

export const assembleAgentConfig = (req: AssembleRequest, env: AssemblerEnv): AgentConfig => {
  const policy: ModePolicy = MODE_PRESETS[req.mode]
  assertModeMatrix(policy)

  const presetDials = BUDGET_PRESETS[req.mode]
  // operator dials override preset; both then clamp to caps (with surface log).
  // `QUANTA_MAX_COST_USD` / `QUANTA_MAX_COST_PER_TURN_USD` are operator cost-cap
  // overrides that apply to ANY mode (a positive USD amount, fractional; NO
  // default — absent ⇒ the preset's own dials, byte-identical). They override
  // the preset's maxCostUsd / add a per-turn cap so a human can pin a cost
  // ceiling on an otherwise-uncapped mode (e.g. interactive) without code.
  const merged: BudgetDials = {
    ...presetDials,
    ...(req.dials ?? {}),
    ...envCostDialOverrides(env),
  }
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
      req.base.lspDiagnosticsHookEnabled ?? gateOn(env, "QUANTA_LSP_DIAGNOSTICS_HOOK"),
    // ADR-0412 — resolve the check_secrets tool gate HERE. Caller override on
    // `req.base` wins; otherwise `QUANTA_SECRET_CHECK_TOOL=on`.
    secretCheckToolEnabled:
      req.base.secretCheckToolEnabled ?? gateOn(env, "QUANTA_SECRET_CHECK_TOOL"),
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
  // RFC jun-6 Binding 1 — install the bash sandbox-block escalation handler when
  // `QUANTA_SANDBOX_ESCALATION` is on (else clears any stale handler). Runs AFTER
  // the optional slots so it can read the freshly-resolved `cfg.admissibility`
  // permission store. Knob-OFF ⇒ no handler ⇒ the bash tool is byte-identical.
  maybeWireBashSandboxEscalation(cfg)
  // RFC jun-6 Binding 2 — peer teammate messaging (auto-delivered inbox +
  // team-scoped bus). Wires `cfg.peerInbox` (turn-loop drain), wraps the shared
  // mailbox with the team-membership decorator, mints the team registry, and
  // registers the `team_*` tools — ONLY when `QUANTA_TEAM_PEER_MSG` is on. Runs
  // AFTER `maybeWireMailbox` so it decorates the freshly-wired mailbox. Knob-OFF
  // ⇒ no peerInbox, raw mailbox, no team registry (byte-identical).
  maybeWirePeerTeamMessaging(cfg, env)
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
  // (ADR-0358/0372/0360 + the Codex-R2 install moved into the helper below
  // to keep this closure under the god-function line cap — behaviour-identical.)
  wireSessionResourcesAndCodexR2(cfg, env)
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
