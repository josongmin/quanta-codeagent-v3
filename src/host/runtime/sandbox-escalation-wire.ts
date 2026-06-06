/**
 * RFC jun-6 — host wire for the sandbox-block → escalation-retry loop (Binding 1).
 *
 * The MACHINE is complete + hellgate-proven in three slices:
 *   - `@/runtime/os-sandbox#classifySandboxDenial`  — the block discriminant.
 *   - `@/agent/sandbox-escalation`                   — the orchestrator
 *     (`seedSandboxBlockDenial` + `runSandboxEscalation`) reusing the ADR-0046
 *     `@/permission/post-denial` 3-step re-approval store + a per-turn cap.
 *   - `@/permission/post-denial`                     — the user-gated override.
 *
 * The bash tool (in the fence-isolated `@/tool` slice) can NOT import any of
 * those, so it exposes a duck-typed install seam
 * (`@/tool/bash/sandbox-escalation-wire`). THIS module is the composition root
 * that adapts the machine into that seam's handler and installs it — but ONLY
 * when `QUANTA_SANDBOX_ESCALATION` is on.
 *
 * Wiring (all per-RFC §4.3, NEVER-auto):
 *   1. `classifySandboxDenial(result, "seatbelt")` — the per-call bash sandbox is
 *      Seatbelt-only today (the per-call port is darwin/`sandbox-exec`), so an
 *      APPLIED-sandbox nonzero exit is classified against the `seatbelt` backend.
 *      Unrecognised ⇒ `undefined` ⇒ the handler returns `undefined` ⇒ the bash
 *      tool yields its ORIGINAL result (byte-identical, UNDER-detect).
 *   2. `seedSandboxBlockDenial` records the block as a denial for THIS
 *      `(threadId, action)` in the SAME `PermissionStore` the gate consults.
 *   3. `runSandboxEscalation` runs the cap → risk-present (via `onConfirm`) →
 *      `recordRiskSeen`/`recordUserOverride` → NORMAL gate (a second `onConfirm`
 *      consult — escalation does NOT bypass the gate) → unsandboxed re-run.
 *
 * DEFAULT-OFF / byte-identical: knob unset ⇒ nothing installed ⇒ the bash seam
 * has no handler ⇒ a sandboxed nonzero exit surfaces exactly as today.
 *
 * SECURITY: escalation NEVER auto-grants — the orchestrator enforces the
 * timestamp-ordered 3-step re-approval (a fabricated/out-of-order override keeps
 * `hasPostDenialOverride` false) and routes the re-run through `onConfirm`. The
 * model's `justification` flows to the AUDIT sink only, never telemetry.
 */

import { type ConfirmDecision, isConfirmDecisionAllowed, normalizeConfirm } from "@/agent"
import {
  createSandboxEscalationCap,
  runSandboxEscalation,
  type SandboxEscalationCap,
  type SandboxEscalationDeps,
  seedSandboxBlockDenial,
} from "@/agent/sandbox-escalation"
import type { AgentConfig } from "@/agent/types"
import type { PermissionStore, PostDenialAction, ToolAction } from "@/permission"
import { classifySandboxDenial } from "@/runtime/os-sandbox"
import { runtimeConfig } from "@/shared"
import {
  __setBashSandboxEscalationHandler,
  type BashSandboxEscalationHandler,
  type BashSandboxEscalationRequest,
} from "@/tool/bash/sandbox-escalation-wire"

/** The per-call bash sandbox is Seatbelt-only (the per-call port wraps via
 *  `sandbox-exec` on darwin); an applied-sandbox block is classified against
 *  this backend. */
const PER_CALL_BACKEND = "seatbelt" as const

/** Resolve the caller's stable post-denial `(threadId)` key. The bash seam
 *  surfaces `ctx.agentLabel`; absent ⇒ `"root"` (the root session). */
const threadIdFor = (req: BashSandboxEscalationRequest): string =>
  typeof req.agentLabel === "string" && req.agentLabel.length > 0 ? req.agentLabel : "root"

/** Per-turn key for the escalation cap. Absent `turnId` ⇒ a stable per-thread
 *  bucket (the cap still bounds requests within the session). */
const turnIdFor = (req: BashSandboxEscalationRequest): string =>
  typeof req.turnId === "string" && req.turnId.length > 0 ? req.turnId : "turn"

/** Adapt `onConfirm` (the host HITL authority) into a boolean approval. A
 *  missing authority fails CLOSED (no approval ⇒ the command stays blocked) —
 *  escalation must never silently grant without a user decision. */
const confirmVia = async (
  onConfirm: AgentConfig["onConfirm"],
  action: ToolAction,
): Promise<boolean> => {
  if (onConfirm === undefined) return false
  const decision: ConfirmDecision = normalizeConfirm(await onConfirm(action))
  return isConfirmDecisionAllowed(decision)
}

/** Render the model-facing note describing the block + its disposition. */
const noteFor = (
  outcome: Awaited<ReturnType<typeof runSandboxEscalation>>,
  signal: string,
  confidence: string,
): string => {
  const head = `[sandbox] command blocked by the OS sandbox (${signal}, ${confidence}-confidence)`
  switch (outcome.kind) {
    case "approved":
      return `${head} — escalation APPROVED; re-ran unsandboxed.`
    case "user-denied":
      return `${head} — escalation declined; command stays blocked.`
    case "gate-denied":
      return `${head} — escalation gate-denied${outcome.reason !== undefined ? `: ${outcome.reason}` : ""}.`
    case "exhausted":
      return `${head} — escalation exhausted (${outcome.count}/${outcome.max} this turn).`
  }
}

/** Build the bash escalation handler over a resolved store + cap + the parent
 *  config's `onConfirm` authority. */
const buildHandler = (
  store: PermissionStore,
  cap: SandboxEscalationCap,
  onConfirm: AgentConfig["onConfirm"],
): BashSandboxEscalationHandler => {
  const clock = { now: () => Date.now() }
  return async (req) => {
    // (1) Classify the block. Per-call sandbox = Seatbelt. Unrecognised ⇒
    // undefined ⇒ the bash tool yields its ORIGINAL result (byte-identical).
    const denial = classifySandboxDenial(
      {
        exitCode: req.exitCode,
        stdout: req.stdout,
        stderr: req.stderr,
        sandboxApplied: true,
      },
      PER_CALL_BACKEND,
    )
    if (denial === undefined) return undefined

    const action: PostDenialAction = {
      threadId: threadIdFor(req),
      tool: "bash",
      workdir: req.cwd,
      args: { command: req.command },
    }

    // (2) Seed the post-denial machine (records the block as a denial).
    seedSandboxBlockDenial(action, denial, { store, clock })

    // (3) Run the user-gated escalation. presentRisk + gate BOTH route through
    // the host `onConfirm` authority; the orchestrator enforces the ordered
    // 3-step re-approval + caps + the NEVER-auto invariant.
    const deps: SandboxEscalationDeps = {
      store,
      clock,
      cap,
      presentRisk: async (ctx) => ({
        approved: await confirmVia(onConfirm, {
          tool: "bash",
          input: { command: req.command, escalate: true, justification: ctx.justification },
          isReadOnly: false,
          shellCommand: req.command,
        }),
      }),
      gate: async () => ({
        allow: await confirmVia(onConfirm, {
          tool: "bash",
          input: { command: req.command, unsandboxed: true },
          isReadOnly: false,
          shellCommand: req.command,
        }),
      }),
      rerunUnsandboxed: async () => {
        const rr = await req.rerunUnsandboxed()
        return { exitCode: rr.exitCode, stdout: rr.stdout, stderr: rr.stderr }
      },
    }

    const outcome = await runSandboxEscalation(
      {
        action,
        turnId: turnIdFor(req),
        denial,
        // The bash seam does not carry a model-authored justification today; the
        // re-request is implicit (the model retried the command). A structured
        // `justification` field on the bash input is a future ADR; the empty
        // string is honest (the human still sees the concrete risk).
        justification: "",
      },
      deps,
    )

    const note = noteFor(outcome, denial.signal, denial.confidence)
    return outcome.kind === "approved" ? { rerun: outcome.result, note } : { note }
  }
}

/**
 * Install the bash sandbox-escalation handler when `QUANTA_SANDBOX_ESCALATION`
 * is on. Uses the SAME `PermissionStore` the admissibility gate consults —
 * `cfg.admissibility.permissionStore` — so the post-denial override the
 * escalation records is the one the gate reads. The store is INJECTED at the
 * `src/apps/**` surface (the CLI's `runtime-context-compose.ts` threads
 * `getDefaultPermissionStore()` onto `admissibility.permissionStore`); this host
 * layer never reaches for the singleton (the service-locator invariant). When
 * the surface did NOT inject a store, escalation has no gate-shared store to
 * record into ⇒ we SKIP (no handler) rather than fabricate a detached one —
 * fail-closed, byte-identical. Mints ONE per-session cap from
 * `QUANTA_SANDBOX_ESCALATION_MAX`. Knob-OFF ⇒ no-op; idempotent (the assembler
 * is the single caller).
 */
export const maybeWireBashSandboxEscalation = (cfg: AgentConfig): void => {
  if (!runtimeConfig().sandboxEscalation) {
    // Default-OFF: ensure no stale handler from a prior session lingers.
    __setBashSandboxEscalationHandler(undefined)
    return
  }
  const store = cfg.admissibility?.permissionStore
  if (store === undefined) {
    // No gate-shared store injected by the surface ⇒ nothing to record the
    // post-denial override into ⇒ escalation would be inert. Clear + skip.
    __setBashSandboxEscalationHandler(undefined)
    return
  }
  const cap = createSandboxEscalationCap(runtimeConfig().sandboxEscalationMax)
  __setBashSandboxEscalationHandler(buildHandler(store, cap, cfg.onConfirm))
}
