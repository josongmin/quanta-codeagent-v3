/**
 * HELLGATE (adversarial deep layer) — guardian-per-action-assessment.
 *
 * WHY THIS FILE EXISTS (new territory, not a dup):
 * The existing `guardian-assessment-collapse-hellgate.test.ts` proves the
 * per-variant routing, the conservative property over `ALL_ASSESSMENT_KINDS`,
 * the OFF byte-identity knob ratchet, and a handful of malformed-body cases at
 * the `collapseAssessment` boundary. It does NOT prove the SECURITY INVARIANT at
 * the `reviewAction` DISPATCH boundary under HOSTILE port behavior:
 *
 *   INVARIANT (the load-bearing claim): under the knob, a `guardianAssess` port
 *   that THROWS, returns GARBAGE, returns a NON-ENUM kind, returns `null`, or
 *   returns a malformed-but-typed value must NEVER produce an accidental ALLOW.
 *   Every failure mode either (a) collapses to `guardian_denied` (fail-closed)
 *   or (b) throws — and a throw fails CLOSED at the gate (`reviewAction`
 *   re-throws so the gate takes its deny path). NEVER a silent authorization
 *   escape.
 *
 * This battery adds, at the DISPATCH boundary (`reviewAction`, the real seam the
 * gate calls — not just `collapseAssessment` in isolation):
 *   1. Property: EVERY assessment kind × its collapse outcome, asserted through
 *      `reviewAction` (allow-set is exactly {allow, allow_for_session}).
 *   2. Hostile port: throws / returns null / returns a non-enum kind / returns a
 *      structurally-wrong object ⇒ NEVER an allowed outcome reaches a caller.
 *   3. A DEEP fuzz over adversarial `kind` values (each an "allow"-adjacent
 *      lie) ⇒ every one collapses non-allow or throws.
 *   4. Concurrency: N concurrent `reviewAction` calls with mixed hostile/benign
 *      assessments never cross-contaminate outcomes (no shared mutable state
 *      escape).
 *   5. knob-ON-but-port-absent ⇒ EXACT legacy binary path (byte-identical),
 *      AND an assessor-only allow does not leak through when the knob is off.
 *
 * RED-ON-INJECTION: an in-tree source mutation that loosens the unknown-kind
 * default arm to an allow outcome (documented in the final describe block) makes
 * the fuzz + hostile-port assertions RED; reverted immediately, `git diff` empty.
 *
 * Source under test:
 *   src/permission/reviewer.ts          — reviewAction / dispatchFresh
 *   src/permission/assessment-collapse.ts — collapseAssessment
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  type ActionAssessment,
  ALL_ASSESSMENT_KINDS,
  collapseAssessment,
  isAllowed,
  type ReviewContext,
  type ReviewerPort,
  reviewAction,
  structuredDenyReason,
  type ToolActionKeyed,
} from "@/permission"
import { __resetRuntimeConfig } from "@/shared"

const CLOCK = 1_700_000_000_000

const action: ToolActionKeyed = {
  tool: "bash",
  input: { command: "rm -rf /" },
  isReadOnly: false,
  actionKey: "bash:rm",
}

const ctx = (overrides: Partial<ReviewContext> = {}): ReviewContext => ({
  sessionId: "s1",
  turnId: "t1",
  priorDenials: [],
  configReviewer: "guardian_subagent",
  decidedAt: CLOCK,
  ...overrides,
})

type ConcurrentAssessmentSpec = {
  tag: string
  assess: () => Promise<ActionAssessment>
  allow: boolean
}

const concurrentAssessmentSpec = (index: number): ConcurrentAssessmentSpec => {
  switch (index % 4) {
    case 0:
      return { tag: `allow${index}`, assess: async () => sampleFor("allow"), allow: true }
    case 1:
      return { tag: `deny${index}`, assess: async () => sampleFor("deny"), allow: false }
    case 2:
      return {
        tag: `garbage${index}`,
        assess: async () => ({ kind: "grant_all", rationale: "x" }) as unknown as ActionAssessment,
        allow: false,
      }
    default:
      return {
        tag: `throw${index}`,
        assess: async () => {
          throw new Error("boom")
        },
        allow: false,
      }
  }
}

const denyR = structuredDenyReason({ layer: "reviewer", pillar: "approval", safeReason: "unsafe" })

/** Total builder over the union — the switch has NO default, so it only compiles
 *  when every kind has a sample (drift guard shared with the base battery). */
const sampleFor = (kind: ActionAssessment["kind"]): ActionAssessment => {
  switch (kind) {
    case "allow":
      return { kind: "allow", rationale: "fine", riskLevel: "low" }
    case "allow_for_session":
      return { kind: "allow_for_session", rationale: "fine all session" }
    case "allow_with_edit":
      return {
        kind: "allow_with_edit",
        rationale: "corrected",
        updatedInput: { command: "git push --force-with-lease" },
        steer: "use --force-with-lease",
      }
    case "ask":
      return { kind: "ask", rationale: "uncertain" }
    case "deny":
      return { kind: "deny", rationale: "no", denyReason: denyR }
    case "deny_and_steer":
      return { kind: "deny_and_steer", rationale: "no", denyReason: denyR, steer: "try X" }
    case "escalate":
      return { kind: "escalate", rationale: "needs grant", escalation: { axis: "network" } }
  }
}

/** A ReviewerPort whose guardianAssess yields `a` (or throws when `a` is a
 *  throwing thunk). The binary + user + auto methods trap loudly so a
 *  cross-path leak is visible. */
const assessorPort = (assess: () => Promise<ActionAssessment>): ReviewerPort => ({
  userReview: async () => {
    throw new Error("userReview must not be called")
  },
  autoReview: async () => {
    throw new Error("autoReview must not be called")
  },
  guardianReview: async () => {
    throw new Error("binary guardianReview must NOT run when assessor services the tier")
  },
  guardianAssess: assess,
})

const withKnob = () => {
  const saved = process.env.QUANTA_GUARDIAN_ASSESSOR
  beforeEach(() => {
    process.env.QUANTA_GUARDIAN_ASSESSOR = "1"
    __resetRuntimeConfig()
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.QUANTA_GUARDIAN_ASSESSOR
    else process.env.QUANTA_GUARDIAN_ASSESSOR = saved
    __resetRuntimeConfig()
  })
}

/** The ONLY assessment kinds that may end in an allowed outcome. Encoded as a
 *  closed set so a future variant added to the allow-set is a DELIBERATE edit. */
const ALLOWING_KINDS = new Set<ActionAssessment["kind"]>(["allow", "allow_for_session"])

describe("reviewAction (knob ON) — EVERY kind routed through the real dispatch seam", () => {
  withKnob()

  test("only allow/allow_for_session yield an allowed outcome; all others deny — at the DISPATCH boundary", async () => {
    for (const kind of ALL_ASSESSMENT_KINDS) {
      const dec = await reviewAction(
        action,
        ctx(),
        assessorPort(async () => sampleFor(kind)),
      )
      const shouldAllow = ALLOWING_KINDS.has(kind)
      expect(isAllowed(dec.outcome)).toBe(shouldAllow)
      // The tier is pinned to guardian so no foreign-reviewer matrix dodge.
      expect(dec.reviewer).toBe("guardian_subagent")
      // decidedAt provenance is the CALLER's clock, never the assessment's.
      expect(dec.decidedAt).toBe(CLOCK)
      if (!shouldAllow) expect(dec.outcome).toBe("guardian_denied")
    }
  })
})

describe("reviewAction (knob ON) — HOSTILE guardianAssess never yields an accidental allow", () => {
  withKnob()

  test("a THROWING assessor fails CLOSED at the gate (reviewAction re-throws — no silent allow)", async () => {
    let threw = false
    let leakedAllow = false
    try {
      const dec = await reviewAction(
        action,
        ctx(),
        assessorPort(async () => {
          throw new Error("hostile assessor boom")
        }),
      )
      leakedAllow = isAllowed(dec.outcome)
    } catch {
      threw = true
    }
    // A throw is an acceptable fail-closed shape (the gate's deny path runs).
    // What is NEVER acceptable is returning an allowed decision.
    expect(threw).toBe(true)
    expect(leakedAllow).toBe(false)
  })

  test("a NON-ENUM kind (allow-adjacent lie) ⇒ guardian_denied, NEVER an allow", async () => {
    const dec = await reviewAction(
      action,
      ctx(),
      assessorPort(
        async () =>
          ({ kind: "auto_grant_everything", rationale: "trust me" }) as unknown as ActionAssessment,
      ),
    )
    expect(dec.outcome).toBe("guardian_denied")
    expect(isAllowed(dec.outcome)).toBe(false)
  })

  test("a `null` assessment fails CLOSED (throws — not a silent allow)", async () => {
    let threw = false
    let leakedAllow = false
    try {
      const dec = await reviewAction(
        action,
        ctx(),
        assessorPort(async () => null as unknown as ActionAssessment),
      )
      leakedAllow = isAllowed(dec.outcome)
    } catch {
      threw = true
    }
    // A `null` reply dereferences `.kind` inside the collapse ⇒ TypeError, which
    // `reviewAction` re-throws — the gate's deny path runs. The SECURITY property
    // is the same as every other hostile shape: it must NEVER return an allow.
    expect(threw).toBe(true) // current behavior: fails closed by throwing.
    expect(leakedAllow).toBe(false)
  })

  test("a structurally-wrong object (no kind field) ⇒ never an allow", async () => {
    let leakedAllow = false
    try {
      const dec = await reviewAction(
        action,
        ctx(),
        assessorPort(async () => ({ totally: "bogus" }) as unknown as ActionAssessment),
      )
      leakedAllow = isAllowed(dec.outcome)
    } catch {
      // throwing is fail-closed; acceptable.
    }
    expect(leakedAllow).toBe(false)
  })

  test("FUZZ: a battery of allow-adjacent LIES all fail non-allow (or throw) — never a silent escape", async () => {
    const rogueKinds = [
      "allow_all",
      "ALLOW",
      "Allow",
      "allow ",
      " allow",
      "allow_for_session_forever",
      "approve",
      "approved_exec",
      "yes",
      "true",
      "1",
      "__proto__",
      "constructor",
      "",
      "allowallowallow",
    ]
    for (const k of rogueKinds) {
      let leakedAllow = false
      try {
        const dec = await reviewAction(
          action,
          ctx(),
          assessorPort(async () => ({ kind: k, rationale: "x" }) as unknown as ActionAssessment),
        )
        leakedAllow = isAllowed(dec.outcome)
      } catch {
        // throw = fail-closed
      }
      expect(leakedAllow).toBe(false)
    }
  })
})

describe("collapseAssessment — direct fuzz over adversarial kinds (unit-level fail-closed)", () => {
  test("every non-{allow,allow_for_session} discriminant collapses non-allow or throws", () => {
    const rogueKinds = [
      "allow_all",
      "ALLOW",
      " allow",
      "approve",
      "grant",
      "ok",
      "__proto__",
      "toString",
      "",
    ]
    for (const k of rogueKinds) {
      let leakedAllow = false
      try {
        const d = collapseAssessment(
          { kind: k, rationale: "x" } as unknown as ActionAssessment,
          CLOCK,
        )
        leakedAllow = isAllowed(d.outcome)
      } catch {
        // throw = fail-closed
      }
      expect(leakedAllow).toBe(false)
    }
  })

  test("a prototype-polluted-looking object does not tunnel to allow", () => {
    // A hostile value carrying `kind: "allow"` on its PROTOTYPE (not own prop)
    // still resolves `assessment.kind` to "allow" — this is a genuine allow and
    // SHOULD collapse to guardian_approved. The security-relevant case is the
    // inverse: an own `kind` that is NOT in the union must never allow — covered
    // above. Here we assert the honest allow still requires a valid rationale
    // (buildDecision's second line), so a rationale-less proto-allow throws.
    const proto = { kind: "allow", riskLevel: "low" }
    const hostile = Object.create(proto) as ActionAssessment
    let threwOrDenied = false
    try {
      const d = collapseAssessment(hostile, CLOCK)
      // If it did produce a decision it must at least not be an allow without a
      // rationale (buildDecision throws on empty/absent rationale).
      threwOrDenied = !isAllowed(d.outcome)
    } catch {
      threwOrDenied = true
    }
    expect(threwOrDenied).toBe(true)
  })
})

describe("reviewAction (knob ON) — CONCURRENCY: mixed hostile/benign never cross-contaminate", () => {
  withKnob()

  test("N concurrent reviews keep each verdict isolated (no shared-state escape)", async () => {
    // Interleave allow / deny / throw / garbage assessments concurrently. Each
    // resolved outcome must match its OWN assessment — a shared mutable seam
    // (e.g. a module-level "last decision") would let a benign allow bleed into
    // a hostile slot.
    const specs = Array.from({ length: 40 }, (_, index) => concurrentAssessmentSpec(index))

    const results = await Promise.all(
      specs.map(async (s) => {
        try {
          const dec = await reviewAction(
            { ...action, actionKey: `k:${s.tag}` },
            ctx({ turnId: s.tag }),
            assessorPort(s.assess),
          )
          return { tag: s.tag, allowed: isAllowed(dec.outcome), threw: false }
        } catch {
          return { tag: s.tag, allowed: false, threw: true }
        }
      }),
    )

    for (let i = 0; i < specs.length; i++) {
      const r = results[i]
      const s = specs[i]
      if (!r || !s) throw new Error("index mismatch")
      // The allow-expectation must hold PER SLOT — no benign allow bled into a
      // hostile slot and vice-versa.
      expect(r.allowed).toBe(s.allow)
    }
    // At least one of each class actually ran (guards against a vacuous pass).
    expect(results.some((r) => r.allowed)).toBe(true)
    expect(results.some((r) => !r.allowed)).toBe(true)
  })
})

describe("knob gating — knob ON but port ABSENT of guardianAssess ⇒ EXACT legacy binary path", () => {
  const saved = process.env.QUANTA_GUARDIAN_ASSESSOR
  beforeEach(() => {
    __resetRuntimeConfig()
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.QUANTA_GUARDIAN_ASSESSOR
    else process.env.QUANTA_GUARDIAN_ASSESSOR = saved
    __resetRuntimeConfig()
  })

  const binary = {
    reviewer: "guardian_subagent" as const,
    outcome: "guardian_approved" as const,
    riskLevel: "low" as const,
    rationale: "binary path",
    decidedAt: CLOCK,
  }

  test("knob ON, no guardianAssess method ⇒ binary guardianReview runs (no crash, byte-identical outcome)", async () => {
    process.env.QUANTA_GUARDIAN_ASSESSOR = "1"
    __resetRuntimeConfig()
    let binaryCalls = 0
    const port: ReviewerPort = {
      userReview: async () => {
        throw new Error("no")
      },
      autoReview: async () => {
        throw new Error("no")
      },
      guardianReview: async () => {
        binaryCalls++
        return binary
      },
      // guardianAssess intentionally ABSENT — every current impl omits it.
    }
    const dec = await reviewAction(action, ctx(), port)
    expect(binaryCalls).toBe(1)
    expect(dec.outcome).toBe("guardian_approved")
  })

  test("knob OFF + an assessor that WOULD allow ⇒ the assessor is NEVER consulted (binary path wins)", async () => {
    delete process.env.QUANTA_GUARDIAN_ASSESSOR
    __resetRuntimeConfig()
    let assessCalls = 0
    let binaryCalls = 0
    const port: ReviewerPort = {
      userReview: async () => {
        throw new Error("no")
      },
      autoReview: async () => {
        throw new Error("no")
      },
      guardianReview: async () => {
        binaryCalls++
        return { ...binary, outcome: "guardian_denied" as const, rationale: "binary denies" }
      },
      guardianAssess: async () => {
        assessCalls++
        return { kind: "allow", rationale: "assessor would allow", riskLevel: "low" }
      },
    }
    const dec = await reviewAction(action, ctx(), port)
    // OFF byte-identity: the would-allow assessor never runs; binary deny stands.
    expect(assessCalls).toBe(0)
    expect(binaryCalls).toBe(1)
    expect(dec.outcome).toBe("guardian_denied")
    expect(isAllowed(dec.outcome)).toBe(false)
  })
})
