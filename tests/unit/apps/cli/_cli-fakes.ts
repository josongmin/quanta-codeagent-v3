/**
 * Typed CLI-surface fake builders (audit R3 LOW-4).
 *
 * WHY. The heaviest CLI suites stubbed whole dependency records with blanket
 * `as never` (`approval-verb-parity-hellgate` 21×, `approval-flow-cli` 17×,
 * `multi-plane-e2e-hellgate` 21×). A blanket `as never` erases the REAL type:
 * when a required field is widened/added on `SessionSetupResult` /
 * `CliHitlDeps`, the fake keeps compiling and the drift surfaces as a RUNTIME
 * undefined-read (or worse, a silently-vacuous assertion). These builders
 * satisfy the REAL types with compile-checked shapes, so a future widening
 * breaks COMPILE, not runtime.
 *
 * Convention: tests-side helper module (underscore prefix, no `.test.ts`
 * suffix — never collected as a suite), colocated next to its biggest
 * consumers in `tests/unit/apps/cli/`.
 */

import { createActivityStore } from "@/activity"
import { createEffortStore } from "@/agent"
import { createBriefStore } from "@/agent/brief"
import type { IdleMonitor } from "@/apps/cli/idle-monitor"
import type { LifecyclePills } from "@/apps/cli/lifecycle-pills"
import type { RejectCounter } from "@/apps/cli/reject-counter"
import type { CliFeatureConfig } from "@/apps/cli/repl/cli-feature-config"
import { createContextUsageHolder } from "@/apps/cli/repl/context-usage-snapshot"
import {
  createMidTurnApprovalChannel,
  type MidTurnApprovalChannel,
  type MidTurnLineResult,
} from "@/apps/cli/repl/mid-turn-approval-channel"
import type { __testing } from "@/apps/cli/repl/runtime-context-compose"
import type { SessionSetupResult } from "@/apps/cli/repl/session-setup"
import type { StatusBar } from "@/apps/cli/status-bar"
import type { StatusPills } from "@/apps/cli/status-pills"
import type { TurnIndicator } from "@/apps/cli/turn-indicator"
import type { TurnSummaryCollector } from "@/apps/cli/turn-summary"
import type { LLMPort, StreamEvent } from "@/llm"
import { StructuredLogger } from "@/observability"
import type { RuntimeContext } from "@/sdk/runtime"
import { ToolRegistry } from "@/tool"

/* ── CliHitlDeps (approval prompt / inline confirm) ─────────────────────────── */

/** The REAL (unexported) `CliHitlDeps` shape, derived from the prompt builder
 *  the tests exercise — so this alias tracks the source of truth by
 *  construction. A widening of `CliHitlDeps` re-types this alias and every
 *  fake built from it. */
export type FakeCliHitlDeps = Parameters<typeof __testing.buildCliApprovalPrompt>[0]

export const makeFakeIdleMonitor = (overrides: Partial<IdleMonitor> = {}): IdleMonitor => ({
  markActive: () => undefined,
  isIdle: () => false,
  snooze: () => undefined,
  unsnooze: () => undefined,
  isSnoozed: () => false,
  reset: () => undefined,
  ...overrides,
})

export const makeFakeRejectCounter = (overrides: Partial<RejectCounter> = {}): RejectCounter => ({
  recordDeny: () => 0,
  recordAccept: () => undefined,
  count: () => 0,
  shouldAutoExit: () => false,
  reset: () => undefined,
  ...overrides,
})

/** A scripted mid-turn channel: each `awaitLine` consumes the next entry (a
 *  raw line or a typed release). Captures the labels consumers pass (C2).
 *  Each ask is instantly head (script = instant answers), so its `onActive`
 *  render hook fires synchronously — consumers render THROUGH the hook since
 *  the C2 queue landing, so a fake that skipped it would suppress every
 *  prompt the suites assert on. */
export const makeScriptedChannel = (
  script: readonly (string | MidTurnLineResult)[],
): { channel: MidTurnApprovalChannel; labels: (string | undefined)[] } => {
  const queue = [...script]
  const labels: (string | undefined)[] = []
  return {
    labels,
    channel: {
      active: true,
      awaitLine: async (
        _signal?: AbortSignal,
        label?: string,
        onActive?: () => void,
      ): Promise<MidTurnLineResult> => {
        labels.push(label)
        onActive?.() // instantly head — render now
        const next = queue.shift()
        if (next === undefined) throw new Error("channel script exhausted — prompt over-asked")
        return typeof next === "string" ? { kind: "line", line: next } : next
      },
      tryResolve: () => false,
      clear: () => {},
    },
  }
}

/** Compile-checked `CliHitlDeps` fake. Defaults are inert; override the
 *  channel with {@link makeScriptedChannel} to script operator answers. */
export const makeFakeCliHitlDeps = (overrides: Partial<FakeCliHitlDeps> = {}): FakeCliHitlDeps => ({
  idleMonitor: makeFakeIdleMonitor(),
  rejectCounter: makeFakeRejectCounter(),
  channel: makeScriptedChannel([]).channel,
  cwd: "/tmp/quanta-cli-hitl-fake",
  ...overrides,
})

/* ── SessionSetupResult (session-loop fixtures) ─────────────────────────────── */

export const makeFakeStatusBar = (overrides: Partial<StatusBar> = {}): StatusBar => ({
  setDefault: () => undefined,
  transient: () => undefined,
  clearTransient: () => undefined,
  teardown: () => undefined,
  ...overrides,
})

export const makeFakeTurnIndicator = (overrides: Partial<TurnIndicator> = {}): TurnIndicator => ({
  start: () => undefined,
  stop: () => undefined,
  updateUsage: () => undefined,
  markFirstChunk: () => undefined,
  ...overrides,
})

export const makeFakeTurnSummary = (
  overrides: Partial<TurnSummaryCollector> = {},
): TurnSummaryCollector => ({
  onEvent: () => undefined,
  render: () => "",
  reset: () => undefined,
  asStreamPort: () => ({ emit: () => undefined }),
  ...overrides,
})

export const makeFakeLifecyclePills = (
  overrides: Partial<LifecyclePills> = {},
): LifecyclePills => ({
  update: () => undefined,
  render: () => "",
  flush: () => undefined,
  dispose: () => undefined,
  ...overrides,
})

export const makeFakeStatusPills = (overrides: Partial<StatusPills> = {}): StatusPills => ({
  update: () => undefined,
  render: () => "",
  dispose: () => undefined,
  ...overrides,
})

/** Minimal REAL `LLMPort` — yields one terminal `message_stop`. (The blanket
 *  `as never` fake this replaces carried a `stopReason` field the wire union
 *  spells `stop_reason` — exactly the drift class typed fakes exist to catch.) */
export const makeFakeLlm = (overrides: Partial<LLMPort> = {}): LLMPort => ({
  model: "fake-test-model",
  stream: async function* (): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  },
  ...overrides,
})

/** Quiet, REAL `StructuredLogger` (class is nominally typed — a structural
 *  stub cannot satisfy it). Error-threshold + no-op sink ⇒ silent. */
export const makeFakeSlog = (): StructuredLogger =>
  new StructuredLogger({ level: "error", sink: () => undefined })

/** Compile-checked `CliFeatureConfig` with every feature OFF (mirrors the
 *  values the migrated fixtures shipped, plus the previously-MISSING required
 *  fields the blanket cast was hiding: `decisionMetricsEnabled`,
 *  `ratelimitNotice`, `timelinePanel`). */
export const makeFakeFeatureCfg = (
  overrides: Partial<CliFeatureConfig> = {},
): CliFeatureConfig => ({
  pills: { enabled: false, hideTasks: false, hideFollowUp: false, hideMcp: false },
  subagentForPills: false,
  costPanel: { enabled: false },
  branchProgress: { enabled: false },
  planStore: { enabled: false },
  workMetricsSinkEnabled: false,
  decisionMetricsEnabled: false,
  turnSummary: { enabled: false, verbose: false },
  turnIndicator: { enabled: false, intervalMs: 80 },
  ratelimitNotice: { enabled: false },
  debugTracer: { enabled: false, categories: undefined, stderrIsTTY: false },
  timelinePanel: { enabled: false, height: 0 },
  imageQueue: { enabled: true, maxSize: 5 },
  history: { enabled: true, maxLines: 1000, filePath: undefined },
  multiline: { enabled: true },
  rewindGit: { enabled: false },
  ...overrides,
})

/** Inert, compile-checked `RuntimeContext`. `createRuntimeFacade` throws —
 *  a loop fixture MUST override it with its scripted facade (throwing beats a
 *  silently-succeeding phantom runtime). */
export const makeFakeRuntimeContext = (
  overrides: Partial<RuntimeContext> = {},
): RuntimeContext => ({
  createRuntimeFacade: async () => {
    throw new Error("makeFakeRuntimeContext: override createRuntimeFacade in the test")
  },
  materializeReviewerAgent: () => undefined,
  registry: () => new ToolRegistry([]),
  permissionMode: () => "default",
  permissionModeState: () => undefined,
  automationEngine: () => undefined,
  toolProfileState: () => undefined,
  identityModeState: () => undefined,
  focusChain: () => undefined,
  stickyModelStore: () => undefined,
  decisionEmitter: () => undefined,
  admissibility: () => undefined,
  planExitPort: () => undefined,
  userInputPort: () => undefined,
  dreamTrigger: () => undefined,
  ...overrides,
})

/** Compile-checked `SessionSetupResult` fake. Every required field carries a
 *  typed inert default; tests override the slots they exercise. A future
 *  REQUIRED field added to `SessionSetupResult` breaks THIS builder's compile
 *  (the audit-R1 "WS-G widened SessionSetupResult" incident, but caught at
 *  tsc time instead of CI-red). */
export const makeFakeSessionSetup = (
  overrides: Partial<SessionSetupResult> = {},
): SessionSetupResult => ({
  provider: "openai",
  model: "test-model",
  mode: "default",
  cwd: "/tmp/test-cwd",
  slog: makeFakeSlog(),
  idleMonitor: makeFakeIdleMonitor(),
  rejectCounter: makeFakeRejectCounter(),
  effortStore: createEffortStore(),
  briefStore: createBriefStore(),
  llm: makeFakeLlm(),
  planMode: false,
  providerRateLimitRemainingPercent: undefined,
  metrics: undefined,
  state: undefined,
  mcpClients: [],
  mcpTools: [],
  mcpSurface: undefined,
  skillsConfig: undefined,
  memoryStore: undefined,
  memoryEmbedder: undefined,
  projectsKbStore: undefined,
  mcpResourceCapture: undefined,
  mcpHealth: undefined,
  liveModelSource: { source: () => "test-model" },
  searchPipelineDispose: undefined,
  lifecyclePills: makeFakeLifecyclePills(),
  lifecycleTaskRegistry: undefined,
  // The REAL store — pure in-memory reducer, cheaper than a hand fake and
  // structurally guaranteed to track `ActivityStore` widenings.
  lifecycleActivityStore: createActivityStore(),
  lifecycleFollowUpQueue: undefined,
  sessionId: "fake-session",
  history: [],
  pendingImages: [],
  idMeta: undefined,
  statusBar: makeFakeStatusBar(),
  turnIndicator: makeFakeTurnIndicator(),
  contextUsageHolder: createContextUsageHolder(),
  turnSummary: makeFakeTurnSummary(),
  debugHandle: undefined,
  timelinePanel: undefined,
  backgroundStreamCapture: undefined,
  approvalPrompt: async () => {
    throw new Error("makeFakeSessionSetup: override approvalPrompt in the test")
  },
  midTurnApprovalChannel: createMidTurnApprovalChannel(),
  runtimeContext: makeFakeRuntimeContext(),
  permissionStore: undefined,
  hunkUndoStore: undefined,
  costPanel: undefined,
  branchProgress: undefined,
  planStore: undefined,
  abort: new AbortController(),
  pills: makeFakeStatusPills(),
  argPrompt: undefined,
  stderrIsTTY: false,
  homeDir: "/tmp",
  systemSource: { get: () => "SYS", set: () => undefined },
  refreshSystemPrompt: () => undefined,
  shutdownMcp: async () => undefined,
  playbookCliFlag: undefined,
  featureCfg: makeFakeFeatureCfg(),
  ...overrides,
})
