import { readFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import type { AgentConfig } from "@/agent"
import type { ConfirmDecision } from "@/agent/confirm-decision"
import {
  // #20 — prefix-aware session grants ("always allow `<program> …` this session").
  actionMatchesPrefixGrant,
  derivePrefixGrantKey,
  // T02 — defense-in-depth HARD_DENY re-check at the approval RESOLVE boundary.
  hardDenyReason,
  type ToolAction,
} from "@/permission"
import type { PendingApprovalView } from "@/protocol/session"
import { type ActionDiff, computeActionDiff } from "@/runner/action-diff"
import { splitHunks } from "@/runner/diff-ops"
import { applyHunkSelection } from "@/runner/hunk-apply"
import {
  applyHunkSelectionWithReceipt,
  type HunkMutationJournalStore,
} from "@/runner/hunk-mutation-journal"
import { runtimeConfig } from "@/shared"
import {
  actionKeyOf,
  escalationActorFields,
  escalationScopeFields,
  type PendingRuntimeApprovalRecord,
  type RuntimeApprovalLease,
  RuntimeApprovalRequiredError,
  reasonOf,
  SHELL_EXTRACT_FAILED,
  withResolvedShellCommandForConfirm,
} from "./approval-support"
import type { RuntimeBase } from "./types"

/** The closed-over mutable state + deps of one approval-protocol controller.
 *  Every store (`pending`, `leases`, `sessionGrants`, …) is passed BY REFERENCE
 *  so the extracted helpers mutate the SAME ledger the controller exposes via
 *  its test seams. `inlineChain` is a `let` in the original closure, so it lives
 *  here in a single-field mutable box (`chain.current`). */
export interface ApprovalProtocolDeps {
  readonly base: RuntimeBase
  readonly pending: Map<string, PendingRuntimeApprovalRecord>
  readonly leases: Map<string, RuntimeApprovalLease>
  readonly interactive: boolean
  readonly surfaceConfirms: Array<NonNullable<AgentConfig["onConfirm"]>>
  readonly chain: { current: Promise<unknown> }
  readonly sessionGrants: Set<string>
  readonly sessionPrefixGrants: Set<string>
  readonly onConfirm: NonNullable<AgentConfig["onConfirm"]>
  /** RFC06-4 (B5) — durable CAS undo journal store for the web/SDK per-hunk
   *  apply. Present only when the host wires it AND `hunkMutationReceipt` is on;
   *  absent ⇒ the apply stays a direct `applyHunkSelection` call
   *  (byte-identical). */
  readonly mutationJournal?: HunkMutationJournalStore
}

/** True iff `actionKey` rides a standing grant — an EXACT session grant for
 *  this key, OR a PREFIX grant whose program token covers this (simple)
 *  command. A `SHELL_EXTRACT_FAILED` key is checked by the callers before this
 *  (never granted). */
const hasStandingGrant = (deps: ApprovalProtocolDeps, actionKey: string): boolean =>
  deps.sessionGrants.has(actionKey) || actionMatchesPrefixGrant(actionKey, deps.sessionPrefixGrants)

/** Mint the operator's chosen standing grant. `session` adds the EXACT key.
 *  `session_prefix` adds a safe program-token PREFIX key when the command is a
 *  single simple invocation; when no safe prefix exists (chained/complex /
 *  non-shell command) it DEGRADES to the exact key — never widening beyond
 *  what is safe, and never silently granting nothing. */
const mintStandingGrant = (
  deps: ApprovalProtocolDeps,
  actionKey: string,
  scope: "session" | "session_prefix",
): void => {
  if (scope === "session") {
    deps.sessionGrants.add(actionKey)
    return
  }
  const prefixKey = derivePrefixGrantKey(actionKey)
  if (prefixKey !== null) deps.sessionPrefixGrants.add(prefixKey)
  else deps.sessionGrants.add(actionKey)
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
  deps: ApprovalProtocolDeps,
  actionKey: string | typeof SHELL_EXTRACT_FAILED,
): false | true | ConfirmDecision => {
  if (actionKey === SHELL_EXTRACT_FAILED) return false
  for (const [approvalId, lease] of deps.leases) {
    if (lease.actionKey === actionKey) {
      deps.leases.delete(approvalId)
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
const hunkCwd = (deps: ApprovalProtocolDeps): string => deps.base.cwd ?? process.cwd()
const resolveHunkPath = (deps: ApprovalProtocolDeps, p: string): string =>
  isAbsolute(p) ? p : join(hunkCwd(deps), p)

/** Capture the REQUEST-time `(path, before, after)` for a previewable mutation
 *  with ≥2 hunks. `undefined` ⇒ not per-hunk eligible (single hunk / apply_patch
 *  / shape mismatch) ⇒ the approve stays whole-call. */
const captureHunkBaseline = async (
  deps: ApprovalProtocolDeps,
  action: ToolAction,
): Promise<ActionDiff | undefined> => {
  const diff = await computeActionDiff(action, {
    readFile: (p) => readFile(resolveHunkPath(deps, p), "utf8"),
  })
  if (diff === undefined) return undefined
  if (splitHunks(diff.before, diff.after).length < 2) return undefined
  return diff
}

/** Apply the accepted subset through the single hunk-mutation owner. RFC06-4:
 *  when `hunkMutationReceipt` is on AND a durable journal store is wired, the
 *  apply is wrapped so it persists a CAS undo receipt — the SAME
 *  `applyHunkSelection` engine is called exactly once inside the wrapper. Gate
 *  OFF or no store ⇒ the identical direct `applyHunkSelection` call as before
 *  (byte-identical web/SDK behaviour). The returned shape is projected back onto
 *  the engine's own result so `applyHunkSubset` is unchanged. */
const applyAcceptedSubset = async (
  deps: ApprovalProtocolDeps,
  path: string,
  diff: ActionDiff,
  sel: readonly string[],
): Promise<
  | { readonly status: "applied" }
  | { readonly status: "stale"; readonly reason: string }
  | { readonly status: "error"; readonly reason: string }
> => {
  // Persist when a store is wired AND either the receipt gate OR the `/undo`
  // gate is on (parity with the CLI hunk-select flow — `/undo` self-sufficiency).
  const cfg = runtimeConfig()
  if ((cfg.hunkMutationReceipt || cfg.hunkUndo) && deps.mutationJournal !== undefined) {
    const out = await applyHunkSelectionWithReceipt(
      {
        operationId: crypto.randomUUID(),
        path,
        before: diff.before,
        after: diff.after,
        selectedHunkIds: sel,
      },
      { store: deps.mutationJournal },
    )
    return out.status === "applied" ? { status: "applied" } : out
  }
  const res = await applyHunkSelection({
    path,
    before: diff.before,
    after: diff.after,
    selectedHunkIds: sel,
  })
  return res.status === "applied" ? { status: "applied" } : res
}

/** Apply the operator's accepted hunk subset against the REQUEST-time baseline
 *  (`@/runner/hunk-apply`: atomic, mode-preserving, staleness-guarded — file
 *  drift since the preview ⇒ no write). Returns the `steer` for a
 *  `deny_and_steer` lease (the whole-call tool will NOT re-run; the model is
 *  told exactly what landed), or `"whole"` when the subset covers EVERY hunk
 *  (⇒ caller takes the normal whole-call grant). */
const applyHunkSubset = async (
  deps: ApprovalProtocolDeps,
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
  const res = await applyAcceptedSubset(deps, resolveHunkPath(deps, diff.path), diff, sel)
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
  deps: ApprovalProtocolDeps,
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
  const outcome = await applyHunkSubset(deps, record.actionDiff, selectedHunks)
  if (outcome === "whole") return false
  deps.leases.set(approvalId, {
    approvalId,
    actionKey: record.actionKey,
    decision: { decision: "deny_and_steer", steer: outcome.steer },
  })
  return true
}

export const runOnConfirm = async (
  deps: ApprovalProtocolDeps,
  rawAction: ToolAction,
): Promise<Awaited<ReturnType<NonNullable<AgentConfig["onConfirm"]>>>> => {
  // Enrich the action with the registry-derived `shellCommand` (mirror of the
  // admissibility-gate entry step) so the operator surface confirm can offer the
  // `[p]`/`[P]` prefix-grant verbs. The inline-approval-resolver path (ADR-0540)
  // does NOT flow through `runAdmissibilityGate`'s enrichment, so without this
  // the CLI bash confirm dropped the prefix verbs. Byte-identical for non-shell /
  // already-resolved actions (same reference returned).
  const action = withResolvedShellCommandForConfirm(deps.base.registry, rawAction)
  const actionKey = actionKeyOf(deps.base.registry, action)
  const leased = claimLease(deps, actionKey)
  if (leased !== false) return leased
  // Standing session grant (explicit operator "always" verb) — non-consuming.
  // #20 — also rides a PREFIX grant ("always allow `<program> …`") when this
  // simple command's program token was prefix-granted earlier this session.
  if (actionKey !== SHELL_EXTRACT_FAILED && hasStandingGrant(deps, actionKey)) return true

  // Inline-interactive path: a live operator is bound to this scope — ask
  // them NOW, at the gate, and hand the (possibly rich) decision straight
  // back. No pending approval, no turn abort, no re-run. The deferred
  // mint+throw below remains for surfaces without an operator (web/SDK).
  const surface = deps.surfaceConfirms[deps.surfaceConfirms.length - 1]
  if (deps.interactive && surface !== undefined) {
    const promptOperator = async (): Promise<Awaited<ReturnType<typeof surface>>> => {
      // Critical section — re-check: a confirm queued behind us may have just
      // minted the lease/grant this very key needs (the "[a]lways" fan-out).
      const leasedNow = claimLease(deps, actionKey)
      if (leasedNow !== false) return leasedNow
      if (actionKey !== SHELL_EXTRACT_FAILED && hasStandingGrant(deps, actionKey)) return true
      const raw = await surface(action)
      // #20 — mint the operator's standing grant: `session` (exact key) or
      // `session_prefix` (safe program-token prefix). A non-grant answer mints
      // nothing (byte-identical to the pre-#20 deny/once path).
      const scope = chosenGrantScope(raw)
      if (actionKey !== SHELL_EXTRACT_FAILED && scope !== undefined) {
        mintStandingGrant(deps, actionKey, scope)
      }
      return raw
    }
    const result = deps.chain.current.then(promptOperator, promptOperator)
    // Park the chain on settlement only — a deny/throw must not jam the queue.
    deps.chain.current = result.then(
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
    // RFC12-4 — carry the asking SUBAGENT's identity (if any) so the web/IDE
    // card names WHO is asking (CLI parity). Omitted for a main-agent confirm ⇒
    // byte-identical.
    ...escalationActorFields(action),
  }
  // T05 — capture the request-time per-hunk baseline for the deferred (web/SDK)
  // path ONLY. Gated (`QUANTA_HUNK_APPROVAL`) + best-effort: off ⇒ undefined ⇒
  // approve is whole-call, byte-identical to pre-T05. Computed here (not at
  // resolve) so a later out-of-band approve detects file drift as stale.
  const actionDiff =
    actionKey !== SHELL_EXTRACT_FAILED && runtimeConfig().hunkApproval
      ? await captureHunkBaseline(deps, action)
      : undefined
  // A throwing shell extraction has no stable key; record the sentinel string
  // form only for diagnostics — it can never match a future lease, and it is
  // marked non-grantable so a session-scoped approve can't stand on it.
  deps.pending.set(approval.approvalId, {
    approval,
    actionKey:
      actionKey === SHELL_EXTRACT_FAILED ? `${action.tool}|<shell-extract-failed>` : actionKey,
    grantable: actionKey !== SHELL_EXTRACT_FAILED,
    action,
    ...(actionDiff !== undefined ? { actionDiff } : {}),
  })
  throw new RuntimeApprovalRequiredError(approval)
}

export const runWithProtocol = async <T>(
  deps: ApprovalProtocolDeps,
  work: () => Promise<T>,
): Promise<T> => {
  const slot = deps.base.approvalProtocol?.confirmSlot
  if (slot === undefined) return await work()
  const previous = slot.current
  slot.current = deps.onConfirm
  // Capture the displaced SURFACE confirm for inline delegation. A nested
  // scope displaces `onConfirm` itself — skip it so the stack top stays the
  // real operator prompt (or empty ⇒ deferred fail-closed).
  const pushedSurface = typeof previous === "function" && previous !== deps.onConfirm
  if (pushedSurface) deps.surfaceConfirms.push(previous)
  // Snapshot the leases present at scope entry; any of these still present
  // at scope exit were NOT consumed by this turn run and are stale — clear
  // them so an approval is good for exactly one turn (audit L5 H-1).
  const armedAtEntry = new Set(deps.leases.keys())
  try {
    return await work()
  } finally {
    slot.current = previous
    if (pushedSurface) deps.surfaceConfirms.pop()
    for (const approvalId of armedAtEntry) deps.leases.delete(approvalId)
  }
}

/** Session close is a terminal lifecycle event. A later protocol scope is not:
 * it must leave the kernel-owned pending approval addressable by
 * `approval.respond`. */
export const cancelPendingApprovals = (deps: ApprovalProtocolDeps): void => {
  for (const approvalId of deps.pending.keys()) deps.base.approvalStateMachine?.cancel(approvalId)
  deps.pending.clear()
  deps.leases.clear()
}

type ResolveOpts =
  | {
      readonly scope?: "once" | "session" | "session_prefix"
      readonly steer?: string
      readonly selectedHunks?: readonly string[]
    }
  | undefined

/** The APPROVE branch of {@link resolveApprovalDecision}. Every path here is
 *  terminal (the original function `return`ed after this block), so this returns
 *  void unconditionally. `record`/`isEscalation` are passed through exactly as
 *  the inline block read them — byte-identical control flow. */
const resolveApprove = async (
  deps: ApprovalProtocolDeps,
  approvalId: string,
  record: PendingRuntimeApprovalRecord,
  isEscalation: boolean,
  opts: ResolveOpts,
): Promise<void> => {
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
    (await resolvePartialHunkApprove(deps, approvalId, record, isEscalation, opts.selectedHunks))
  ) {
    return
  }
  const leaseDecision: ConfirmDecision | undefined = isEscalation
    ? { decision: "allow", ...(opts?.scope !== undefined ? { scope: opts.scope } : {}) }
    : undefined
  deps.leases.set(approvalId, {
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
    mintStandingGrant(deps, record.actionKey, opts.scope)
  }
}

/** The DENY branch of {@link resolveApprovalDecision}. A normal deny sets no
 *  lease (unchanged). An escalation deny sets a RECOVERABLE deny lease so the
 *  re-run produces the `skill-scoped: declined`/`steered` tool_result (not a
 *  turn abort). */
const resolveDeny = (
  deps: ApprovalProtocolDeps,
  approvalId: string,
  record: PendingRuntimeApprovalRecord,
  isEscalation: boolean,
  opts: ResolveOpts,
): void => {
  if (!isEscalation) return
  const denyDecision: ConfirmDecision =
    opts?.steer !== undefined && opts.steer.trim().length > 0
      ? { decision: "deny_and_steer", steer: opts.steer }
      : { decision: "deny" }
  deps.leases.set(approvalId, { approvalId, actionKey: record.actionKey, decision: denyDecision })
}

export const resolveApprovalDecision = async (
  deps: ApprovalProtocolDeps,
  approvalId: string,
  decision: "approve" | "deny",
  // #20 — `session_prefix` widens the deferred approve scope (prefix grant).
  // T05 — `selectedHunks` carries the web/SDK operator's per-hunk choice.
  opts?: ResolveOpts,
): Promise<void> => {
  const record = deps.pending.get(approvalId)
  if (record === undefined) return
  deps.pending.delete(approvalId)
  // `resolveApprovalDecision` is reached only from the host's
  // `approval.respond` boundary. Settle the matching canonical record now,
  // never when `RuntimeApprovalRequiredError` first suspends the turn.
  deps.base.approvalStateMachine?.settle(approvalId, decision === "approve" ? "approve" : "deny")
  // ADR-0512 P3 — an ESCALATION approval (the minted approval carried
  // `scopeContext`) resolves to a RICH `ConfirmDecision` so the surface's
  // 4-verb card is genuinely reachable: `allow_once` (scope:"once" ⇒ the
  // re-run dispatches WITHOUT widening), `deny_and_steer` (a RECOVERABLE
  // decline carrying the operator's corrective steer). A NORMAL approval has
  // no `scopeContext` ⇒ approve mints a plain `true` grant + deny mints NO
  // lease (the turn aborts), BYTE-IDENTICAL to the pre-ADR-0512 path.
  const isEscalation = record.approval.scopeContext !== undefined
  if (decision === "approve") {
    await resolveApprove(deps, approvalId, record, isEscalation, opts)
    return
  }
  // decision === "deny".
  resolveDeny(deps, approvalId, record, isEscalation, opts)
}
