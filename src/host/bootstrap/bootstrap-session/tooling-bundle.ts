/**
 * `@/host/bootstrap/bootstrap-session/tooling-bundle` — what the session can DO:
 * its lifecycle collaborators, its spend meter, and its tool registry.
 *
 * SINGLE RESPONSIBILITY: assemble the capability side of the session in one
 * construction order — the lifecycle bundle (pills / task registry / follow-up
 * queue / activity store / question broker + attention reader), the optional
 * {@link BudgetMeter} that both the memory write-guard and the operator cost cap
 * read, the per-run tool registry those meters feed, the MCP surface descriptor,
 * and the RFC04-2/3 hot-reload feeder that keeps the registry snapshot live.
 * {@link parseOperatorCostDials} lives here because the dials it parses have
 * exactly one consumer: the meter minted below.
 *
 * Split out of `bootstrap-session.ts` (god-module cap) — VERBATIM relocation, no
 * behavior delta. LEAF: it imports no sibling stage, and `bootstrap-session.ts`
 * re-exports `parseOperatorCostDials` so its public import path is unchanged.
 */

import { type AgentConfig, type BudgetDials, BudgetMeter } from "@/agent"
import { relistMcpTools } from "@/agent/mcp-reload-source"
import {
  buildTurnRegistrySnapshot,
  createTurnRegistrySnapshotRef,
  type TurnRegistrySnapshot,
} from "@/agent/turn-registry-snapshot"
import { createMcpToolReloadController } from "@/host/runtime/mcp-tool-reload"
import type { StructuredLogger } from "@/observability"
import type {
  BootstrapFeatures,
  SessionBootstrapDeps,
  SessionFeatureConfig,
  SessionRuntimeConfigShape,
} from "../types"

/** Operator cost-cap dials from env (`QUANTA_MAX_COST_USD` /
 *  `QUANTA_MAX_COST_PER_TURN_USD`): a positive USD amount, fractional allowed,
 *  NO default. An absent/garbage value omits that dial so the meter stays
 *  dial-less (byte-identical). Mirrors the autonomous-mode assembler's override
 *  so the CLI/interactive surface honours the same cost-cap knobs. */
export const parseOperatorCostDials = (env: NodeJS.ProcessEnv): BudgetDials => {
  const pos = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined
    const n = Number.parseFloat(raw.trim())
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const maxCostUsd = pos(env.QUANTA_MAX_COST_USD)
  const maxCostPerTurnUsd = pos(env.QUANTA_MAX_COST_PER_TURN_USD)
  return {
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(maxCostPerTurnUsd !== undefined ? { maxCostPerTurnUsd } : {}),
  }
}

/** RFC04-2/3 (MCP tool hot-reload) — assemble the LIVE feeder when the load
 *  produced reload sources (gated on `QUANTA_MCP_HOT_RELOAD`, so the fields are
 *  present only then). Returns the `TurnRegistrySnapshotRef` (⇒
 *  `AgentConfig.registrySnapshotRef`) or `undefined` (⇒ session-bootstrap builds
 *  from `registry`, byte-identical). Wiring, in order:
 *   1. SEED the atomic snapshot pointer from the connect-time `tooling.registry`
 *      (turn-0 is byte-identical to `buildTurnRegistrySnapshot(registry)`).
 *   2. Build the {@link RebuildSnapshotPort}: relist ALL collected sources →
 *      `tooling.rebuildRegistryWithMcpTools` (the SAME assembly connect used) →
 *      one fresh snapshot. Rejects on any relist failure ⇒ the controller
 *      retains last-known-good (transactional, no partial/empty publish).
 *   3. `createMcpToolReloadController` over the publisher + rebuild port.
 *   4. LATE-BIND the controller into the load-time observer so a live
 *      `tools/list_changed` fires `requestReload`.
 *  Requires `tooling.rebuildRegistryWithMcpTools` (the CLI sets `exposeRebuild`
 *  under the SAME gate); absent ⇒ no feeder (defensive — treated as OFF). */
const buildMcpHotReloadFeeder = (
  features: BootstrapFeatures,
  tooling: ReturnType<SessionBootstrapDeps["buildTooling"]>,
  slog: StructuredLogger,
): AgentConfig["registrySnapshotRef"] | undefined => {
  const sources = features.mcpReloadSources
  const bind = features.bindMcpReloadController
  const rebuildRegistry = tooling.rebuildRegistryWithMcpTools
  // All three are present together under the gate; any absent ⇒ OFF (no feeder).
  if (
    sources === undefined ||
    sources.length === 0 ||
    bind === undefined ||
    rebuildRegistry === undefined
  ) {
    return undefined
  }
  // 1. Seed from the connect-time registry (turn-0 byte-identical).
  const { ref, publish } = createTurnRegistrySnapshotRef(
    buildTurnRegistrySnapshot(tooling.registry),
  )
  // 2. Rebuild port: relist all sources → SAME assembly → snapshot. A relist
  //    rejection propagates so the controller retains last-known-good.
  const rebuild = async (): Promise<TurnRegistrySnapshot> =>
    buildTurnRegistrySnapshot(rebuildRegistry(await relistMcpTools(sources)))
  // 3. Controller over the publisher + rebuild port (single-flight+dirty, LKG,
  //    compare-and-publish — the host application service owns WHEN, never HOW).
  const controller = createMcpToolReloadController({ current: ref.current, publish }, rebuild)
  // 4. Late-bind the controller into the observer wired at load time.
  bind(controller)
  slog.info("mcp.hot_reload.on", { sources: sources.length })
  return ref
}

/** Build the lifecycle bundle, optional budget meter, per-run tooling registry,
 *  and MCP surface descriptor; wire MCP pills when servers are present. Verbatim
 *  relocation of the inline lifecycle/tooling/MCP cluster — same construction
 *  order and the same `lifecyclePills.update` mutation. RFC04-2/3 additionally
 *  builds the hot-reload feeder (⇒ `registrySnapshotRef`) when the load produced
 *  reload sources; gate off ⇒ `undefined` (byte-identical). */
export const buildToolingBundle = (
  deps: SessionBootstrapDeps,
  runtime: SessionRuntimeConfigShape,
  featureCfg: SessionFeatureConfig,
  slog: StructuredLogger,
  features: BootstrapFeatures,
): {
  readonly lifecyclePills: ReturnType<SessionBootstrapDeps["buildLifecycleBundle"]>["pills"]
  readonly lifecycleTaskRegistry: ReturnType<
    SessionBootstrapDeps["buildLifecycleBundle"]
  >["taskRegistry"]
  readonly lifecycleFollowUpQueue: ReturnType<
    SessionBootstrapDeps["buildLifecycleBundle"]
  >["followUpQueue"]
  readonly lifecycleActivityStore: ReturnType<
    SessionBootstrapDeps["buildLifecycleBundle"]
  >["activityStore"]
  readonly lifecycleQuestionBroker: ReturnType<
    SessionBootstrapDeps["buildLifecycleBundle"]
  >["questionBroker"]
  readonly lifecycleAttention: ReturnType<
    SessionBootstrapDeps["buildLifecycleBundle"]
  >["attentionReader"]
  readonly budgetMeter: BudgetMeter | undefined
  readonly tooling: ReturnType<SessionBootstrapDeps["buildTooling"]>
  readonly mcpSurface: ReturnType<SessionBootstrapDeps["buildMcpSurfaceInfo"]>
  readonly registrySnapshotRef: AgentConfig["registrySnapshotRef"] | undefined
} => {
  const {
    pills: lifecyclePills,
    taskRegistry: lifecycleTaskRegistry,
    followUpQueue: lifecycleFollowUpQueue,
    activityStore: lifecycleActivityStore,
    // RFC-01 A4 — the pending-question authority + attention reader, minted by
    // the CLI lifecycle bundle ONLY under `QUANTA_ATTENTION_NAV` (else undefined
    // ⇒ byte-identical). `runtime.env` is the composition-root env bag (DI).
    questionBroker: lifecycleQuestionBroker,
    attentionReader: lifecycleAttention,
  } = deps.buildLifecycleBundle(featureCfg, runtime.env)

  // ADR-0432 — session budget meter for the self-edit memory write-guard.
  // Constructed ONLY when the operator opted in via QUANTA_MEMORY_WRITE_GUARD_PCT
  // (the single activation gate), so the absent-env path constructs NO meter,
  // sets nothing on the config, and is byte-identical to today. The meter has
  // NO dials by itself (so the loop's `checkExhausted` never trips — the CLI's
  // own `maxTurns` remains the sole stop) and serves as the LIVE 0..100
  // `remainingPercent()` source the write-guard reads; the loop's existing
  // tick sites (`config.budgetMeter?.tick(...)`) feed it once it is set on the
  // config in `context-binding.ts`. Without this thread the guard was inert
  // because the surface never supplied a `budgetRemainingPercent` closure.
  const writeGuardActive = runtime.env.QUANTA_MEMORY_WRITE_GUARD_PCT !== undefined
  // Operator cost cap on the interactive/CLI session. This surface is otherwise
  // human-paced (no preset cost dial — see the autonomous-mode assembler for
  // those); `QUANTA_MAX_COST_USD` / `QUANTA_MAX_COST_PER_TURN_USD` let a human
  // pin a dollar ceiling so a long REPL session stops itself. Positive USD, NO
  // default ⇒ absent leaves the meter dial-less (byte-identical: `maxTurns` /
  // the write-guard stay the only stops). When set, the meter carries the cost
  // dials so the loop's `checkExhausted` trips on overrun.
  const costDials = parseOperatorCostDials(runtime.env)
  const hasCostCap = Object.keys(costDials).length > 0
  const budgetMeter =
    writeGuardActive || hasCostCap ? new BudgetMeter({ dials: costDials }) : undefined

  const tooling = deps.buildTooling(
    features.mcpTools,
    features.lspTools,
    features.lspNavTools,
    features.gitToolList,
    features.astGrepTools,
    slog,
    lifecycleTaskRegistry,
    features.metrics,
    budgetMeter !== undefined ? () => budgetMeter.remainingPercent() : undefined,
    lifecycleActivityStore,
    // jul-03 B3 — the REAL provider rate-limit window closure, SEPARATE from the
    // local cost fraction above. Reads the SAME session meter, whose provider tap
    // the loop feeds from `x-ratelimit-*` response headers. Absent meter ⇒ the
    // provider arm stays unarmed (byte-identical).
    budgetMeter !== undefined ? () => budgetMeter.providerRateLimitRemainingPercent() : undefined,
  )

  const mcpSurface = deps.buildMcpSurfaceInfo({
    configs: features.mcpConfigs,
    bridgedTools: features.mcpTools,
    configPath: runtime.mcpConfigPath,
  })

  // RFC04-2/3 (hot-reload) — build the LIVE feeder AFTER the registry exists
  // (the reload observer→controller edge is late-bound). Gate off / no eligible
  // source ⇒ `undefined` ⇒ no ref reaches the config ⇒ session-bootstrap builds
  // the snapshot from `registry` as today (byte-identical).
  const registrySnapshotRef = buildMcpHotReloadFeeder(features, tooling, slog)

  if (features.mcpClients.length > 0) {
    lifecyclePills.update({
      mcp: { servers: [...deps.deriveMcpPillServers(features.mcpTools)] },
    })
  }
  return {
    lifecyclePills,
    lifecycleTaskRegistry,
    lifecycleFollowUpQueue,
    lifecycleActivityStore,
    lifecycleQuestionBroker,
    lifecycleAttention,
    budgetMeter,
    tooling,
    mcpSurface,
    registrySnapshotRef,
  }
}
