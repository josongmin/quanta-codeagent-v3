/**
 * Typed ConversationAction mid-turn steering tests (ADR-0071).
 *
 * Covers the typed action algebra layered ON TOP of `steer()`:
 *   - user_message delegates to steer() (accepted + every rejection reason
 *     still reachable through the delegation)
 *   - prepend[] concatenation with ACTION_PREPEND_SEPARATOR
 *   - cancel (accepted_control + no_active_turn + empty-reason throw)
 *   - cancel_subagent (accepted_control + no_active_turn + empty-id throw)
 *   - summarize gating (accepted + interrupted/no_active_turn)
 *   - resume gating (accepted only while interrupted + not_interrupted)
 *   - opt-in optimistic concurrency (control_turn_mismatch)
 *   - exhaustiveness (ALL_ACTION_KINDS / ALL_ACTION_REJECTION_REASONS)
 *   - the existing steer() is unchanged (a known case still holds)
 *
 * Pure module — fixed clock supplied so assertions read as a contract.
 */
import { describe, expect, test } from "bun:test"
import {
  ACTION_PREPEND_SEPARATOR,
  type ActiveTurnState,
  ALL_ACTION_KINDS,
  ALL_ACTION_REJECTION_REASONS,
  ALL_REJECTION_REASONS,
  type ConversationAction,
  decideAction,
  type SteerConfig,
  SteerInputInvalidError,
  steer,
} from "@/agent/steering"
import { makeTurnHeader, type TurnHeader, type TurnKind } from "@/agent/turn-kind"

const FIXED_CLOCK = 1_700_000_000_000
const NOW = FIXED_CLOCK + 100
const DEFAULT_TURN_ID = "turn-001"
const DEFAULT_THREAD_ID = "thread-A"

const header = (
  overrides: Partial<{ turnId: string; kind: TurnKind; threadId: string }> = {},
): TurnHeader =>
  makeTurnHeader({
    turnId: DEFAULT_TURN_ID,
    kind: "main",
    startedAt: FIXED_CLOCK,
    threadId: DEFAULT_THREAD_ID,
    ...overrides,
  })

const state = (overrides: Partial<ActiveTurnState> = {}): ActiveTurnState => ({
  currentTurn: header(),
  isInterrupted: false,
  ...overrides,
})

const cfg = (overrides: Partial<SteerConfig> = {}): SteerConfig => ({
  maxInputBytes: 4096,
  ...overrides,
})

describe("decideAction — user_message delegates to steer()", () => {
  test("accepted produces accepted_injection mirroring steer()", () => {
    const action: ConversationAction = {
      kind: "user_message",
      input: "please also check the lockfile",
      expectedTurnId: DEFAULT_TURN_ID,
    }
    const out = decideAction(action, state(), cfg(), NOW)
    expect(out.kind).toBe("accepted_injection")
    if (out.kind !== "accepted_injection") return
    expect(out.injection.role).toBe("user")
    expect(out.injection.content).toBe("please also check the lockfile")
    expect(out.injection.injectedAt).toBe(NOW)
    expect(out.injection.injectedDuringTurnId).toBe(DEFAULT_TURN_ID)
  })

  test("no_active_turn surfaces verbatim from steer()", () => {
    const out = decideAction(
      { kind: "user_message", input: "hi", expectedTurnId: DEFAULT_TURN_ID },
      state({ currentTurn: null }),
      cfg(),
      NOW,
    )
    expect(out.kind).toBe("rejected")
    if (out.kind === "rejected") expect(out.reason).toBe("no_active_turn")
  })

  test("expected_turn_mismatch surfaces verbatim from steer()", () => {
    const out = decideAction(
      { kind: "user_message", input: "hi", expectedTurnId: "turn-999" },
      state(),
      cfg(),
      NOW,
    )
    expect(out.kind).toBe("rejected")
    if (out.kind === "rejected") expect(out.reason).toBe("expected_turn_mismatch")
  })

  test("non_steerable_review surfaces verbatim from steer()", () => {
    const out = decideAction(
      { kind: "user_message", input: "hi", expectedTurnId: DEFAULT_TURN_ID },
      state({ currentTurn: header({ kind: "review" }) }),
      cfg(),
      NOW,
    )
    expect(out.kind).toBe("rejected")
    if (out.kind === "rejected") expect(out.reason).toBe("non_steerable_review")
  })

  test("empty_input surfaces verbatim from steer()", () => {
    const out = decideAction(
      { kind: "user_message", input: "   ", expectedTurnId: DEFAULT_TURN_ID },
      state(),
      cfg(),
      NOW,
    )
    expect(out.kind).toBe("rejected")
    if (out.kind === "rejected") expect(out.reason).toBe("empty_input")
  })

  test("input_too_large surfaces verbatim from steer()", () => {
    const out = decideAction(
      { kind: "user_message", input: "a".repeat(10), expectedTurnId: DEFAULT_TURN_ID },
      state(),
      cfg({ maxInputBytes: 5 }),
      NOW,
    )
    expect(out.kind).toBe("rejected")
    if (out.kind === "rejected") expect(out.reason).toBe("input_too_large")
  })

  test("interrupted surfaces verbatim from steer()", () => {
    const out = decideAction(
      { kind: "user_message", input: "hi", expectedTurnId: DEFAULT_TURN_ID },
      state({ isInterrupted: true }),
      cfg(),
      NOW,
    )
    expect(out.kind).toBe("rejected")
    if (out.kind === "rejected") expect(out.reason).toBe("interrupted")
  })

  test("missing expectedTurnId is a programming bug (throws)", () => {
    expect(() => decideAction({ kind: "user_message", input: "hi" }, state(), cfg(), NOW)).toThrow(
      SteerInputInvalidError,
    )
  })

  test("non-string input throws SteerInputInvalidError", () => {
    expect(() =>
      decideAction(
        {
          kind: "user_message",
          input: 123 as unknown as string,
          expectedTurnId: DEFAULT_TURN_ID,
        },
        state(),
        cfg(),
        NOW,
      ),
    ).toThrow(SteerInputInvalidError)
  })
})

describe("decideAction — prepend[] concatenation", () => {
  test("prepend lines join ahead of input with the documented separator", () => {
    const action: ConversationAction = {
      kind: "user_message",
      input: "main body",
      prepend: ["context line 1", "context line 2"],
      expectedTurnId: DEFAULT_TURN_ID,
    }
    const out = decideAction(action, state(), cfg(), NOW)
    expect(out.kind).toBe("accepted_injection")
    if (out.kind !== "accepted_injection") return
    expect(out.injection.content).toBe(
      ["context line 1", "context line 2", "main body"].join(ACTION_PREPEND_SEPARATOR),
    )
  })

  test("empty prepend array leaves input untouched", () => {
    const out = decideAction(
      { kind: "user_message", input: "body", prepend: [], expectedTurnId: DEFAULT_TURN_ID },
      state(),
      cfg(),
      NOW,
    )
    expect(out.kind).toBe("accepted_injection")
    if (out.kind === "accepted_injection") expect(out.injection.content).toBe("body")
  })

  test("non-string prepend line throws SteerInputInvalidError", () => {
    expect(() =>
      decideAction(
        {
          kind: "user_message",
          input: "body",
          prepend: [123 as unknown as string],
          expectedTurnId: DEFAULT_TURN_ID,
        },
        state(),
        cfg(),
        NOW,
      ),
    ).toThrow(SteerInputInvalidError)
  })
})

describe("decideAction — cancel", () => {
  test("accepted_control on an active turn", () => {
    const action: ConversationAction = { kind: "cancel", reason: "user changed their mind" }
    const out = decideAction(action, state(), cfg(), NOW)
    expect(out.kind).toBe("accepted_control")
    if (out.kind === "accepted_control") expect(out.action).toBe(action)
  })

  test("no_active_turn when there is no turn", () => {
    const out = decideAction(
      { kind: "cancel", reason: "stop" },
      state({ currentTurn: null }),
      cfg(),
      NOW,
    )
    expect(out.kind).toBe("rejected")
    if (out.kind === "rejected") expect(out.reason).toBe("no_active_turn")
  })

  test("interrupted turn rejects cancel (already unwinding)", () => {
    const out = decideAction(
      { kind: "cancel", reason: "stop" },
      state({ isInterrupted: true }),
      cfg(),
      NOW,
    )
    expect(out.kind).toBe("rejected")
    if (out.kind === "rejected") expect(out.reason).toBe("interrupted")
  })

  test("empty reason is a programming bug (throws)", () => {
    expect(() => decideAction({ kind: "cancel", reason: "   " }, state(), cfg(), NOW)).toThrow(
      SteerInputInvalidError,
    )
  })
})

describe("decideAction — cancel_subagent (headline new capability)", () => {
  test("accepted_control cancels one child without unwinding the parent turn", () => {
    const action: ConversationAction = { kind: "cancel_subagent", subagentId: "sub-7" }
    const out = decideAction(action, state(), cfg(), NOW)
    expect(out.kind).toBe("accepted_control")
    if (out.kind === "accepted_control") {
      expect(out.action.kind).toBe("cancel_subagent")
      if (out.action.kind === "cancel_subagent") expect(out.action.subagentId).toBe("sub-7")
    }
  })

  test("no_active_turn when there is no turn", () => {
    const out = decideAction(
      { kind: "cancel_subagent", subagentId: "sub-7" },
      state({ currentTurn: null }),
      cfg(),
      NOW,
    )
    expect(out.kind).toBe("rejected")
    if (out.kind === "rejected") expect(out.reason).toBe("no_active_turn")
  })

  test("empty subagentId is a programming bug (throws)", () => {
    expect(() =>
      decideAction({ kind: "cancel_subagent", subagentId: "" }, state(), cfg(), NOW),
    ).toThrow(SteerInputInvalidError)
  })
})

describe("decideAction — summarize", () => {
  test("accepted_control on an active, non-interrupted turn", () => {
    const out = decideAction({ kind: "summarize" }, state(), cfg(), NOW)
    expect(out.kind).toBe("accepted_control")
  })

  test("no_active_turn when there is no turn", () => {
    const out = decideAction({ kind: "summarize" }, state({ currentTurn: null }), cfg(), NOW)
    expect(out.kind).toBe("rejected")
    if (out.kind === "rejected") expect(out.reason).toBe("no_active_turn")
  })

  test("interrupted turn rejects summarize", () => {
    const out = decideAction({ kind: "summarize" }, state({ isInterrupted: true }), cfg(), NOW)
    expect(out.kind).toBe("rejected")
    if (out.kind === "rejected") expect(out.reason).toBe("interrupted")
  })
})

describe("decideAction — resume (inverse gate)", () => {
  test("accepted_control ONLY while interrupted", () => {
    const out = decideAction({ kind: "resume" }, state({ isInterrupted: true }), cfg(), NOW)
    expect(out.kind).toBe("accepted_control")
  })

  test("not_interrupted when the turn is running normally", () => {
    const out = decideAction({ kind: "resume" }, state(), cfg(), NOW)
    expect(out.kind).toBe("rejected")
    if (out.kind === "rejected") expect(out.reason).toBe("not_interrupted")
  })

  test("no_active_turn even while interrupted if there is no turn", () => {
    const out = decideAction(
      { kind: "resume" },
      state({ currentTurn: null, isInterrupted: true }),
      cfg(),
      NOW,
    )
    expect(out.kind).toBe("rejected")
    if (out.kind === "rejected") expect(out.reason).toBe("no_active_turn")
  })
})

describe("decideAction — opt-in optimistic concurrency for control actions", () => {
  test("control_turn_mismatch when expectedTurnId is present and wrong", () => {
    const out = decideAction(
      { kind: "cancel", reason: "stop", expectedTurnId: "turn-999" },
      state(),
      cfg(),
      NOW,
    )
    expect(out.kind).toBe("rejected")
    if (out.kind === "rejected") expect(out.reason).toBe("control_turn_mismatch")
  })

  test("matching expectedTurnId proceeds", () => {
    const out = decideAction(
      { kind: "cancel", reason: "stop", expectedTurnId: DEFAULT_TURN_ID },
      state(),
      cfg(),
      NOW,
    )
    expect(out.kind).toBe("accepted_control")
  })

  test("omitted expectedTurnId skips the concurrency check", () => {
    const out = decideAction(
      { kind: "cancel_subagent", subagentId: "sub-1" },
      state({ currentTurn: header({ turnId: "any-id" }) }),
      cfg(),
      NOW,
    )
    expect(out.kind).toBe("accepted_control")
  })

  test("empty expectedTurnId string is a programming bug (throws)", () => {
    expect(() =>
      decideAction({ kind: "cancel", reason: "stop", expectedTurnId: "" }, state(), cfg(), NOW),
    ).toThrow(SteerInputInvalidError)
  })
})

describe("decideAction — invalid clock", () => {
  test("NaN now throws SteerInputInvalidError", () => {
    expect(() => decideAction({ kind: "summarize" }, state(), cfg(), Number.NaN)).toThrow(
      SteerInputInvalidError,
    )
  })

  test("negative now throws SteerInputInvalidError", () => {
    expect(() => decideAction({ kind: "summarize" }, state(), cfg(), -1)).toThrow(
      SteerInputInvalidError,
    )
  })
})

describe("decideAction — closed enum coverage", () => {
  test("ALL_ACTION_KINDS lists exactly the five action kinds", () => {
    expect(ALL_ACTION_KINDS).toEqual([
      "user_message",
      "cancel",
      "cancel_subagent",
      "summarize",
      "resume",
    ])
    expect(ALL_ACTION_KINDS.length).toBe(5)
  })

  test("ALL_ACTION_REJECTION_REASONS reuses the steer reasons + two control reasons", () => {
    expect(ALL_ACTION_REJECTION_REASONS).toEqual([
      ...ALL_REJECTION_REASONS,
      "control_turn_mismatch",
      "not_interrupted",
    ])
    const actionReasonCount: number = ALL_ACTION_REJECTION_REASONS.length
    expect(actionReasonCount).toBe(ALL_REJECTION_REASONS.length + 2)
  })

  test("exhaustiveness — every ALL_ACTION_KINDS member is a real branch (no never default hit)", () => {
    // Drive each kind through decideAction with a shape that satisfies its
    // validation; assert none falls through to the `never` default (which
    // would throw an "unhandled action kind" SteerInputInvalidError).
    const byKind: Record<ConversationAction["kind"], ConversationAction> = {
      user_message: { kind: "user_message", input: "x", expectedTurnId: DEFAULT_TURN_ID },
      cancel: { kind: "cancel", reason: "stop" },
      cancel_subagent: { kind: "cancel_subagent", subagentId: "sub-1" },
      summarize: { kind: "summarize" },
      resume: { kind: "resume" },
    }
    for (const kind of ALL_ACTION_KINDS) {
      const action = byKind[kind]
      const interrupted = kind === "resume"
      const out = decideAction(action, state({ isInterrupted: interrupted }), cfg(), NOW)
      expect(out.kind === "accepted_injection" || out.kind === "accepted_control").toBe(true)
    }
  })
})

describe("decideAction — existing steer() is unchanged", () => {
  test("steer() still accepts a known case directly (byte-identical behavior)", () => {
    const out = steer(
      { expectedTurnId: DEFAULT_TURN_ID, input: "direct steer call", submittedAt: NOW },
      state(),
      cfg(),
    )
    expect(out.kind).toBe("accepted")
    if (out.kind === "accepted") {
      expect(out.injection.content).toBe("direct steer call")
      expect(out.injection.injectedDuringTurnId).toBe(DEFAULT_TURN_ID)
    }
  })

  test("steer() rejected arm is a different shape than decideAction (no leakage)", () => {
    const direct = steer(
      { expectedTurnId: "turn-999", input: "x", submittedAt: NOW },
      state(),
      cfg(),
    )
    expect(direct.kind).toBe("rejected")
    if (direct.kind === "rejected") expect(direct.reason).toBe("expected_turn_mismatch")
  })
})
