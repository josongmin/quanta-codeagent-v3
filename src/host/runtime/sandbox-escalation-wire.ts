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
 * those, so it declares a duck-typed handler contract
 * (`@/tool/bash/sandbox-escalation-wire`). THIS module is the composition root
 * that adapts the machine into that contract and mints the handler onto the
 * SESSION's `AgentConfig.bashSandboxEscalation` slot — but ONLY when
 * `QUANTA_SANDBOX_ESCALATION` is on. Dispatch then projects the slot onto
 * `ToolContext.sandboxEscalation` per turn (the `writeBudget` 2-stage shape).
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
 * DEFAULT-OFF / byte-identical: knob unset ⇒ the slot is never stamped ⇒ the ctx
 * omits the seam ⇒ a sandboxed nonzero exit surfaces exactly as today.
 *
 * SESSION-SCOPED, NEVER PROCESS-GLOBAL (aug-23 audit fix): the handler closes
 * over session-unique authority (this session's `PermissionStore`, its
 * `onConfirm`, and its ONE escalation cap). It used to live in a module-level
 * `let installed` inside the bash seam, which made a multi-session process
 * last-writer-wins (A's prompt to B's operator, A's ADR-0046 override into B's
 * store) and let a knob-less `run()` DISARM a live sibling. It now rides the
 * session's own config.
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
import type { RuntimeConfig } from "@/shared"
import type {
  BashSandboxEscalationHandler,
  BashSandboxEscalationRequest,
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
 * STAGE 1 (per-SESSION mint) — set `cfg.bashSandboxEscalation` when
 * `QUANTA_SANDBOX_ESCALATION` is on. Uses the SAME `PermissionStore` the
 * admissibility gate consults — `cfg.admissibility.permissionStore` — so the
 * post-denial override the escalation records is the one the gate reads. The
 * store is INJECTED at the `src/apps/**` surface (the CLI's
 * `runtime-context-compose.ts` threads `getDefaultPermissionStore()` onto
 * `admissibility.permissionStore`); this host layer never reaches for the
 * singleton (the service-locator invariant). When the surface did NOT inject a
 * store, escalation has no gate-shared store to record into ⇒ we SKIP (slot left
 * unset) rather than fabricate a detached one — fail-closed, byte-identical.
 *
 * Mints ONE cap per session from `QUANTA_SANDBOX_ESCALATION_MAX` and closes the
 * handler over it. THIS is why the mint must NOT move into the per-turn
 * projection: `createSandboxEscalationCap` counts in a closure `Map`, so a cap
 * re-created per tool call would make `admit()` always return `count:1` and the
 * anti-spam ceiling would be silently inert.
 *
 * KNOB-OFF ⇒ TRUE NO-OP — the slot is not even stamped as an own property, so
 * the config stays byte-identical AND a knob-less session can never disarm a
 * live sibling (the pre-fix global did exactly that). Caller-override-safe: an
 * already-populated slot (e.g. lifted from the interactive CLI's overlay, where
 * the session-long cap lives) WINS, so a per-turn re-assemble never re-mints and
 * never resets the counter — the same precedence `maybeWireWriteBudget` uses.
 */
export const maybeWireBashSandboxEscalation = (
  cfg: AgentConfig,
  config: Pick<RuntimeConfig, "sandboxEscalation" | "sandboxEscalationMax">,
): void => {
  if (cfg.bashSandboxEscalation !== undefined) return
  if (!config.sandboxEscalation) return
  const store = cfg.admissibility?.permissionStore
  if (store === undefined) return
  const cap = createSandboxEscalationCap(config.sandboxEscalationMax)
  cfg.bashSandboxEscalation = buildHandler(store, cap, cfg.onConfirm)
}
