import type { AgentMode } from "@/agent"
import type { ModelRoutingAuthority } from "@/agent/model-routing"
import type { StickyModelStore } from "@/agent/sticky-model"
import { type ModelCandidate, type Provider, type StreamEvent, tryCreateLLM } from "@/llm"
import { PATCH_SENTINELS } from "@/patch/types"
import { InMemoryRadarStore, JsonlFileRadarStore, type RadarStore } from "@/radar"
import { decorateSwappableModelPort } from "@/runner/assemble"
import {
  loadSessionById,
  type SavedSession,
  type SessionEnvelopeRecord,
  saveSessionById,
} from "@/session"
import { emitOperatorNotice, errMessage, gateOn, logger } from "@/shared"
import type { SessionIoState } from "../../session-cmd"
import type { SlashContext } from "../../slash-commands"
import { buildModelAdapter } from "../ctx-adapters/model-adapter"
import type { ReplaySlashState } from "../slash-surface"

/** ADR-0231 — default long-task threshold (ms) the radar idle/long-task
 *  heuristic uses when `QUANTA_RADAR_TASK_MS` is unset. 30s mirrors the
 *  "this turn took a while, a review may help" intent of the sample heuristic. */
export const DEFAULT_RADAR_TASK_DURATION_MS = 30_000

/** ADR-0231 — resolve the long-task threshold (ms) from `QUANTA_RADAR_TASK_MS`.
 *  Invalid / unset ⇒ {@link DEFAULT_RADAR_TASK_DURATION_MS}. */
export const radarTaskDurationThresholdMs = (env: NodeJS.ProcessEnv): number => {
  const raw = env.QUANTA_RADAR_TASK_MS
  if (raw === undefined) return DEFAULT_RADAR_TASK_DURATION_MS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RADAR_TASK_DURATION_MS
}

/** ADR-0231 — build the gated radar proposal-queue store. Returns `undefined`
 *  when `QUANTA_RADAR` is off (default-OFF byte-identical: neither the slash
 *  slot nor the producer block is wired). When on, a `JsonlFileRadarStore`
 *  (persistent, 0600) iff `QUANTA_RADAR_FILE` is set, else an
 *  `InMemoryRadarStore`. `crypto.randomUUID` ids in production (stable across
 *  restarts is not required for the in-memory adapter). */
export const buildRadarStore = (env: NodeJS.ProcessEnv): RadarStore | undefined => {
  if (!gateOn(env, "QUANTA_RADAR")) return undefined
  const filePath = env.QUANTA_RADAR_FILE
  if (filePath !== undefined && filePath.length > 0) {
    return new JsonlFileRadarStore({
      filePath,
      mintId: () => crypto.randomUUID(),
      onWarn: (msg) => logger.warn(msg),
    })
  }
  return new InMemoryRadarStore({ mintId: () => crypto.randomUUID() })
}

/** `/retry-with` — parse `QUANTA_RETRY_MODELS` (comma-separated model ids) into
 *  {@link ModelCandidate}s for the current provider. The current model is
 *  prepended so `resolveRetryModel` can escalate past it. Each port is built
 *  via {@link tryCreateLLM}; a candidate whose provider key is missing is
 *  dropped (null) rather than crashing the surface. Returns `[]` when the env
 *  knob is unset/empty ⇒ the slot is omitted ⇒ `/retry-with` prints
 *  "no model candidates configured" (default-OFF).
 *
 *  MR-07 — every port is DECORATED ({@link decorateSwappableModelPort}), not a
 *  bare adapter. These candidates are no longer `/retry-with`-only: `core-state`
 *  hands them to `buildModelCatalogWire` as `seeded`, whose ports are taken
 *  VERBATIM (the catalog only mints its own for probe-discovered ids). So a
 *  `/model` pick of a `QUANTA_RETRY_MODELS` id used to swap the whole turn onto an
 *  UNDECORATED adapter — no bounded retry (a transient 429 became a hard turn
 *  failure), no empty-stream circuit breaker (the silent token-burn guard), no
 *  progress heartbeat — while a probe-discovered pick of the identical shape got
 *  all three from the catalog's `buildPort`. That is the hole in INVARIANT B
 *  (`model-catalog.ts`); routing through the SAME helper the catalog's `buildPort`
 *  uses closes it at the one place these ports are minted.
 *
 *  No `signal` is passed: this builder's signature takes none (the surface's
 *  teardown signal is not in scope here), and `decorateSwappableModelPort` treats
 *  it as optional — the wrappers are applied identically, only `RetryingLLM`'s
 *  backoff loses early-abort-on-teardown. Ordering ("current model first, dedup")
 *  and the null-port drop are unchanged. */
export const buildRetryCandidates = (
  env: NodeJS.ProcessEnv,
  provider: Provider,
  currentModelId: string,
): ModelCandidate[] => {
  const raw = env.QUANTA_RETRY_MODELS
  if (raw === undefined || raw.trim() === "") return []
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (ids.length === 0) return []
  // De-dup while keeping the current model first.
  const ordered = [currentModelId, ...ids.filter((id) => id !== currentModelId)]
  const out: ModelCandidate[] = []
  for (const id of ordered) {
    const inner = tryCreateLLM(provider, { model: id }, env)
    if (inner !== null) out.push({ id, port: decorateSwappableModelPort({ inner }) })
  }
  return out
}

/**
 * Ticket 14 (§11.6) — build the `/model` picker adapter wire from the narrow
 * slice the surface owns. Extracted from the inline compose IIFE so the
 * mode-implicit SET binding is REGRESSION-TESTABLE in isolation (the inline
 * version had no test driving `composeSurfaceWires`, so the `currentMode`
 * fix could silently revert to `() => "default"` and stay green).
 *
 * Binds the SET to the SAME mode derivation the consume side reads: the caller
 * passes `sticky-model-boot#liveAgentMode`, which mirrors the loop's
 * `resolveLiveAgentMode` — the LIVE `agentModeState` cell (the shift+tab mode
 * cycle, CLI-seeded default-ON) wins, then `mode`/`planMode`.
 *
 * aug-28 CORRECTION: this docblock previously asserted that the consume side was
 * `resolveAgentMode(config.mode, config.planMode)` and that "the mode-cycle store
 * drives permissionMode not config.mode". Both halves became false when §17
 * packet M wired `agentModeState` from that very store, and the mismatch made a
 * `/model` pick a silent no-op the moment the operator changed rung (and under
 * `--plan`). Absent store ⇒ adapter omitted ⇒ `/model` prints "not wired".
 *
 * The candidate ids arrive as a LIVE getter over the surface's model-catalog
 * wire (aug-27) — the same list threaded onto `AgentConfig.modelCandidates`, so
 * every id the picker offers provably has a port on the consume side.
 *
 * NO `currentModel` getter is supplied (residual, ticket-14 finding #2). The
 * adapter's `current()` is SYNCHRONOUS, but the ONLY cross-session source of an
 * effective model is the sticky store, whose entire port surface is ASYNC by
 * contract (`get`/`set`/`load` return Promises — the fs-backed impl does disk
 * IO) — and `runtimeContext` exposes no synchronous effective-model snapshot
 * accessor. A store-reading getter could therefore only return a Promise, which
 * a sync `current()` cannot use. So `current()` anchors to the boot model until
 * the first IN-SESSION set (after which the adapter's own per-mode SYNC SHADOW
 * reflects it). Cross-session reflection of a previously-persisted sticky model
 * on a FRESH session would require a sync sticky-snapshot accessor that does not
 * exist at this seam; faking it with the async store is intentionally NOT done.
 */
export const buildModelAdapterWire = (args: {
  readonly stickyStore: { readonly store: StickyModelStore } | undefined
  /** MR-02 — THE routing authority the `/model` adapter reads and mutates through. */
  readonly routing: ModelRoutingAuthority
  readonly bootModel: string
  /** THE live agent-mode getter (`sticky-model-boot#liveAgentMode`) — the SAME
   *  precedence the loop's `resolveLiveAgentMode` uses (live cell ⇒ planMode).
   *  Passing the derivation in (rather than re-deriving from `planMode` here) is
   *  what stops the write key and the read key from drifting when the operator
   *  presses shift+tab. */
  readonly currentMode: () => AgentMode
  /** The session's provider — part of the sticky key (see `StickyModelKey`). */
  readonly provider?: string
  /** LIVE candidate ids — a GETTER, not a snapshot, so ids the provider-catalog
   *  probe adds after boot appear in the picker (a boot-time array copy would
   *  freeze the list at "boot model + QUANTA_RETRY_MODELS", which is exactly the
   *  state where `/model` can list but never switch). */
  readonly candidateIds: () => readonly string[]
  /** Awaited by `/model` before it lists or resolves, so the FIRST `/model` pays
   *  the catalog round-trip and later ones read the adapter's memo. Absent ⇒ no
   *  probe (the seeded ids are the whole candidate set). */
  readonly refresh?: () => Promise<void>
}): { modelAdapter?: SlashContext["model"] } => {
  if (args.stickyStore === undefined) return {}
  return {
    modelAdapter: buildModelAdapter({
      routing: args.routing,
      bootModel: args.bootModel,
      currentMode: args.currentMode,
      ...(args.provider !== undefined ? { provider: args.provider } : {}),
      candidateIds: args.candidateIds,
      ...(args.refresh !== undefined ? { refresh: args.refresh } : {}),
    }),
  }
}

/** `/retry-with` onEvent renderer — print the alternate model's streamed text
 *  to stdout (read-only preview; the live transcript is never mutated). Only
 *  text deltas surface; control events are ignored. */
export const renderRetryEvent = (ev: StreamEvent): void => {
  if (ev.type === "text_delta") process.stdout.write(ev.delta)
  else if (ev.type === "message_stop") process.stdout.write("\n")
}

/** Track R — build the `/replay` resolver+iterator pair. Default reader is
 *  lazy-imported so `@/session` is not pulled into the boot path for users
 *  who never type `/replay`. The composer un-wraps the {@link iterateSessionFile}
 *  `Result` shape into a bare `AsyncIterable<SessionEnvelopeRecord>` — decode
 *  errors are skipped (the projector inside `/inspect` surfaces detailed
 *  warnings; `/replay` is a one-line-per-event view that omits the bad row)
 *  but WS-G (UUX-1-27) no longer SILENTLY: the skips are counted and one warn
 *  notice with the total lands on the operator-notice bus when the iteration
 *  finishes, so a truncated/older-version file never replays as if complete.
 *  The resolver returns `undefined` when the path doesn't exist so the
 *  command renders "session <id> not found" + exit 1. */
export const buildReplaySlashState = (): ReplaySlashState => ({
  resolveSession: async (id: string): Promise<string | undefined> => {
    const { sessionEnvelopePath } = await import("@/session")
    const path = sessionEnvelopePath(id)
    const file = Bun.file(path)
    return (await file.exists()) ? path : undefined
  },
  iterate: (path: string): AsyncIterable<SessionEnvelopeRecord> => {
    const inner = async function* (): AsyncIterable<SessionEnvelopeRecord> {
      const { iterateSessionFile } = await import("@/session")
      let skipped = 0
      for await (const r of iterateSessionFile(path)) {
        if (r.ok) yield r.value
        else skipped++
      }
      if (skipped > 0) {
        emitOperatorNotice({
          severity: "warn",
          source: "/replay",
          message: `skipped ${skipped} malformed session record${skipped === 1 ? "" : "s"}`,
          hint: "the file may be truncated or from an older version; /inspect shows details",
        })
      }
    }
    return inner()
  },
})

/** ADR-0310/0294 — session-io adapter for `/session export|import`. Default
 *  adapter delegates to the existing `loadSessionById`/`saveSessionById`
 *  primitives (id-addressable V2 store). Every method is no-throw on the
 *  public surface — read failure surfaces as `null`; write failures bubble
 *  up to the slash, which already wraps them in typed `ctx.err` + exit 1. */
export const buildDefaultSessionIo = (): SessionIoState => ({
  readSession: async (id: string): Promise<SavedSession | null> => {
    try {
      const found = await loadSessionById(id)
      return found ?? null
    } catch (e) {
      logger.warn(`sessionIo.readSession failed: ${errMessage(e)}`)
      return null
    }
  },
  writeSession: async (id: string, session: SavedSession): Promise<void> => {
    try {
      // saveSessionById takes (meta, payload, provider). Reconstruct the
      // payload from the SavedSession the slash hands us. The slash rewrites
      // `meta.id` to `id` before calling so the two MUST agree here.
      const meta = session.meta.id === id ? session.meta : { ...session.meta, id }
      await saveSessionById(meta, {
        reason: session.reason,
        turns: session.turns,
        messages: session.messages,
        // RFC-01 A2 — this write REPLACES the target with the handed session, so
        // thread its durable rollback ledger EXPLICITLY (the payload-wins path).
        // Without this, importing a session that carries rollback records would
        // write it with an empty ledger to a fresh id (store preserve-on-omit
        // only guards the auto-save/crash-resume callers, which have none in-hand).
        ...(session.rollbackCheckpoints !== undefined
          ? { rollbackCheckpoints: session.rollbackCheckpoints }
          : {}),
        ...(session.rollbackOperations !== undefined
          ? { rollbackOperations: session.rollbackOperations }
          : {}),
        // RFC-03 C2 — an imported session carries its durable objective snapshot;
        // thread it EXPLICITLY (the payload-wins path) so `/session import` never
        // drops the goal. Without this, importing a session that carries an
        // objective would write a fresh id with an empty objective (store
        // preserve-on-omit only guards the auto-save callers, which have none
        // in-hand). Absent ⇒ omitted ⇒ byte-identical.
        ...(session.objective !== undefined ? { objective: session.objective } : {}),
      })
    } catch (e) {
      // Rethrow so the slash surfaces the error message — this matches the
      // contract documented in session-cmd.ts (the slash wraps in try/catch
      // and prints to ctx.err + exit 1).
      throw e instanceof Error ? e : new Error(errMessage(e))
    }
  },
  mintNewId: (): string => crypto.randomUUID(),
})

/** Extract the file paths a V4A `apply_patch` would touch, by scanning the
 *  patch text for `*** Add File:` / `*** Update File:` / `*** Delete File:` /
 *  `*** Move to:` directive headers (the SSOT sentinels from `@/patch/types`).
 *
 *  The per-tool snapshot recorder needs a `filesBefore` set so `/rewind-tool`
 *  can revert a mutation. `apply_patch` input is `{ patch }` (NOT `{ path }`),
 *  so the conservative `path`-only extractor below would capture NOTHING and
 *  silently leave apply_patch un-restorable. Both the Update *source* AND the
 *  `Move to:` *destination* are captured: the source must be snapshotted (its
 *  prior contents), and the move destination is created — capturing it lets a
 *  restore delete the moved-in file. Deduped, order-preserving. */
export const extractApplyPatchPaths = (patch: string): readonly string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (raw: string): void => {
    const p = raw.trim()
    if (p.length > 0 && !seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  for (const line of patch.split("\n")) {
    if (line.startsWith(PATCH_SENTINELS.addFile)) push(line.slice(PATCH_SENTINELS.addFile.length))
    else if (line.startsWith(PATCH_SENTINELS.updateFile))
      push(line.slice(PATCH_SENTINELS.updateFile.length))
    else if (line.startsWith(PATCH_SENTINELS.deleteFile))
      push(line.slice(PATCH_SENTINELS.deleteFile.length))
    else if (line.startsWith(PATCH_SENTINELS.moveTo))
      push(line.slice(PATCH_SENTINELS.moveTo.length))
  }
  return out
}
// NOTE (S3, jul-03): the former `createPromptAssembledHolder` / `breakdownFromSnapshot`
// lived here. They were consolidated away — `/context` now reads the single
// `createContextUsageHolder` instance (see `repl/context-usage-snapshot.ts`),
// created at `setupSession` so its `observeUsage` can be teed onto the indicator
// port for the S3 reasoning-token split. The prior two-holder split left one
// holder inert (its `.sink` had no loop consumer) and gave `/context` a holder
// with no reasoning support; one live holder now backs `/context`, the
// pre-compaction warning, and the reasoning annotation.
