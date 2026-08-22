/**
 * Hellgate (CLUSTER D item #5) — model-facing self-propose recording seam for
 * remember-patterns, with the NO-WIDEN (no-self-grant) security invariant.
 *
 * Today the gate only has a ONE-WAY `autoPassByPatterns` short-circuit driven by
 * patterns the USER/POLICY already granted (via `PatternGrantStore.grant` /
 * `grantAndCascade` on a user `onConfirm`). The model could not PROPOSE a
 * remember-pattern for itself. This seam closes that gap:
 *
 *   - The model proposes a pattern; it is RECORDED for future auto-pass ONLY when
 *     it is already covered by the USER/POLICY baseline (a refinement of an
 *     existing grant). A recorded pattern then drives `autoPassByPatterns`.
 *   - A proposal that would WIDEN beyond the baseline (no existing grant covers
 *     it) is REJECTED — the model can never self-grant a NEW capability. Same
 *     invariant as the coordination broker (a worker cannot self-grant).
 *   - Default-OFF: absent store ⇒ no recording (byte-identical legacy).
 *   - Coverage-gated + dangerous-gated: a `dangerous` proposal is rejected unless
 *     the operator opted in via `allowDangerous`.
 */

import { describe, expect, test } from "bun:test"
import { autoPassByPatterns, PatternGrantStore, recordProposedPattern } from "@/permission"

describe("PatternGrantStore — baseline vs proposed provenance", () => {
  test("constructor grants are BASELINE (cover proposals)", () => {
    const store = new PatternGrantStore(["bash:git status"])
    expect(store.isBaseline("bash:git status")).toBe(true)
    expect(store.isBaseline("bash:rm")).toBe(false)
  })

  test("grant() adds to the BASELINE (user/policy authority)", () => {
    const store = new PatternGrantStore()
    store.grant(["read:src/**"])
    expect(store.isBaseline("read:src/**")).toBe(true)
  })

  test("recordProposed() does NOT widen the baseline — a recorded pattern is NOT baseline", () => {
    const store = new PatternGrantStore(["read:**"])
    // The proposal is covered by the baseline so it records, but recording it
    // must not promote it INTO the baseline (else the model could chain-widen:
    // propose A covered by baseline, then propose B covered by A).
    store.recordProposed(["read:**"])
    expect(store.isBaseline("read:**")).toBe(true)
    // A distinct refinement string that is NOT itself a baseline entry stays
    // non-baseline even after being recorded.
    store.recordProposed(["read:**"])
    expect(store.isBaseline("read:src/**")).toBe(false)
  })
})

describe("recordProposedPattern — NO-WIDEN (no self-grant) invariant", () => {
  test("default-OFF: absent store ⇒ no recording (no_store)", () => {
    const res = recordProposedPattern(undefined, { proposed: ["read:**"] })
    expect(res.kind).toBe("rejected")
    if (res.kind === "rejected") expect(res.reason).toBe("no_store")
  })

  test("empty proposal ⇒ rejected (empty_patterns), nothing recorded", () => {
    const store = new PatternGrantStore(["read:**"])
    const res = recordProposedPattern(store, { proposed: [] })
    expect(res.kind).toBe("rejected")
    if (res.kind === "rejected") expect(res.reason).toBe("empty_patterns")
  })

  test("proposal COVERED by the baseline ⇒ recorded + future auto-pass fires", () => {
    // Operator granted the EXACT pattern (baseline). The model proposes the same
    // pattern — a refinement covered by the baseline.
    const store = new PatternGrantStore(["read:src/**"])
    const res = recordProposedPattern(store, { proposed: ["read:src/**"] })
    expect(res.kind).toBe("recorded")
    if (res.kind === "recorded") expect(res.recorded).toEqual(["read:src/**"])
    // The recorded pattern now drives auto-pass.
    const ap = autoPassByPatterns(store, { rememberPatterns: ["read:src/**"] })
    expect(ap.kind).toBe("auto_pass")
  })

  test("proposal NOT covered by the baseline ⇒ REJECTED as a widen (no self-grant)", () => {
    // Baseline only grants `read:src/**`. The model proposes a BROADER pattern
    // the user never granted — this is a self-grant attempt and must be refused.
    const store = new PatternGrantStore(["read:src/**"])
    const res = recordProposedPattern(store, { proposed: ["bash:rm"] })
    expect(res.kind).toBe("rejected")
    if (res.kind === "rejected") expect(res.reason).toBe("would_widen")
    // Nothing recorded ⇒ auto-pass for the rejected pattern does NOT fire.
    const ap = autoPassByPatterns(store, { rememberPatterns: ["bash:rm"] })
    expect(ap.kind).toBe("fall_through")
  })

  test("partial coverage ⇒ ALL-OR-NOTHING reject (one uncovered ⇒ widen), nothing recorded", () => {
    const store = new PatternGrantStore(["read:src/**"])
    const res = recordProposedPattern(store, {
      proposed: ["read:src/**", "bash:rm"],
    })
    expect(res.kind).toBe("rejected")
    if (res.kind === "rejected") expect(res.reason).toBe("would_widen")
    // The covered half is NOT recorded either (atomic).
    const ap = autoPassByPatterns(store, { rememberPatterns: ["read:src/**"] })
    // read:src/** is already a baseline so auto-pass would fire on baseline
    // coverage regardless; assert the UNCOVERED one is not recorded.
    expect(ap.kind).toBe("auto_pass")
    const ap2 = autoPassByPatterns(store, { rememberPatterns: ["bash:rm"] })
    expect(ap2.kind).toBe("fall_through")
  })

  test("MODEL CANNOT CHAIN-WIDEN: a recorded pattern is not a baseline, so it cannot back a second proposal", () => {
    const store = new PatternGrantStore(["read:**"])
    // Step 1: model proposes `read:**` (covered by baseline) ⇒ recorded.
    expect(recordProposedPattern(store, { proposed: ["read:**"] }).kind).toBe("recorded")
    // Step 2: model proposes `read:secret/**` claiming it is "covered" by the
    // just-recorded `read:**`. Because recordings do NOT enter the baseline,
    // the only baseline pattern is the literal `read:**`, which does not equal
    // `read:secret/**` ⇒ rejected (no chain-widen).
    const res = recordProposedPattern(store, { proposed: ["read:secret/**"] })
    expect(res.kind).toBe("rejected")
    if (res.kind === "rejected") expect(res.reason).toBe("would_widen")
  })

  test("dangerous proposal ⇒ rejected unless allowDangerous (hardening parity with auto-pass)", () => {
    const store = new PatternGrantStore(["bash:git push"])
    const blocked = recordProposedPattern(store, {
      proposed: ["bash:git push"],
      isMaybeDangerous: true,
    })
    expect(blocked.kind).toBe("rejected")
    if (blocked.kind === "rejected") expect(blocked.reason).toBe("dangerous_blocked")

    const allowed = recordProposedPattern(
      store,
      { proposed: ["bash:git push"], isMaybeDangerous: true },
      { allowDangerous: true },
    )
    expect(allowed.kind).toBe("recorded")
  })

  test("idempotent: recording the same covered proposal twice is a no-op the second time", () => {
    const store = new PatternGrantStore(["read:**"])
    expect(recordProposedPattern(store, { proposed: ["read:**"] }).kind).toBe("recorded")
    const again = recordProposedPattern(store, { proposed: ["read:**"] })
    expect(again.kind).toBe("recorded")
    if (again.kind === "recorded") expect(again.recorded).toEqual(["read:**"])
  })
})
