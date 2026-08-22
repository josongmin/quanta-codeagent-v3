import type { AgentConfig } from "@/agent"
import { isIdentityMode } from "@/agent/identity"
import { isToolProfileName } from "@/agent/tool-profile"
import type {
  SessionHost,
  SessionHostSideConversationArgs,
  SessionHostSideConversationResult,
} from "@/kernel/session"
import {
  asObjectiveAuthority,
  isObjectiveOperationKind,
  type ObjectiveMutation,
  type ObjectivePort,
} from "@/objective"
import { isPermissionMode } from "@/permission"
import type { PostureControl } from "@/permission/posture/control"
import type { PostureCommandOutcome, PostureCommandScope } from "@/protocol/session"
import type { RuntimeAgentConfigBase, RuntimeAgentTurnAssembler } from "@/sdk/runtime/base"
import { createSingleSessionRuntimeHost } from "../builder"
import type { RuntimeSessionConfig } from "../types"
import {
  type ApprovalProtocolDeps,
  cancelPendingApprovals,
  resolveApprovalDecision,
  runOnConfirm,
  runWithProtocol,
} from "./context-binding/approval-protocol"
import type {
  PendingRuntimeApprovalRecord,
  RuntimeApprovalLease,
} from "./context-binding/approval-support"
import {
  buildAgentConfigFromBase,
  buildAgentConfigFromBaseInput,
  buildBaseFromBootstrap,
  buildCapabilityManifest,
  buildSnapshot,
  ensureSessionId,
  extendBaseWithExecutionPlane,
  extendBaseWithMemoryAuto,
  sanitizeRuntimeBase,
  wireRuntimePorts,
} from "./context-binding/base"
import { startSideConversation } from "./context-binding/side-conversation"
import {
  buildRuntimeTurnArgs,
  createTurnStreamPort,
  runRuntimeTurn,
  toSessionHostTurnResult,
} from "./context-binding/turn-runner"
import type {
  CreateRuntimeContextBindingFromBootstrapArgs,
  CreateRuntimeContextHostArgs,
  RuntimeBase,
  RuntimeContextBinding,
  RuntimeContextBindingState,
} from "./context-binding/types"

export { RuntimeApprovalRequiredError } from "./context-binding/approval-support"

export const createRuntimeApprovalProtocolController = (base: RuntimeBase) => {
  const pending = new Map<string, PendingRuntimeApprovalRecord>()
  // T03 — leases keyed by opaque approvalId (NOT a broad actionKey). Single-use
  // and turn-scoped: a lease that enters a `runWithProtocol` scope without being
  // consumed is cleared when that scope exits, so an approval cannot leak past
  // the immediate re-run (audit L5 H-1).
  const leases = new Map<string, RuntimeApprovalLease>()
  // jun-10 HITL restructure — inline-interactive delegation. When the surface
  // declares `approvalProtocol.interactive`, a mid-turn ask is answered by the
  // SURFACE confirm that occupied the slot at scope entry (the live operator's
  // prompt) instead of the deferred mint+throw round-trip. The stack mirrors
  // `runWithProtocol` nesting: each scope pushes the confirm it displaced
  // (skipping self on nested scopes) and pops it on exit, so a side
  // conversation nested inside a turn still resolves to the outer operator.
  const interactive = base.approvalProtocol?.interactive === true
  const surfaceConfirms: Array<NonNullable<AgentConfig["onConfirm"]>> = []
  // Inline prompts SERIALIZE: one operator, one question on screen at a time.
  // Early-dispatched parallel calls (the `agent` fan-out) hit the gate
  // concurrently — without this chain the second prompt would clobber the
  // first on the single input channel (auto-deny). Each queued confirm
  // RE-CHECKS leases + session grants inside its critical section, so a
  // fan-out answered "[a]lways" prompts exactly once and the queued siblings
  // ride the just-minted grant. A single-field mutable box mirrors the original
  // closure's `let inlineChain`.
  const chain: { current: Promise<unknown> } = { current: Promise.resolve() }
  // EXPLICIT standing grants — minted ONLY when the operator answers with the
  // session verb (`{decision:"allow", scope:"session"}`, the CLI's "[a]lways
  // this session"). NOT the T03 H-1 leak class: H-1 was a single one-shot
  // approval silently auto-granting later turns; this grant exists only when
  // the operator explicitly chose the session scope, mirroring Claude Code's
  // "don't ask again this session". Keyed by the SAME shell-aware actionKey the
  // leases use (`bash|ls` never unlocks `bash|rm`); a SHELL_EXTRACT_FAILED key
  // is never granted (fail closed). Session-host lifetime (this controller is
  // minted once per session).
  const sessionGrants = new Set<string>()
  // #20 — PREFIX session grants ("always allow `<program> …` this session"). A
  // distinct, MORE conservative store than `sessionGrants`: keyed by the program
  // token (`bash|git`), matched by token-boundary + tool, and ONLY ever covers a
  // SINGLE SIMPLE command (a chained/complex command derives no key ⇒ re-prompts,
  // see `@/permission/session-grant-prefix`). Minted ONLY on the operator's
  // explicit `session_prefix` verb — never on a plain approve.
  const sessionPrefixGrants = new Set<string>()

  // Closed-over mutable state threaded into the module-level helpers by
  // reference (the stores ARE the controller's ledgers). `onConfirm` is filled
  // in below — it both delegates to `runOnConfirm(deps, …)` and is read back by
  // `runWithProtocol` (slot install / self-skip), so it must be a stable field.
  const deps = {
    base,
    pending,
    leases,
    interactive,
    surfaceConfirms,
    chain,
    sessionGrants,
    sessionPrefixGrants,
  } as ApprovalProtocolDeps & { onConfirm: NonNullable<AgentConfig["onConfirm"]> }
  const onConfirm: NonNullable<AgentConfig["onConfirm"]> = (action) => runOnConfirm(deps, action)
  deps.onConfirm = onConfirm

  return {
    runWithProtocol: <T>(work: () => Promise<T>): Promise<T> => runWithProtocol(deps, work),
    resolveApproval: (
      approvalId: string,
      decision: "approve" | "deny",
      // #20 — `session_prefix` widens the deferred approve scope (prefix grant).
      // T05 — `selectedHunks` carries the web/SDK operator's per-hunk choice.
      opts?: {
        readonly scope?: "once" | "session" | "session_prefix"
        readonly steer?: string
        readonly selectedHunks?: readonly string[]
      },
    ): Promise<void> => resolveApprovalDecision(deps, approvalId, decision, opts),
    close: (): void => cancelPendingApprovals(deps),
    /** Test seam — never call in production. Exposes the live lease ledger so
     *  hellgates can assert turn-scoping without reaching into the closure. */
    onConfirm,
    /** Test seam — never call in production. Live size of the pending-approval
     *  map, so a hellgate can assert the abandoned-approval drain bounds it. */
    __pendingSize: (): number => pending.size,
  }
}

/** Live-host refcount shared by every session host minted from ONE facade.
 *  The shared session-scoped resources (MCP fleet, memory-auto wires, the
 *  bootstrap shutdown hook) are torn down by the LAST close, never the first —
 *  so a future multi-session facade cannot have session A's close strand
 *  session B's MCP tools. Every live surface today is 1-session-per-facade,
 *  where this is byte-identical (first close == last close). */
export interface SessionHostFleet {
  live: number
}

/** SessionHost.runTurn body — extracted from {@link createRuntimeSessionHost} so
 *  that factory stays under the god-FUNCTION cap. Assembles the per-turn args
 *  (threading the A2 per-session artifact ledger so a registered artifact drains
 *  into `result.artifacts` exactly once across turns), runs the turn under the
 *  approval protocol, and maps the runtime result onto the SessionHost result. */
const runSessionHostTurn = async (deps: {
  readonly args: {
    readonly state: RuntimeContextBindingState
    readonly options: CreateRuntimeContextHostArgs
  }
  readonly base: RuntimeBase
  readonly approvalProtocol: ReturnType<typeof createRuntimeApprovalProtocolController>
  readonly emittedArtifactIds: Set<string>
  readonly turnArgs: Parameters<SessionHost["runTurn"]>[0]
}): Promise<Awaited<ReturnType<SessionHost["runTurn"]>>> => {
  const { args, base, approvalProtocol, emittedArtifactIds, turnArgs } = deps
  const { history, prompt, images, signal, onEvent } = turnArgs
  const result = await approvalProtocol.runWithProtocol(
    async () =>
      await runRuntimeTurn(
        buildRuntimeTurnArgs({
          base,
          ...(args.state.turnAssembler !== undefined
            ? { turnAssembler: args.state.turnAssembler }
            : {}),
          history,
          prompt,
          ...(images !== undefined ? { images } : {}),
          state: args.options.state,
          idMeta: args.options.idMeta,
          ...(signal !== undefined ? { signal } : {}),
          ...(onEvent !== undefined ? { onEvent } : {}),
          // A2 — per-session artifact de-dup ledger (drain each artifact once).
          emittedArtifactIds,
        }),
      ),
  )
  return toSessionHostTurnResult(result)
}

/** RFC-03 C3 — validate the wire-decoded objective mutation defensively. The
 *  protocol codec already asserted `mutation.kind` is a string; here the host
 *  confirms it is a KNOWN closed operation kind before handing it to the
 *  authority. Full field validation is the authority's `prepare`/`commit`
 *  (unknown/malformed ⇒ no store effect); this just fails closed on an unknown
 *  discriminant so a hostile wire payload never reaches the domain. */
const asWireObjectiveMutation = (mutation: unknown): ObjectiveMutation | null => {
  if (mutation === null || typeof mutation !== "object") return null
  const kind = (mutation as { kind?: unknown }).kind
  return isObjectiveOperationKind(kind) ? (mutation as ObjectiveMutation) : null
}

/**
 * RFC-03 C3 — apply an out-of-band objective mutation to the session's authority
 * (the `SessionHost.mutateObjective` body, module-level to keep
 * {@link createRuntimeSessionHost} under the god-function cap). Binds the ACTOR
 * to `user` (a surface-issued command is an operator action, never trusted from
 * the wire) and the THREAD to THIS session (`base.sessionId` — the same id the
 * `objective_*` tools + `/goal` key on), then routes through the authority's
 * prepare/commit under CAS on `expectedRevision`. A stale revision, unknown
 * thread, or unwired authority is a no-op (never a clobber of a newer commit).
 */
const applyHostObjectiveMutation = (
  base: { objective?: unknown; sessionId?: string },
  args: { mutation: unknown; expectedRevision?: number },
): void => {
  const port = base.objective
  const threadId = base.sessionId
  const parsed = asWireObjectiveMutation(args.mutation)
  if (port === undefined || threadId === undefined || parsed === null) return
  const authority = asObjectiveAuthority(port as ObjectivePort)
  const prepared = authority.prepare({
    threadId,
    actor: "user",
    mutation: parsed,
    ...(args.expectedRevision !== undefined ? { expectedRevision: args.expectedRevision } : {}),
  })
  authority.commit(prepared, { admitted: true })
}

/** Duck-typed read of a wired {@link PostureControl} on the base. */
const asPostureControl = (base: { postureControl?: unknown }): PostureControl | undefined =>
  base.postureControl as PostureControl | undefined

/**
 * RFC-05 E4 — the `SessionHost.setPosture` body (module-level to keep the host
 * factory under the god-function cap). The SINGLE posture projection: when the
 * surface wired a live {@link PostureControl}, the patch is applied under CAS
 * through the SHARED authority (so the next turn's gate reads it), returning the
 * typed outcome. Absent control ⇒ the mode-only COMPAT fallback (the E3
 * `permission.mode` adapter), which keeps the legacy `session.permission.set`
 * byte-identical on a runtime without a posture control — a mode-only patch is
 * all that verb ever sends. A non-mode field with no control cannot be honored;
 * only the mode axis is live in that fallback.
 */
const applyHostPostureMutation = async (
  base: { postureControl?: unknown; permission: { mode: string } },
  args: { mutation: { patch: unknown; scope: PostureCommandScope; expectedRevision?: number } },
): Promise<PostureCommandOutcome> => {
  const control = asPostureControl(base)
  const patch = args.mutation.patch as { readonly mode?: unknown }
  if (control !== undefined) {
    return await control.apply({
      patch: args.mutation.patch as Parameters<PostureControl["apply"]>[0]["patch"],
      scope: args.mutation.scope,
      ...(args.mutation.expectedRevision !== undefined
        ? { expectedRevision: args.mutation.expectedRevision }
        : {}),
    })
  }
  const mode = patch.mode
  // Fail-closed: only a KNOWN PermissionMode reaches the live gate (an unknown
  // string keeps the current mode instead of poisoning `modePolicy[mode]`).
  if (typeof mode === "string" && isPermissionMode(mode)) {
    base.permission.mode = mode
  }
  return { ok: true }
}

const createRuntimeSessionHost = (args: {
  readonly state: RuntimeContextBindingState
  readonly options: CreateRuntimeContextHostArgs
  readonly fleet: SessionHostFleet
}): SessionHost => {
  let closed = false
  let shutdownComplete = false
  const base = args.state.base
  const approvalProtocol = createRuntimeApprovalProtocolController(base)
  const capabilityManifest = buildCapabilityManifest(base)
  // A2 — per-SESSION artifact de-dup ledger. The turn runner drains
  // `base.artifactRegistry` into `result.artifacts` (the MISSING PRODUCER for
  // `artifact.ready`); this Set records already-emitted ids so a later turn does
  // not re-emit an artifact registered on an earlier turn. Empty + never touched
  // when the store is off (no registry ⇒ drain is a no-op).
  const emittedArtifactIds = new Set<string>()

  const close = async (): Promise<void> => {
    if (shutdownComplete) return
    shutdownComplete = true
    closed = true
    approvalProtocol.close()
    // Last-close-wins: siblings minted from the same facade still hold the
    // shared resources below — defer the teardown to whichever closes last.
    args.fleet.live -= 1
    if (args.fleet.live > 0) return
    // Deferred consolidation drain — the per-turn Phase-1 distill runs on a
    // background lane (so it never blocks turn completion); a run kicked off
    // by the LAST turn may still be in flight here. Await it BEFORE the WAL
    // dispose below, or the distill's store write lands on a closed handle.
    // Best-effort: a drain failure must not block session teardown.
    try {
      await base.memoryAutoDrain?.()
    } catch {
      // swallow — teardown must complete regardless.
    }
    // U7-10: release the memory-auto bun:sqlite WAL handle for this session
    // BEFORE the broader shutdown. Idempotent + best-effort: a dispose throw
    // must not block session teardown.
    try {
      base.memoryAutoDispose?.()
    } catch {
      // swallow — teardown must complete regardless.
    }
    // H16 — fire the cross-session auto-dream pass at session end (default-OFF:
    // no-op unless QUANTA_AUTO_DREAM=1 wired a trigger). Best-effort + the
    // trigger itself swallows its own failures; we additionally guard here so a
    // dream error never blocks the broader shutdown.
    try {
      await base.dreamOnSessionEnd?.()
    } catch {
      // swallow — teardown must complete regardless.
    }
    // Session-scoped MCP teardown. These clients live for the WHOLE session —
    // the per-turn `runRuntimeTurn` finally that used to stop them was a
    // one-shot relic: it killed the fleet at the end of turn 1 (every later
    // turn's MCP tools hit a stopped client) and put a serial, potentially
    // unbounded shutdown wait on the turn-completion critical path. Stopped
    // here instead, BEFORE `options.shutdown()` so a bootstrap-owned shutdown
    // (stop clients → close egress proxy) keeps its ordering — `client.stop()`
    // is idempotent, so the double-stop is a no-op.
    for (const client of args.options.mcpClients ?? []) {
      await client.stop().catch(() => undefined)
    }
    await args.options.shutdown()
  }

  return {
    describe: () => ({
      sessionId: base.sessionId ?? crypto.randomUUID(),
      permissionMode: base.permission.mode,
      capabilityManifest,
      ...(args.options.boot?.identityModeState !== undefined
        ? { identityMode: args.options.boot.identityModeState.get() }
        : {}),
      ...(args.options.boot?.toolProfileState !== undefined
        ? { toolProfile: args.options.boot.toolProfileState.get() }
        : {}),
      // RFC-05 E4 — echo the live resolved posture (requested / effective /
      // locks) when a posture control is wired, so a posture mutation's reconcile
      // carries it onto `session.state.updated`. Absent ⇒ omitted (byte-identical
      // for a runtime without a posture control).
      ...((): { posture?: import("@/protocol/session").PostureProjectionView } => {
        const posture = asPostureControl(base)?.describe()
        return posture !== undefined ? { posture } : {}
      })(),
      messages: [...args.options.history],
      // Expose the LLM port's model slug so the kernel can carry it onto
      // `session.created` + `turn.completed`. Optional — adapters without
      // a `model` field just leave it undefined.
      ...(base.llm.model !== undefined ? { modelSlug: base.llm.model } : {}),
    }),
    runTurn: async (turnArgs) => {
      if (closed) throw new Error("runtime session host is closed")
      return await runSessionHostTurn({
        args,
        base,
        approvalProtocol,
        emittedArtifactIds,
        turnArgs,
      })
    },
    resolveApproval: async ({ approvalId, decision, scope, steer, selectedHunks }) => {
      // ADR-0512 P3 — forward the escalation's once/session scope + corrective
      // steer so the lease can carry the operator's rich decision. Both are
      // `undefined` for a normal approval ⇒ byte-identical grant. T05 — forward
      // `selectedHunks` for the web/SDK per-hunk partial apply; the controller's
      // resolve is async when it applies a subset, so AWAIT it (a whole-call /
      // gate-off resolve sets its lease synchronously before any await — the
      // pre-existing sync callers stay byte-identical).
      await approvalProtocol.resolveApproval(approvalId, decision, {
        ...(scope !== undefined ? { scope } : {}),
        ...(steer !== undefined ? { steer } : {}),
        ...(selectedHunks !== undefined ? { selectedHunks } : {}),
      })
    },
    setIdentityMode: async (mode) => {
      if (!isIdentityMode(mode)) return
      args.options.boot?.identityModeState?.set(mode)
      args.options.boot?.refreshSystemPrompt?.()
    },
    setToolProfile: async (profile) => {
      if (!isToolProfileName(profile)) return
      args.options.boot?.toolProfileState?.set(profile)
    },
    // RFC-03 C3 — out-of-band objective front door (body extracted to keep this
    // factory under the god-function cap).
    mutateObjective: (mutateArgs) => applyHostObjectiveMutation(base, mutateArgs),
    // RFC-05 E4 — the SINGLE posture projection. `session.posture.set` and the
    // legacy `session.permission.set` adapter both route here (body extracted to
    // keep this factory under the god-function cap). Applies through the wired
    // {@link PostureControl} (live authority ⇒ next-turn gate reads it) or the
    // mode-only compat fallback; returns a typed outcome (never a silent
    // success). `setPermissionMode` is RETIRED — no both-old-and-new host arm.
    setPosture: (postureArgs) => applyHostPostureMutation(base, { mutation: postureArgs }),
    startSideConversation: async (
      sideArgs: SessionHostSideConversationArgs,
    ): Promise<SessionHostSideConversationResult> =>
      await startSideConversation({
        base,
        question: sideArgs.question,
        messages: sideArgs.messages,
        signal: sideArgs.signal,
        ...(sideArgs.inherit !== undefined ? { inherit: sideArgs.inherit } : {}),
        ...(sideArgs.tools !== undefined ? { tools: sideArgs.tools } : {}),
        ...(sideArgs.maxTurns !== undefined ? { maxTurns: sideArgs.maxTurns } : {}),
      }),
    close,
  }
}

const createRuntimeContextBinding = (state: RuntimeContextBindingState): RuntimeContextBinding => {
  const normalizedState: RuntimeContextBindingState = {
    ...state,
    base: ensureSessionId(state.base),
  }
  return {
    snapshot: buildSnapshot(normalizedState.base),
    patch: (patch) =>
      createRuntimeContextBinding({
        base: sanitizeRuntimeBase({
          ...normalizedState.base,
          ...patch,
        }),
        ...(normalizedState.turnAssembler !== undefined
          ? { turnAssembler: normalizedState.turnAssembler }
          : {}),
      }),
    createRuntimeHost: (options) => {
      // One refcount per facade: every session host minted below shares the
      // session-scoped resources on `options`/`base`, so the LAST close owns
      // the shared teardown (see {@link SessionHostFleet}).
      const fleet: SessionHostFleet = { live: 0 }
      return createSingleSessionRuntimeHost((_config: RuntimeSessionConfig) => {
        fleet.live += 1
        return createRuntimeSessionHost({
          state: normalizedState,
          options,
          fleet,
        })
      })
    },
    materializeReviewerAgent: (boot, turnAssembler) =>
      boot.materializeReviewerAgent(
        buildAgentConfigFromBase(
          buildAgentConfigFromBaseInput({
            base: normalizedState.base,
            messages: [],
            signal: normalizedState.base.signal,
            turnAssembler: turnAssembler ?? normalizedState.turnAssembler,
          }),
        ),
      ),
  }
}

export const createRuntimeContextBindingFromAgentConfigBase = (args: {
  readonly base: RuntimeAgentConfigBase
  readonly turnAssembler?: RuntimeAgentTurnAssembler
}): RuntimeContextBinding =>
  createRuntimeContextBinding({
    base: wireRuntimePorts(ensureSessionId(args.base as RuntimeBase)),
    ...(args.turnAssembler !== undefined ? { turnAssembler: args.turnAssembler } : {}),
  })

export const createRuntimeContextBindingFromBootstrap = async (
  args: CreateRuntimeContextBindingFromBootstrapArgs,
): Promise<RuntimeContextBinding> => {
  if (
    args.overlay?.admissibility !== undefined &&
    args.overlay.admissibilityBuilder !== undefined
  ) {
    throw new Error(
      "runtime bootstrap overlay cannot set both admissibility and admissibilityBuilder",
    )
  }
  let base = buildBaseFromBootstrap({
    boot: args.boot,
    stream: args.stream,
    onConfirm: args.onConfirm,
    ...(args.includeSearchPipeline !== undefined
      ? { includeSearchPipeline: args.includeSearchPipeline }
      : {}),
    ...(args.overlay !== undefined ? { overlay: args.overlay } : {}),
  })

  if (args.execution !== undefined) {
    base = await extendBaseWithExecutionPlane({
      ...args.execution,
      base,
      ...(args.turnAssembler !== undefined ? { turnAssembler: args.turnAssembler } : {}),
    })
  }

  if (args.memoryAuto !== undefined) {
    base = await extendBaseWithMemoryAuto({
      ...args.memoryAuto,
      base,
    })
  }

  if (args.overlay?.admissibilityBuilder !== undefined) {
    const preview = createRuntimeContextBinding({
      base,
      ...(args.turnAssembler !== undefined ? { turnAssembler: args.turnAssembler } : {}),
    })
    const admissibility = await args.overlay.admissibilityBuilder({
      materializeReviewerAgent: (boot, turnAssembler) =>
        preview.materializeReviewerAgent(boot, turnAssembler),
    })
    if (admissibility !== undefined) {
      base = {
        ...base,
        admissibility,
      }
    }
  }

  return createRuntimeContextBinding({
    base: wireRuntimePorts(base),
    ...(args.turnAssembler !== undefined ? { turnAssembler: args.turnAssembler } : {}),
  })
}

/** T03 — test seam. Exposes the otherwise module-private approval-lease
 *  controller so grant-isolation hellgates can drive it directly (turn-scoping,
 *  concurrent same-key actions, fail-closed shell extraction) without standing
 *  up a whole runtime host. NOT part of the production API surface. */
export const __testing = {
  createRuntimeApprovalProtocolController,
  // T01 — exposed so the item-stream session-wire hellgate can drive the EXACT
  // production stream port (gated projector → item.stream onEvent) end-to-end.
  createTurnStreamPort,
}
