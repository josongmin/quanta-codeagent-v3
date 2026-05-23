/**
 * Control-op cluster hellgate (L3→L4 promotion 2026-05-23).
 *
 * Targets the shared helper module that the submission-op envelope and the
 * typed conversation-action both route control-ops through. The other 3
 * features (submission/conversation-action/queued-follow-ups) have
 * end-to-end tests in tests/integration; this file PINS the helper's
 * contract + the response_queued reason taxonomy so adding a new
 * PausedReason or control-op-pending reason flushes every site at compile
 * time.
 *
 * Coverage map (no flimsy tests — every case forces a real behavioral
 * branch through the helper or asserts a closed-enum invariant):
 *
 *   - cancelSubagent: 3 outcomes (stopped / not_found / registry_absent),
 *     defensive throw catch (host-supplied stub bug must NOT propagate),
 *     never throws on malformed id.
 *   - isInterruptOp / isCancelSubagentOp: type guards positive + negative.
 *   - RESPONSE_QUEUED_REASONS taxonomy: matches union type EXACTLY,
 *     extends ALL_PAUSED_REASONS verbatim, adds the two control-op-pending
 *     reasons in the documented order (compile-time + runtime coverage so
 *     enum drift fails fast).
 */

import { describe, expect, test } from "bun:test"
import {
  cancelSubagent,
  isCancelSubagentOp,
  isInterruptOp,
  RESPONSE_QUEUED_REASONS,
  type ResponseQueuedReason,
  type SubagentRegistrySlice,
} from "../../../src/agent/control-op-handler"
import { ALL_PAUSED_REASONS, type PausedReason } from "../../../src/agent/follow-up-queue"
import type { Submission } from "../../../src/agent/submission"

// ── cancelSubagent: 3-way outcome enum ──────────────────────────────────

describe("cancelSubagent: registry-absent path (no allocation)", () => {
  test("returns 'registry_absent' when no registry was wired (default-OFF)", () => {
    // Pass undefined as the registry — common case (caller never opted into subagents).
    const out = cancelSubagent(undefined, "agent-1")
    expect(out).toBe("registry_absent")
  })
  test("never throws on registry_absent even with malformed id", () => {
    expect(() => cancelSubagent(undefined, "")).not.toThrow()
    expect(() => cancelSubagent(undefined, "@@invalid@@")).not.toThrow()
    expect(cancelSubagent(undefined, "")).toBe("registry_absent")
  })
})

describe("cancelSubagent: forceStop returns true → 'stopped'", () => {
  test("real running task ⇒ 'stopped'", () => {
    let called = false
    const reg: SubagentRegistrySlice = {
      forceStop: (id) => {
        called = true
        expect(id).toBe("agent-X")
        return true
      },
    }
    expect(cancelSubagent(reg, "agent-X")).toBe("stopped")
    expect(called).toBe(true)
  })
})

describe("cancelSubagent: forceStop returns false → 'not_found'", () => {
  test("unknown id ⇒ 'not_found' (parent turn keeps running)", () => {
    const reg: SubagentRegistrySlice = { forceStop: () => false }
    expect(cancelSubagent(reg, "agent-unknown")).toBe("not_found")
  })
  test("settled-already id ⇒ 'not_found' (same shape; observation only)", () => {
    const reg: SubagentRegistrySlice = { forceStop: () => false }
    expect(cancelSubagent(reg, "agent-settled")).toBe("not_found")
  })
})

describe("cancelSubagent: defensive — host-supplied stub bug MUST NOT propagate", () => {
  test("forceStop throws synchronously ⇒ collapses to 'not_found' (parent loop unblocked)", () => {
    const reg: SubagentRegistrySlice = {
      forceStop: () => {
        throw new Error("simulated host stub bug")
      },
    }
    expect(() => cancelSubagent(reg, "agent-buggy")).not.toThrow()
    expect(cancelSubagent(reg, "agent-buggy")).toBe("not_found")
  })
  test("forceStop throws non-Error value (string, null) ⇒ still collapses to 'not_found'", () => {
    const stringThrow: SubagentRegistrySlice = {
      forceStop: () => {
        throw "string error"
      },
    }
    const nullThrow: SubagentRegistrySlice = {
      forceStop: () => {
        throw null
      },
    }
    expect(cancelSubagent(stringThrow, "x")).toBe("not_found")
    expect(cancelSubagent(nullThrow, "x")).toBe("not_found")
  })
})

// ── Type guards: positive + negative arms ───────────────────────────────

describe("isInterruptOp / isCancelSubagentOp type guards", () => {
  const userInput: Submission = {
    id: "s1",
    op: { kind: "user_input", items: [{ type: "text", text: "hi" }] },
  }
  const interrupt: Submission = { id: "s2", op: { kind: "interrupt" } }
  const interruptWithTurn: Submission = { id: "s3", op: { kind: "interrupt", turnId: "t1" } }
  const cancelSub: Submission = {
    id: "s4",
    op: { kind: "cancel_subagent", subagentId: "agent-Y" },
  }
  const shutdown: Submission = { id: "s5", op: { kind: "shutdown" } }
  const reload: Submission = { id: "s6", op: { kind: "reload_user_config" } }

  test("isInterruptOp: matches both bare interrupt + interrupt-with-turnId", () => {
    expect(isInterruptOp(interrupt)).toBe(true)
    expect(isInterruptOp(interruptWithTurn)).toBe(true)
  })
  test("isInterruptOp: rejects every non-interrupt kind", () => {
    expect(isInterruptOp(userInput)).toBe(false)
    expect(isInterruptOp(cancelSub)).toBe(false)
    expect(isInterruptOp(shutdown)).toBe(false)
    expect(isInterruptOp(reload)).toBe(false)
  })
  test("isCancelSubagentOp: matches only cancel_subagent", () => {
    expect(isCancelSubagentOp(cancelSub)).toBe(true)
    expect(isCancelSubagentOp(userInput)).toBe(false)
    expect(isCancelSubagentOp(interrupt)).toBe(false)
    expect(isCancelSubagentOp(shutdown)).toBe(false)
    expect(isCancelSubagentOp(reload)).toBe(false)
  })
  test("type guards narrow correctly (compile-time + runtime)", () => {
    if (isInterruptOp(interruptWithTurn)) {
      // narrowed: op.kind === "interrupt" + optional turnId
      expect(interruptWithTurn.op.kind).toBe("interrupt")
      expect(interruptWithTurn.op.turnId).toBe("t1")
    }
    if (isCancelSubagentOp(cancelSub)) {
      // narrowed: op.kind === "cancel_subagent" + required subagentId
      expect(cancelSub.op.kind).toBe("cancel_subagent")
      expect(cancelSub.op.subagentId).toBe("agent-Y")
    }
  })
})

// ── RESPONSE_QUEUED_REASONS taxonomy: closed-enum invariants ────────────

describe("RESPONSE_QUEUED_REASONS taxonomy (closed-enum drift gate)", () => {
  test("matches the documented order: 10 PausedReason then 2 control-op-pending", () => {
    const expected: readonly ResponseQueuedReason[] = [
      ...ALL_PAUSED_REASONS,
      "submission_op_pending",
      "subagent_cancel_pending",
    ]
    expect([...RESPONSE_QUEUED_REASONS]).toEqual([...expected])
  })
  test("length = PausedReason count + 2 (no silent additions/drops)", () => {
    expect(RESPONSE_QUEUED_REASONS.length).toBe(ALL_PAUSED_REASONS.length + 2)
  })
  test("every PausedReason is a ResponseQueuedReason (superset relation)", () => {
    for (const r of ALL_PAUSED_REASONS) {
      expect(RESPONSE_QUEUED_REASONS.includes(r as ResponseQueuedReason)).toBe(true)
    }
  })
  test("the two control-op-pending reasons are documented in the union", () => {
    expect(RESPONSE_QUEUED_REASONS.includes("submission_op_pending")).toBe(true)
    expect(RESPONSE_QUEUED_REASONS.includes("subagent_cancel_pending")).toBe(true)
  })
  test("frozen at runtime (immutable contract; prevents accidental mutation)", () => {
    expect(Object.isFrozen(RESPONSE_QUEUED_REASONS)).toBe(true)
  })
  test("no duplicates", () => {
    const set = new Set<string>(RESPONSE_QUEUED_REASONS)
    expect(set.size).toBe(RESPONSE_QUEUED_REASONS.length)
  })
  test("PausedReason union exhaustive switch — every reason has a value", () => {
    // This forces compile-time coverage: adding a PausedReason without
    // listing it here is a tsc error in the `never` default arm.
    const witness = (r: PausedReason): string => {
      switch (r) {
        case "model_streaming":
          return "model"
        case "tool_running":
          return "tool"
        case "awaiting_approval":
          return "approval"
        case "awaiting_user":
          return "user"
        case "network_retry":
          return "retry"
        case "compaction_in_progress":
          return "compaction"
        case "review_in_progress":
          return "review"
        case "hand_off_in_progress":
          return "handoff"
        case "mid_turn_steer_in_flight":
          return "steer"
        case "unknown_blocking":
          return "unknown"
        default: {
          const _exhaustive: never = r
          return _exhaustive
        }
      }
    }
    for (const r of ALL_PAUSED_REASONS) expect(witness(r).length).toBeGreaterThan(0)
  })
})
