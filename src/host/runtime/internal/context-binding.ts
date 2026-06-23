import { readFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import type { AgentConfig } from "@/agent"
import type { ConfirmDecision } from "@/agent/confirm-decision"
import type {
  SessionHost,
  SessionHostSideConversationArgs,
  SessionHostSideConversationResult,
} from "@/kernel/session"
import {
  // #20 — prefix-aware session grants ("always allow `<program> …` this session").
  actionMatchesPrefixGrant,
  derivePrefixGrantKey,
  // T02 — defense-in-depth HARD_DENY re-check at the approval RESOLVE boundary.
  hardDenyReason,
  isPermissionMode,
  type ToolAction,
} from "@/permission"
import type { PendingApprovalView } from "@/protocol/session"
import { type ActionDiff, computeActionDiff } from "@/runner/action-diff"
import { splitHunks } from "@/runner/diff-ops"
import { applyHunkSelection } from "@/runner/hunk-apply"
import type { RuntimeAgentConfigBase, RuntimeAgentTurnAssembler } from "@/sdk/runtime/base"
import { runtimeConfig } from "@/shared"
import { createSingleSessionRuntimeHost } from "../builder"
import type { RuntimeSessionConfig } from "../types"
import {
  actionKeyOf,
  escalationScopeFields,
  type PendingRuntimeApprovalRecord,
  type RuntimeApprovalLease,
  RuntimeApprovalRequiredError,
  reasonOf,
  SHELL_EXTRACT_FAILED,
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
  // ride the just-minted grant.
  let inlineChain: Promise<unknown> = Promise.resolve()
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

  /** True iff `actionKey` rides a standing grant — an EXACT session grant for
   *  this key, OR a PREFIX grant whose program token covers this (simple)
   *  command. A `SHELL_EXTRACT_FAILED` key is checked by the callers before this
   *  (never granted). */
  const hasStandingGrant = (actionKey: string): boolean =>
    sessionGrants.has(actionKey) || actionMatchesPrefixGrant(actionKey, sessionPrefixGrants)

  /** Mint the operator's chosen standing grant. `session` adds the EXACT key.
   *  `session_prefix` adds a safe program-token PREFIX key when the command is a
   *  single simple invocation; when no safe prefix exists (chained/complex /
   *  non-shell command) it DEGRADES to the exact key — never widening beyond
   *  what is safe, and never silently granting nothing. */
  const mintStandingGrant = (actionKey: string, scope: "session" | "session_prefix"): void => {
    if (scope === "session") {
      sessionGrants.add(actionKey)
      return
    }
    const prefixKey = derivePrefixGrantKey(actionKey)
    if (prefixKey !== null) sessionPrefixGrants.add(prefixKey)
    else sessionGrants.add(actionKey)
  }

  /** The explicit standing-grant scope the operator chose on an ALLOW decision,
   *  or `undefined` for any other shape. Centralised so the inline + deferred
   *  paths read consent identically. */
  const chosenGrantScope = (raw: unknown): "session" | "session_prefix" | undefined => {
    if (typeof raw !== "object" || raw === null) return undefined
    if ((raw as { decision?: unknown }).decision !== "allow") return undefined
    const scope = (raw as { scope?: unknown }).scope
    return scope === "session" || scope === "session_prefix" ? scope : undefined
  }

  /** Claim AT MOST ONE unclaimed lease whose `actionKey` matches. The lookup +
   *  delete is synchronous (no `await` between find and consume) so two
   *  concurrent same-key `onConfirm` calls can never both claim the same lease —
   *  the second mints its own approval rather than racing the first (audit L5
   *  M-3). A `SHELL_EXTRACT_FAILED` action key never matches any lease ⇒ it
   *  always re-prompts (fail closed). */
  const claimLease = (
    actionKey: string | typeof SHELL_EXTRACT_FAILED,
  ): false | true | ConfirmDecision => {
    if (actionKey === SHELL_EXTRACT_FAILED) return false
    for (const [approvalId, lease] of leases) {
      if (lease.actionKey === actionKey) {
        leases.delete(approvalId)
        // ADR-0512 P3 — an ESCALATION lease carries the operator's rich decision
        // (allow_once / deny_and_steer); return it so the loop honours scope/steer.
        // A NORMAL lease has none ⇒ bare `true` (byte-identical grant).
        return lease.decision ?? true
      }
    }
    return false
  }

  // ── T05 (web/SDK per-hunk partial apply) ──────────────────────────────
  // Relative action paths resolve against the session root so the request-time
  // read + the apply write hit the same file (mirrors the CLI compose reader).
  const hunkCwd = (): string => base.cwd ?? process.cwd()
  const resolveHunkPath = (p: string): string => (isAbsolute(p) ? p : join(hunkCwd(), p))

  /** Capture the REQUEST-time `(path, before, after)` for a previewable mutation
   *  with ≥2 hunks. `undefined` ⇒ not per-hunk eligible (single hunk / apply_patch
   *  / shape mismatch) ⇒ the approve stays whole-call. */
  const captureHunkBaseline = async (action: ToolAction): Promise<ActionDiff | undefined> => {
    const diff = await computeActionDiff(action, {
      readFile: (p) => readFile(resolveHunkPath(p), "utf8"),
    })
    if (diff === undefined) return undefined
    if (splitHunks(diff.before, diff.after).length < 2) return undefined
    return diff
  }

  /** Apply the operator's accepted hunk subset against the REQUEST-time baseline
   *  (`@/runner/hunk-apply`: atomic, mode-preserving, staleness-guarded — file
   *  drift since the preview ⇒ no write). Returns the `steer` for a
   *  `deny_and_steer` lease (the whole-call tool will NOT re-run; the model is
   *  told exactly what landed), or `"whole"` when the subset covers EVERY hunk
   *  (⇒ caller takes the normal whole-call grant). */
  const applyHunkSubset = async (
    diff: ActionDiff,
    selected: readonly string[],
  ): Promise<{ readonly steer: string } | "whole"> => {
    const ids = splitHunks(diff.before, diff.after).map((h) => h.id)
    const sel = selected.filter((s) => ids.includes(s))
    if (sel.length === ids.length) return "whole" // all accepted ⇒ normal grant
    const rejected = ids.filter((i) => !sel.includes(i))
    if (sel.length === 0) {
      return {
        steer: `Operator rejected all ${ids.length} proposed hunks; no changes were applied.`,
      }
    }
    const res = await applyHunkSelection({
      path: resolveHunkPath(diff.path),
      before: diff.before,
      after: diff.after,
      selectedHunkIds: sel,
    })
    if (res.status === "applied") {
      return {
        steer: `Operator accepted ${sel.length}/${ids.length} hunks (${sel.join(", ")}) and rejected ${rejected.join(", ")}. The file now reflects ONLY the accepted hunks — do not re-apply the rejected ones.`,
      }
    }
    if (res.status === "stale") {
      return {
        steer: `The file changed since the diff was shown (${res.reason}); no hunks were applied — re-read it before editing.`,
      }
    }
    return { steer: `Partial apply failed (${res.reason}); no hunks were applied.` }
  }

  /** T05 — resolve a web/SDK `approve` carrying `selectedHunks`. Applies the
   *  accepted subset + mints a `deny_and_steer` lease (so the whole-call tool
   *  does NOT re-run) ⇒ returns true. Returns false (caller takes the normal
   *  whole-call grant) when not per-hunk eligible: no `selectedHunks`, gate off,
   *  an escalation (skill-scope axis, not per-hunk), no captured baseline
   *  (single-hunk / non-previewable), or the subset covers EVERY hunk. */
  const resolvePartialHunkApprove = async (
    approvalId: string,
    record: PendingRuntimeApprovalRecord,
    isEscalation: boolean,
    selectedHunks: readonly string[] | undefined,
  ): Promise<boolean> => {
    if (
      selectedHunks === undefined ||
      record.actionDiff === undefined ||
      isEscalation ||
      !runtimeConfig().hunkApproval
    ) {
      return false
    }
    const outcome = await applyHunkSubset(record.actionDiff, selectedHunks)
    if (outcome === "whole") return false
    leases.set(approvalId, {
      approvalId,
      actionKey: record.actionKey,
      decision: { decision: "deny_and_steer", steer: outcome.steer },
    })
    return true
  }

  const onConfirm: NonNullable<AgentConfig["onConfirm"]> = async (action) => {
    const actionKey = actionKeyOf(base.registry, action)
    const leased = claimLease(actionKey)
    if (leased !== false) return leased
    // Standing session grant (explicit operator "always" verb) — non-consuming.
    // #20 — also rides a PREFIX grant ("always allow `<program> …`") when this
    // simple command's program token was prefix-granted earlier this session.
    if (actionKey !== SHELL_EXTRACT_FAILED && hasStandingGrant(actionKey)) return true

    // Inline-interactive path: a live operator is bound to this scope — ask
    // them NOW, at the gate, and hand the (possibly rich) decision straight
    // back. No pending approval, no turn abort, no re-run. The deferred
    // mint+throw below remains for surfaces without an operator (web/SDK).
    const surface = surfaceConfirms[surfaceConfirms.length - 1]
    if (interactive && surface !== undefined) {
      const promptOperator = async (): Promise<Awaited<ReturnType<typeof surface>>> => {
        // Critical section — re-check: a confirm queued behind us may have just
        // minted the lease/grant this very key needs (the "[a]lways" fan-out).
        const leasedNow = claimLease(actionKey)
        if (leasedNow !== false) return leasedNow
        if (actionKey !== SHELL_EXTRACT_FAILED && hasStandingGrant(actionKey)) return true
        const raw = await surface(action)
        // #20 — mint the operator's standing grant: `session` (exact key) or
        // `session_prefix` (safe program-token prefix). A non-grant answer mints
        // nothing (byte-identical to the pre-#20 deny/once path).
        const scope = chosenGrantScope(raw)
        if (actionKey !== SHELL_EXTRACT_FAILED && scope !== undefined) {
          mintStandingGrant(actionKey, scope)
        }
        return raw
      }
      const result = inlineChain.then(promptOperator, promptOperator)
      // Park the chain on settlement only — a deny/throw must not jam the queue.
      inlineChain = result.then(
        () => undefined,
        () => undefined,
      )
      return await result
    }

    const approval: PendingApprovalView = {
      approvalId: crypto.randomUUID(),
      reason: reasonOf(action),
      requestedAt: new Date().toISOString(),
      // ADR-0512 P3 — carry the skill-scope escalation context (if any) onto the
      // approval so the web/IDE surface renders the rich card. Omitted for a
      // normal confirm ⇒ byte-identical.
      ...escalationScopeFields(action),
    }
    // T05 — capture the request-time per-hunk baseline for the deferred (web/SDK)
    // path ONLY. Gated (`QUANTA_HUNK_APPROVAL`) + best-effort: off ⇒ undefined ⇒
    // approve is whole-call, byte-identical to pre-T05. Computed here (not at
    // resolve) so a later out-of-band approve detects file drift as stale.
    const actionDiff =
      actionKey !== SHELL_EXTRACT_FAILED && runtimeConfig().hunkApproval
        ? await captureHunkBaseline(action)
        : undefined
    // A throwing shell extraction has no stable key; record the sentinel string
    // form only for diagnostics — it can never match a future lease, and it is
    // marked non-grantable so a session-scoped approve can't stand on it.
    pending.set(approval.approvalId, {
      approval,
      actionKey:
        actionKey === SHELL_EXTRACT_FAILED ? `${action.tool}|<shell-extract-failed>` : actionKey,
      grantable: actionKey !== SHELL_EXTRACT_FAILED,
      action,
      ...(actionDiff !== undefined ? { actionDiff } : {}),
    })
    throw new RuntimeApprovalRequiredError(approval)
  }

  return {
    runWithProtocol: async <T>(work: () => Promise<T>): Promise<T> => {
      const slot = base.approvalProtocol?.confirmSlot
      if (slot === undefined) return await work()
      const previous = slot.current
      slot.current = onConfirm
      // Capture the displaced SURFACE confirm for inline delegation. A nested
      // scope displaces `onConfirm` itself — skip it so the stack top stays the
      // real operator prompt (or empty ⇒ deferred fail-closed).
      const pushedSurface = typeof previous === "function" && previous !== onConfirm
      if (pushedSurface) surfaceConfirms.push(previous)
      // Snapshot the leases present at scope entry; any of these still present
      // at scope exit were NOT consumed by this turn run and are stale — clear
      // them so an approval is good for exactly one turn (audit L5 H-1).
      const armedAtEntry = new Set(leases.keys())
      // Abandoned-approval drain (audit U2/#12): an approval that was ALREADY
      // pending when this scope began carries over the full turn. If it is STILL
      // pending at scope exit it was never resolved before the turn moved on —
      // the surface that held its `approvalId` is gone, so it can never be
      // matched and would otherwise leak in `pending` for the host's lifetime.
      // Snapshot at entry and drop the survivors in `finally`. The approval THIS
      // scope itself creates (when `onConfirm` throws) is added AFTER this
      // snapshot, so it gets a one-turn grace: it survives to its resolution, or
      // is drained by the NEXT scope if still unresolved. Mirrors the lease
      // drain above; no arbitrary cap, nesting-safe (each scope drains only what
      // it carried in).
      const pendingAtEntry = new Set(pending.keys())
      try {
        return await work()
      } finally {
        slot.current = previous
        if (pushedSurface) surfaceConfirms.pop()
        for (const approvalId of armedAtEntry) leases.delete(approvalId)
        for (const approvalId of pendingAtEntry) pending.delete(approvalId)
      }
    },
    resolveApproval: async (
      approvalId: string,
      decision: "approve" | "deny",
      // #20 — `session_prefix` widens the deferred approve scope (prefix grant).
      // T05 — `selectedHunks` carries the web/SDK operator's per-hunk choice.
      opts?: {
        readonly scope?: "once" | "session" | "session_prefix"
        readonly steer?: string
        readonly selectedHunks?: readonly string[]
      },
    ): Promise<void> => {
      const record = pending.get(approvalId)
      if (record === undefined) return
      pending.delete(approvalId)
      // ADR-0512 P3 — an ESCALATION approval (the minted approval carried
      // `scopeContext`) resolves to a RICH `ConfirmDecision` so the surface's
      // 4-verb card is genuinely reachable: `allow_once` (scope:"once" ⇒ the
      // re-run dispatches WITHOUT widening), `deny_and_steer` (a RECOVERABLE
      // decline carrying the operator's corrective steer). A NORMAL approval has
      // no `scopeContext` ⇒ approve mints a plain `true` grant + deny mints NO
      // lease (the turn aborts), BYTE-IDENTICAL to the pre-ADR-0512 path.
      const isEscalation = record.approval.scopeContext !== undefined
      if (decision === "approve") {
        // T02 — HARD_DENY re-check at the relay boundary (fail-closed). An approve
        // may have been RELAYED by a follower client; a dangerous command must
        // never mint a grant here regardless of who relayed it. On a hit we mint
        // NOTHING (the action is re-prompted / denied downstream) — the same
        // effect as a normal deny. Defense-in-depth: the dispatch gate already
        // denies such commands before they reach this prompt.
        if (hardDenyReason(record.action) !== null) return
        // T05 — web/SDK per-hunk partial apply. The `selectedHunks !== undefined`
        // guard SHORT-CIRCUITS before the await, so a normal approve (no hunks)
        // mints its lease SYNCHRONOUSLY — pre-existing sync `resolveApproval`
        // callers stay byte-identical. Helper return true ⇒ a subset was applied +
        // a deny_and_steer lease minted (whole-call tool will NOT re-run) ⇒ done.
        if (
          opts?.selectedHunks !== undefined &&
          (await resolvePartialHunkApprove(approvalId, record, isEscalation, opts.selectedHunks))
        ) {
          return
        }
        const leaseDecision: ConfirmDecision | undefined = isEscalation
          ? { decision: "allow", ...(opts?.scope !== undefined ? { scope: opts.scope } : {}) }
          : undefined
        leases.set(approvalId, {
          approvalId,
          actionKey: record.actionKey,
          ...(leaseDecision !== undefined ? { decision: leaseDecision } : {}),
        })
        // jun-10 — deferred "always" verb: a NORMAL approval resolved with the
        // EXPLICIT session scope additionally mints the standing grant (same
        // ledger the inline "[a]lways" uses), so a deferred surface (web card /
        // CLI fallback) pays the abort+re-run round-trip ONCE per key instead
        // of once per ask. Escalations are excluded: a session-scoped skill
        // widening is the skill-scope axis (the rich lease above), NOT a
        // tool-level never-ask-again. Non-grantable (shell-extract-failed)
        // records never stand (fail closed). Same consent semantics as the
        // inline path — the grant exists only on the operator's explicit verb.
        // #20 — also accept the `session_prefix` verb on the deferred path so a
        // web card / CLI fallback can mint a standing prefix grant once instead
        // of paying the abort+re-run round-trip per matching command.
        if (
          !isEscalation &&
          record.grantable &&
          (opts?.scope === "session" || opts?.scope === "session_prefix")
        ) {
          mintStandingGrant(record.actionKey, opts.scope)
        }
        return
      }
      // decision === "deny". A normal deny sets no lease (unchanged). An
      // escalation deny sets a RECOVERABLE deny lease so the re-run produces the
      // `skill-scoped: declined`/`steered` tool_result (not a turn abort).
      if (!isEscalation) return
      const denyDecision: ConfirmDecision =
        opts?.steer !== undefined && opts.steer.trim().length > 0
          ? { decision: "deny_and_steer", steer: opts.steer }
          : { decision: "deny" }
      leases.set(approvalId, { approvalId, actionKey: record.actionKey, decision: denyDecision })
    },
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

  const close = async (): Promise<void> => {
    if (shutdownComplete) return
    shutdownComplete = true
    closed = true
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
      messages: [...args.options.history],
      // Expose the LLM port's model slug so the kernel can carry it onto
      // `session.created` + `turn.completed`. Optional — adapters without
      // a `model` field just leave it undefined.
      ...(base.llm.model !== undefined ? { modelSlug: base.llm.model } : {}),
    }),
    runTurn: async ({ history, prompt, images, signal, onEvent }) => {
      if (closed) throw new Error("runtime session host is closed")
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
            }),
          ),
      )
      return toSessionHostTurnResult(result)
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
      args.options.boot?.identityModeState?.set(mode as never)
      args.options.boot?.refreshSystemPrompt?.()
    },
    setToolProfile: async (profile) => {
      args.options.boot?.toolProfileState?.set(profile as never)
    },
    setPermissionMode: async (mode) => {
      // Fail-closed: only a KNOWN PermissionMode reaches the gate. An unknown
      // string would make `modePolicy[mode]` undefined downstream, so we ignore
      // it (keep the current mode) rather than poison the gate.
      if (!isPermissionMode(mode)) return
      // Mutate the session's permission context in place. When the surface wired
      // a LIVE getter/setter proxy for `permission.mode` (web daemon /
      // bootstrap), the per-turn gate reads the new value on the NEXT turn — a
      // real mid-session switch, not a display-only echo. On a plain
      // `PermissionContext` the property is writable too, so this is a safe
      // no-surprise assignment.
      base.permission.mode = mode
    },
    startSideConversation: async (
      sideArgs: SessionHostSideConversationArgs,
    ): Promise<SessionHostSideConversationResult> =>
      await startSideConversation({
        base,
        ...(args.state.turnAssembler !== undefined
          ? { turnAssembler: args.state.turnAssembler }
          : {}),
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
