import type { ToolUseBlock } from "@/llm"
import { type StructuredDenyReason, structuredDenyReason } from "@/permission"
import { isTestFilePath, runtimeConfig } from "@/shared"
import { DedupGate } from "../dispatch-dedup"
import { deny } from "../dispatch-helpers"
import type { DispatchResult } from "../dispatch-types"
import { decideLocalizePhase, MUTATING_TOOL_NAMES } from "../localize-phase-guard"
import { mutatingTargetPaths } from "../mutating-tools"
import type { AgentConfig } from "../types"

/**
 * C6 (RFC jun-6-deny-reason-surfacing) — knob-gated structured-deny builder for
 * the dispatch-seam denies that fire BEFORE `runAdmissibilityGate` (the
 * `plan` collaboration-mode mutating block). Mirrors the admissibility-gate's
 * local `denyReason(...)`: returns `undefined` (zero allocation) when
 * `surfaceDenyReason` (`QUANTA_DENY_REASON`) is OFF, so `deny(...,
 * denyReason(...))` is BYTE-IDENTICAL to the legacy `deny(...)` on the default
 * path. The dispatch-helper `deny()` ALSO re-checks the knob (defence in depth).
 *
 * SECURITY (no-leak): callers pass a CATEGORICAL `safeReason` (mode literal +
 * tool name at most — never tool input), the same surface the recorder already
 * sees; the prefix is derived from `layer`/`pillar` enums only.
 */
export const denyReason = (input: {
  layer: import("@/permission").DenyLayer
  pillar?: import("@/permission").DenyPillar
  safeReason: string
}): StructuredDenyReason | undefined =>
  runtimeConfig().surfaceDenyReason ? structuredDenyReason(input) : undefined

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
    return deny(
      call.id,
      `Dispatch guard requested confirmation: ${decision.reason}`,
      "guard-ask",
      denyReason({ layer: "stack", safeReason: "dispatch guard requested confirmation" }),
    )
  }
  // `kind === "deny"`. `hardDeny:true` carries the security-boundary
  // signal forward via the deny content prefix — downstream loop classifiers
  // (and the existing `handoff` preview-tag consumers) keep working unchanged
  // because we use a NEW tag (`"guard-deny"`) that opts in to the new behavior
  // without colliding with the existing 16+ preview-tag vocabulary.
  const prefix = decision.hardDeny
    ? "Action blocked by dispatch guard (hard): "
    : "Action blocked by dispatch guard: "
  // C6: structured reason for the seam-level guard deny (see the `ask` arm). The
  // `hardDeny` flag selects a CATEGORICAL safeReason wording (security boundary
  // vs recoverable posture) — NEVER `decision.reason`, which echoes the matched
  // path/command/host. `layer:"stack"`, pillar OMITTED.
  return deny(
    call.id,
    `${prefix}${decision.reason}`,
    "guard-deny",
    denyReason({
      layer: "stack",
      safeReason: decision.hardDeny
        ? "dispatch guard blocked (security boundary)"
        : "dispatch guard blocked (recoverable posture)",
    }),
  )
}
