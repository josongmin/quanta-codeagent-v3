import type { ToolUseBlock } from "@/llm"
import { isTestFilePath } from "@/shared"
import type { DecisionEvent } from "@/stream"
import { stackDenyReason } from "../deny-reason-wire"
import { DedupGate } from "../dispatch-dedup"
import type { GuardDecision } from "../dispatch-guard"
import { deny } from "../dispatch-helpers"
import type { DispatchResult } from "../dispatch-types"
import { decideLocalizePhase, MUTATING_TOOL_NAMES } from "../localize-phase-guard"
import { mutatingTargetPaths } from "../mutating-tools"
import type { AgentConfig } from "../types"

const guardContent = (decision: Exclude<GuardDecision, { kind: "allow" }>): string =>
  decision.kind === "ask"
    ? `Dispatch guard requested confirmation: ${decision.reason}`
    : `${decision.hardDeny ? "Action blocked by dispatch guard (hard): " : "Action blocked by dispatch guard: "}${decision.reason}`

/** The `dispatch-guard`-specific structured deny reason. Lives HERE (its sole
 *  consumer) rather than in the domain-neutral `deny-reason-wire` leaf, so that
 *  leaf never has to import the `GuardDecision` shape (keeps it a pure builder). */
const guardStructuredReason = (decision: Exclude<GuardDecision, { kind: "allow" }>) =>
  decision.kind === "ask"
    ? stackDenyReason("dispatch guard requested confirmation")
    : stackDenyReason(
        decision.hardDeny
          ? "dispatch guard blocked (security boundary)"
          : "dispatch guard blocked (recoverable posture)",
      )

/** T3 — pre-flight dedup gate consult. Returns a synthetic non-error
 *  tool_result {@link DispatchResult} to short-circuit a thrashing call, or
 *  `null` when the gate is absent / unconfigured / the call is admissible.
 *
 *  Default-OFF preserved: when `config.dedupGate` is `undefined` this is a
 *  single property check + early return (zero allocation), so dispatch is
 *  byte-identical to the pre-T3 path for any caller that did not opt in. */
export const consultDedupGate = (
  call: ToolUseBlock,
  config: AgentConfig,
): DispatchResult | null => {
  const gate = config.dedupGate
  if (!gate) return null
  // The gate is pure-by-state: it needs the caller-supplied turn (no
  // Date.now/random) so a missing turn source means "no dedup window" — we
  // skip rather than synthesize a fake counter that would behave randomly
  // depending on call ordering across unrelated turns.
  const turn = config.run?.turn
  if (typeof turn !== "number") return null
  // S16 wire — thread the registry's canonical shell-command extractor into the
  // gate so the env-regime brake fires for ANY shell-equivalent tool the
  // registry recognizes (`bash`/`shell`/`exec`/MCP `run`), NOT just a tool
  // literally named `bash`. The extractor mirrors `ShellCommandExtractor`
  // exactly (`(name, input) => string | null`): it safeParses the input and
  // returns the declared command, or `null` for non-shell tools / invalid
  // input — the gate routes `null` to the general regime. Absent this arg the
  // gate falls back to a built-in `command`-field probe (a strict superset for
  // `bash`), so the wire only ever WIDENS coverage, never narrows it. The
  // method's bound `this` is preserved by the arrow wrapper. Any throw from a
  // third-party tool's `extractShellCommand` is normalized by the outer
  // `dispatchTool` catch into an error tool_result (no-throw contract).
  const verdict = gate.record(call.name, call.input, turn, (n, i) =>
    config.registry.extractShellCommand(n, i),
  )
  if (!verdict.blocked) return null
  return {
    block: DedupGate.syntheticResult(call.id, verdict.observation),
    ok: true,
    preview: `dedup-gate-${verdict.regime}`,
  }
}

/** Localize-phase pre-flight consult (Agentless absorption — Tier 0). Returns
 *  a deny-style {@link DispatchResult} when the gate decides to block a
 *  mutating tool in Phase 1, or `null` when the call passes through (gate
 *  OFF, Phase 2, or non-mutating tool).
 *
 *  Default-OFF: when `config.localizePhase` is absent OR `localizePhaseState`
 *  is absent OR the phase1Turns is not a positive integer, the inner
 *  {@link decideLocalizePhase} returns `{block:false}` and this function
 *  returns `null` — single property check + early return, so dispatch is
 *  byte-identical to the pre-feature path. Placed alongside `consultDedupGate`
 *  so the dispatch surface has ONE pre-admissibility consult cluster (both
 *  are state-aware gates that should short-circuit BEFORE burning permission
 *  / HITL / hook work). */
export const consultLocalizePhase = (
  call: ToolUseBlock,
  config: AgentConfig,
): DispatchResult | null => {
  const decision = decideLocalizePhase({
    toolName: call.name,
    state: config.localizePhaseState,
    cfg: config.localizePhase,
  })
  if (!decision.block) return null
  // ADR-0539 residual (observability) — emit a `decision` OBSERVE event at the
  // DENY point. Before this, a phase-gate block produced a synthetic tool_result
  // (the effect, visible in OBSERVE) with NO recorded CAUSE, so a run's stream
  // showed a mutating tool "silently" blocked. This decision line is the cause:
  // it rides `config.stream` so it lands in the trajectory jsonl (jsonl-recorder
  // maps `decision → recovery` kind, `reason:"decision"` + `kind`/`outcome`/
  // `ruleId` in `data`) — the SAME stream the tool_result effect rides, so
  // cause + effect are joinable by `toolCallId`.
  //
  //   · kind:"rule"  — the phase-gate is a pure policy RULE (no LLM/permission/
  //     hook/cap/jail/budget). The DecisionEvent `kind` enum has no "gate" arm;
  //     "rule" is the honest match and is the ONLY kind for which `ruleId` is
  //     "meaningful" per the type contract (types.ts §decision).
  //   · ruleId — the phase-gate rule identity, reusing the SAME deny reason code
  //     the `deny(...)` below stamps ("localize-phase-blocked") so the cause line
  //     and the effect's deny reason carry one id.
  //
  // Emitted ONLY on an actual deny while the guard is ACTIVE (this branch is
  // unreachable when the guard is OFF — `decideLocalizePhase` returned
  // `{block:false}` and we returned above with no allocation ⇒ byte-identical).
  // Per-deny (no dedupe): each blocked mutating call in Phase 1 IS the real
  // signal (the model retried an edit that stayed blocked), so one line per deny
  // is the faithful record — matching the sibling per-call cap/budget emits.
  const event: DecisionEvent = {
    type: "decision",
    turn: config.run?.turn ?? 0,
    kind: "rule",
    outcome: "deny",
    reason: "localize-phase: edit blocked during Phase 1",
    toolCallId: call.id,
    ruleId: "localize-phase-blocked",
    metadata: { tool: call.name },
  }
  config.stream.emit(event)
  // `text` is always present on a block decision (the policy always builds it),
  // but guard with a fallback so a future refactor that returns `{block:true}`
  // without a `text` produces a typed deny instead of an undefined-stringifying
  // tool_result.
  const reason = decision.text ?? "Localize-phase: edit blocked during Phase 1."
  return deny(call.id, reason, "localize-phase-blocked")
}

/** The steer surfaced when a bench run tries to mutate a TEST file. Frames the
 *  SOTA discipline: the grader supplies hidden tests, so a model test edit is
 *  discarded AND (observed django-13417) lures the model into chasing its own
 *  modified tests, regressing an already-correct minimal fix. */
const TEST_SCOPE_STEER =
  "Blocked: this is a test file and test files are OFF-LIMITS in this task. " +
  "The grader supplies its own hidden tests — any edit you make to a test/ file " +
  "or test_*/conftest file is discarded and only risks steering you to a wrong, " +
  "over-built fix. Verify by RUNNING the existing tests (do not modify them) and " +
  "your own reproduction script. Edit library/source files ONLY."

/** Bench test-scope pre-flight (RCA 2026-06-19, django-13417). When
 *  `config.protectTestPaths` is set, a mutating tool whose target is a test
 *  path is denied with {@link TEST_SCOPE_STEER} BEFORE it executes — the agent
 *  physically cannot edit tests, so it cannot chase its own modified tests and
 *  regress a correct fix (the failure mini/Live/OpenHands avoid by forbidding
 *  test edits). Default-OFF: absent flag ⇒ single `!` check + early return →
 *  byte-identical dispatch. Sibling to `consultLocalizePhase`. */
export const consultTestScope = (
  call: ToolUseBlock,
  config: AgentConfig,
): DispatchResult | null => {
  if (!config.protectTestPaths) return null
  if (!MUTATING_TOOL_NAMES.has(call.name)) return null
  const targets = mutatingTargetPaths(call.name, call.input)
  if (!targets.some(isTestFilePath)) return null
  return deny(call.id, TEST_SCOPE_STEER, "test-scope-blocked")
}

/** ADR-0229 — dispatch-guard pre-flight consult. Returns a deny-style
 *  {@link DispatchResult} when the guard refuses the call (preview tag
 *  `"guard-deny"` for deny outcomes, `"guard-ask"` when the guard requests
 *  HITL — collapsed to a deny in v1 because the HITL re-routing wire is a
 *  deferred follow-up), or `null` when the guard admits (or no guard is
 *  wired). Sibling to `consultDedupGate` / `consultLocalizePhase` — keeps
 *  the dispatch pre-flight cluster small and uniform.
 *
 *  Default-OFF preserved: `config.dispatchGuard` absent ⇒ one optional-chain
 *  property check, zero allocation. Byte-identical to the pre-ADR-0229 path. */
export const consultDispatchGuard = (
  call: ToolUseBlock,
  config: AgentConfig,
): DispatchResult | null => {
  const guard = config.dispatchGuard
  if (!guard) return null
  const decision = guard.check(call.name, call.input)
  if (decision.kind === "allow") return null
  if (decision.kind === "ask") {
    // Collapse `ask` to a deny in v1 (the wire to HITL queue is a deferred
    // follow-up). The `"guard-ask"` preview tag is the recognition surface a
    // future re-router keys on without changing this seam.
    //
    // C6: the dispatch-guard is a seam-level PERMISSION deny that fires BEFORE
    // `runAdmissibilityGate` (like the plan-mode block), so it MUST carry the
    // structured reason for the model to branch on the deciding layer. It
    // composes `@/permission` policy detectors (git-write-protect / branch-only
    // / network egress), so `layer:"stack"` is the closest canonical layer.
    // `pillar` is OMITTED: the `GuardDecision` shape exposes only `hardDeny` +
    // a prose `reason`, not WHICH detector fired, so any pillar would be a guess
    // (a wrong pillar is worse than none — see deny-reason.ts).
    //
    // SECURITY (no-leak): `decision.reason` echoes the path/command/host on the
    // model-facing `content` (agent-authored — acceptable), but the STRUCTURED
    // `safeReason` is a CATEGORICAL one-liner that carries NO input.
    return deny(call.id, guardContent(decision), "guard-ask", guardStructuredReason(decision))
  }
  // C6: structured reason for the seam-level guard deny (see the `ask` arm). The
  // `hardDeny` flag selects a CATEGORICAL safeReason wording (security boundary
  // vs recoverable posture) — NEVER `decision.reason`, which echoes the matched
  // path/command/host. `layer:"stack"`, pillar OMITTED.
  return deny(call.id, guardContent(decision), "guard-deny", guardStructuredReason(decision))
}
