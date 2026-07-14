import {
  buildSubagentForkOnAccept,
  defaultProposeHandler,
  defaultStuckDetector,
} from "@/agent/auto-background"
import {
  type ConversationCheckpointStore,
  defaultConversationCheckpointStore,
} from "@/agent/conversation-checkpoint"
import { defaultDelegationRunner } from "@/agent/delegation-runner"
import { defaultCheckpointBaseWire } from "@/agent/fork-session-wire"
import type {
  BackgroundSubagentScheduler,
  SubagentResult,
  SubagentStatus,
} from "@/agent/subagent-background"
import { defaultBackgroundSubagentScheduler } from "@/agent/subagent-background"
import {
  defaultJsonlSchedulerStore,
  persistentBackgroundSubagentScheduler,
} from "@/agent/subagent-persistence-store"
import { defaultResumePolicy, resumeInterruptedHandles } from "@/agent/subagent-resume"
import { createSubagentRunner } from "@/agent/subagent-runner"
import {
  AGENT_MODES,
  type DelegationPort,
  lookupModeProfile,
  wrapSubagentRunner,
} from "@/agent/subagent-typed"
import type { AgentConfig } from "@/agent/types"
import {
  defaultResponsesContinuationStore,
  type Message,
  type ResponsesContinuationStore,
  responsesContinuationLlmPort,
} from "@/llm"
import { gateOn } from "@/shared"
import { assembleConfig, type SessionDeps } from "./assemble/config"

export interface SharedExecutionPlaneArgs {
  readonly history: readonly Message[]
  readonly sessionDeps: SessionDeps
  readonly cwd: string
  readonly envSource: Readonly<Record<string, string | undefined>>
  readonly convStore?: ConversationCheckpointStore
  readonly responsesStore?: ResponsesContinuationStore
}

type SharedExecutionPlaneDeps = Pick<
  AgentConfig,
  | "llm"
  | "conversationCheckpoint"
  | "responsesContinuation"
  | "fork"
  | "forkSession"
  | "delegation"
  | "subagentBackground"
  | "autoBackground"
>

export interface SharedExecutionPlaneRuntimeArgs {
  readonly history: readonly Message[]
  readonly parentConfig: AgentConfig
  readonly subagentConfig?: AgentConfig["subagent"]
  readonly cwd: string
  readonly envSource: Readonly<Record<string, string | undefined>>
  readonly convStore?: ConversationCheckpointStore
  readonly responsesStore?: ResponsesContinuationStore
}

const normalizeBgStatus = (status: string): SubagentStatus =>
  status === "interrupted" || status === "resumed" ? "failed" : (status as SubagentStatus)

const normalizeBgResult = (result: {
  readonly status: string
  readonly outputSummary: string
  readonly outputDetail?: string
  readonly errorMessage?: string
  readonly startedAt: number
  readonly endedAt?: number
  readonly turns: number
}): SubagentResult => ({
  status: normalizeBgStatus(result.status),
  outputSummary: result.outputSummary,
  ...(result.outputDetail !== undefined ? { outputDetail: result.outputDetail } : {}),
  ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
  startedAt: result.startedAt,
  ...(result.endedAt !== undefined ? { endedAt: result.endedAt } : {}),
  turns: result.turns,
})

const parsePositiveInt = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw === "") return undefined
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

const adaptDelegation = (
  cfg: Parameters<typeof createSubagentRunner>[0],
  maxDepth: number | undefined,
): NonNullable<SessionDeps["delegation"]> => {
  const subagentRunner = createSubagentRunner(cfg, maxDepth !== undefined ? { maxDepth } : {})
  // RFC jul-13 P0-b (correctness): thread THIS agent's depth (0 = root) so a
  // delegate child gets `parentDepth + 1`, NOT a hardcoded 0 — mirrors
  // `agent-arg-builder.resolveDelegation` + the foreground `buildChildConfig`
  // convention. Feeds the delegation-runner MAX_DEPTH gate (spec.depth) AND the
  // wrapped SubagentRequest depth (runtime `req.depth > maxDepth` reject).
  const parentDepth = cfg.depth ?? 0
  const runner = defaultDelegationRunner({
    runner: wrapSubagentRunner(subagentRunner, parentDepth),
    ...(maxDepth !== undefined ? { maxDepth } : {}),
  })
  const delegator: DelegationPort = {
    delegate: async (req) =>
      runner.delegate({
        mode: req.mode,
        prompt: req.prompt,
        ...(req.budget !== undefined ? { budget: req.budget } : {}),
        ...(req.parentSignal !== undefined ? { signal: req.parentSignal } : {}),
        ...(req.correlation !== undefined ? { correlation: req.correlation } : {}),
        depth: parentDepth + 1,
      }),
    listModes: () => AGENT_MODES,
    describeMode: (mode) => lookupModeProfile(mode),
  }
  return { delegator, modes: AGENT_MODES }
}

export const buildSharedExecutionPlaneSessionDeps = async (
  args: SharedExecutionPlaneArgs,
): Promise<Partial<SharedExecutionPlaneDeps>> => {
  const parentConfig = assembleConfig([...args.history], args.sessionDeps)
  return await buildSharedExecutionPlaneRuntimeAugments({
    history: args.history,
    parentConfig,
    subagentConfig: args.sessionDeps.subagentConfig,
    cwd: args.cwd,
    envSource: args.envSource,
    ...(args.convStore !== undefined ? { convStore: args.convStore } : {}),
    ...(args.responsesStore !== undefined ? { responsesStore: args.responsesStore } : {}),
  })
}

export const buildSharedExecutionPlaneRuntimeAugments = async (
  args: SharedExecutionPlaneRuntimeArgs,
): Promise<Partial<SharedExecutionPlaneDeps>> => {
  const convStore = args.convStore ?? defaultConversationCheckpointStore()
  const responsesStore = args.responsesStore ?? defaultResponsesContinuationStore()
  const forkWire = defaultCheckpointBaseWire({ store: convStore })
  const base: Partial<SharedExecutionPlaneDeps> = {
    llm: responsesContinuationLlmPort({ inner: args.parentConfig.llm, store: responsesStore }),
    conversationCheckpoint: { store: convStore },
    responsesContinuation: { store: responsesStore },
    fork: { forker: forkWire.base },
    forkSession: { forker: forkWire.forker },
  }

  const subagentCfg = args.subagentConfig
  if (subagentCfg === undefined) return base

  const childRunner = createSubagentRunner(
    args.parentConfig,
    subagentCfg.maxDepth !== undefined ? { maxDepth: subagentCfg.maxDepth } : {},
  )
  const maxConcurrent = parsePositiveInt(args.envSource.QUANTA_BG_MAX_CONCURRENT)
  const maxRetained = parsePositiveInt(args.envSource.QUANTA_BG_MAX_RETAINED)
  // ADR-0487 — opt into the admission wait-queue when QUANTA_SUBAGENT_QUEUE is
  // on; absent ⇒ over-cap fork throws-at-cap (byte-identical pre-queue behavior).
  // `maxQueued` (QUANTA_BG_MAX_QUEUED) is consulted ONLY when the queue is on;
  // absent ⇒ the scheduler's built-in DEFAULT_MAX_QUEUED (64) — no behavior shift
  // on the default-OFF path.
  const admissionQueue = gateOn(args.envSource, "QUANTA_SUBAGENT_QUEUE")
  const maxQueued = parsePositiveInt(args.envSource.QUANTA_BG_MAX_QUEUED)
  // INV-09/INV-10 (jul-14 resume-depth-preservation): the REAL depth every bg
  // child forked through this scheduler runs at. The inner scheduler is built
  // FROM the parent config, so a child runs at `parentDepth + 1` (0 = root).
  // This is BOTH the capture value (persist-time `handle.depth`) AND the
  // resume-fork depth the lineage guard enforces against — SAME source, so a
  // handle persisted by THIS process resumes iff the resume-time scheduler
  // would re-derive the same depth. Under the shipping cap=1 default this is
  // always 1 and the guard is inert-but-correct; it bites under cap>=2.
  const childDepth = (args.parentConfig.depth ?? 0) + 1
  const inner = defaultBackgroundSubagentScheduler({
    runner: childRunner,
    // Phase 0-a (jul-13 nesting-control RFC §6.5): scheduler is built FROM the
    // parent config, so background children run at `parentDepth + 1` (0 = root),
    // reviving the runner's `req.depth > maxDepth` reject.
    parentDepth: args.parentConfig.depth ?? 0,
    ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
    ...(maxRetained !== undefined ? { maxRetained } : {}),
    ...(admissionQueue ? { admissionQueue: true } : {}),
    ...(admissionQueue && maxQueued !== undefined ? { maxQueued } : {}),
  })
  const store = defaultJsonlSchedulerStore(
    args.envSource.QUANTA_BG_STORE_DIR !== undefined
      ? { baseDir: args.envSource.QUANTA_BG_STORE_DIR }
      : undefined,
  )
  const persistent = await persistentBackgroundSubagentScheduler({
    inner,
    store,
    workspace: args.cwd,
    // INV-09/INV-10 persist-time capture: stamp every persisted handle with the
    // real lineage depth so a later resume can enforce depth preservation.
    childDepth,
  })
  // ADR-0159 work-resume wiring (GROUP B1): if QUANTA_SUBAGENT_RESUME is on,
  // sweep interrupted handles from the previous process and re-fork them via
  // the freshly-constructed persistent scheduler.  default-OFF: absent or "0"
  // ⇒ byte-identical (no store reads, no forks).
  if (gateOn(args.envSource, "QUANTA_SUBAGENT_RESUME")) {
    // `persistent.fork` is structurally compatible with `BackgroundSubagentScheduler.fork`.
    // ResumerOpts.scheduler is narrowed to `Pick<..., "fork">` so no cast needed.
    const resumeOutcomes = await resumeInterruptedHandles({
      scheduler: persistent,
      store,
      policy: defaultResumePolicy(),
      workspace: args.cwd,
      // INV-09/INV-10 LIVE guard: enforce lineage-depth preservation at the
      // resume trigger. `resumeForkDepth` is the SAME `childDepth` this process
      // would re-derive a resumed fork at (= parentDepth+1), so a handle
      // persisted by a shallower/deeper parent — or a legacy depth-less handle —
      // is DENIED rather than silently re-derived to a possibly-shallower depth
      // (spawn-authority escalation). NOT default-OFF: the guard is always
      // wired; under cap=1 it is inert-but-correct (every child is depth-1).
      lineageGuard: { resumeForkDepth: childDepth },
    })
    // Evict the stale "interrupted" cache entries only for handles where the
    // sweep actually forked a new handle (action === "resume").
    // For "skip" and "ask-user" the orchestrator took no action — the store
    // was NOT written and the interrupted handle is still valid state that
    // the user or system needs to inspect.  Evicting those entries would
    // remove a live entry from list()/poll() without any corresponding store
    // update, leaving the caller with an inconsistent view.
    // For "mark-failed" the store was written (new "failed" snapshot), so the
    // in-memory interrupted entry IS stale and should also be evicted.
    for (const outcome of resumeOutcomes) {
      if (outcome.decision.action === "resume" || outcome.decision.action === "mark-failed") {
        persistent.evictInterrupted(outcome.id)
      }
    }
  }
  const scheduler: BackgroundSubagentScheduler = {
    fork: (spec) => persistent.fork(spec),
    poll: (id) => {
      const result = persistent.poll(id)
      return result === null ? null : normalizeBgResult(result)
    },
    await: async (id, opts) => {
      const result = await persistent.await(id, opts)
      return result === null ? null : normalizeBgResult(result)
    },
    cancel: (id) => persistent.cancel(id),
    // ADR-0487 — passthrough the admission-queue promoter (no-throw).
    forceBackground: (id, forceOpts) => persistent.forceBackground(id, forceOpts),
    list: () =>
      persistent.list().map((entry) => ({
        ...entry,
        result: normalizeBgResult(entry.result),
      })),
    prune: (maxAgeMs) => persistent.prune(maxAgeMs),
    serialize: () => persistent.serialize(),
    hydrate: (json) => persistent.hydrate(json),
    hydrateWithPrune: (json, maxAgeMs) => persistent.hydrateWithPrune(json, maxAgeMs),
  }

  const thresholdMs = parsePositiveInt(args.envSource.QUANTA_AUTO_BACKGROUND_THRESHOLD_MS)
  const detector = defaultStuckDetector(thresholdMs !== undefined ? { thresholdMs } : {})
  const onAccept = buildSubagentForkOnAccept({ scheduler })
  const proposer = defaultProposeHandler({
    detector,
    ...(onAccept !== undefined ? { onAccept } : {}),
  })

  return {
    ...base,
    delegation: adaptDelegation(args.parentConfig, subagentCfg.maxDepth),
    subagentBackground: { scheduler },
    autoBackground: {
      detector,
      proposer,
      ...(thresholdMs !== undefined ? { thresholdMs } : {}),
      ...(onAccept !== undefined ? { onAccept } : {}),
    },
  }
}
