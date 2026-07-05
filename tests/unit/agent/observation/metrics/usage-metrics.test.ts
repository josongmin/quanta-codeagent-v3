import { beforeEach, describe, expect, test } from "bun:test"
import {
  bundleOwnerPaths,
  type CriticObservation,
  criticSavedEditRate,
  hintFollowWithoutVerifyRate,
  hintReadRate,
  hintVerifyRate,
  ownerEditHitRate,
  pathMatchesOwner,
  wrongOwnerEditRate,
} from "@/agent/observation/metrics"
import {
  bash,
  bundle,
  edit,
  emptyBundle,
  lspDef,
  owner,
  read,
  resetSeq,
  scriptedReplace,
  testRunner,
} from "./fixtures"

beforeEach(resetSeq)

const OWNER = "django/db/backends/base/client.py"
const ABS = `/home/ubuntu/.quanta/bench/work/bench-x/repo-Y/${OWNER}`
const OTHER = "django/db/models/query.py"

describe("pathMatchesOwner (sandbox-absolute vs repo-relative)", () => {
  test("absolute sandbox path matches repo-relative owner (real trajectory shape)", () => {
    expect(pathMatchesOwner(ABS, OWNER)).toBe(true)
    expect(pathMatchesOwner(OWNER, OWNER)).toBe(true)
  })
  test("does NOT match on a mid-filename coincidence (boundary-anchored)", () => {
    // `client.py` alone must not match `base/client.py`; but the whole rel path does.
    expect(pathMatchesOwner("django/db/backends/base/xclient.py", OWNER)).toBe(false)
    expect(pathMatchesOwner("client.py", OWNER)).toBe(true) // trailing component IS a match
    expect(pathMatchesOwner("aclient.py", OWNER)).toBe(false)
  })
  test("different files never match", () => {
    expect(pathMatchesOwner(OTHER, OWNER)).toBe(false)
  })
})

describe("bundleOwnerPaths", () => {
  test("dedups and preserves order", () => {
    const b = bundle([owner(OWNER), owner(OWNER), owner(OTHER)])
    expect(bundleOwnerPaths(b)).toEqual([OWNER, OTHER])
  })
})

// ---------------------------------------------------------------------------
// HARD invariant: empty / degenerate ⇒ not-applicable (null), NEVER 0-as-success
// ---------------------------------------------------------------------------
describe("empty-denominator ⇒ not-applicable (no flatter, no NaN)", () => {
  const events = [read(OWNER), edit(OWNER)]

  test("no observations ⇒ every bundle-driven rate is not-applicable", () => {
    const b = emptyBundle()
    for (const r of [
      ownerEditHitRate(events, b),
      hintReadRate(events, b),
      hintVerifyRate(events, b),
      hintFollowWithoutVerifyRate(events, b),
    ]) {
      expect(r.applicable).toBe(false)
      expect(r.rate).toBeNull()
      expect(Number.isNaN(r.rate as unknown as number)).toBe(false)
    }
  })

  test("owners suggested but NONE edited ⇒ read/verify/follow are not-applicable (not 0)", () => {
    const b = bundle([owner(OWNER)])
    const noEdits = [read(OTHER), bash("ls")]
    // owner_edit_hit HAS a denominator (owners exist) ⇒ applicable, rate 0 (real 0).
    expect(ownerEditHitRate(noEdits, b)).toMatchObject({ applicable: true, rate: 0 })
    // but the "followed the hint" population is empty ⇒ not-applicable, NOT a
    // flattering 0% overtrust.
    expect(hintReadRate(noEdits, b).applicable).toBe(false)
    expect(hintVerifyRate(noEdits, b).applicable).toBe(false)
    const fwv = hintFollowWithoutVerifyRate(noEdits, b)
    expect(fwv.applicable).toBe(false)
    expect(fwv.rate).toBeNull()
  })

  test("critic never fired ⇒ critic_saved not-applicable", () => {
    const r = criticSavedEditRate(events, { passed: true, criticVerdicts: [] })
    expect(r.applicable).toBe(false)
    expect(r.rate).toBeNull()
  })

  test("no success patch ⇒ wrong_owner not-applicable (never guesses wrong=0)", () => {
    const r = wrongOwnerEditRate([edit(OWNER)], { passed: false })
    expect(r.applicable).toBe(false)
    expect(r.rate).toBeNull()
  })

  test("no edits ⇒ wrong_owner not-applicable even with a known patch", () => {
    const r = wrongOwnerEditRate([read(OWNER)], { successPatchFiles: [OWNER] })
    expect(r.applicable).toBe(false)
  })
})

describe("owner_edit_hit_rate", () => {
  test("edits a suggested owner (absolute path) ⇒ hit", () => {
    const b = bundle([owner(OWNER), owner(OTHER)])
    const r = ownerEditHitRate([read(ABS), edit(ABS)], b)
    expect(r).toMatchObject({ applicable: true, num: 1, den: 2, rate: 0.5 })
  })
  test("edits NO suggested owner ⇒ real 0 (applicable)", () => {
    const b = bundle([owner(OWNER)])
    const r = ownerEditHitRate([edit("unrelated/foo.py")], b)
    expect(r).toMatchObject({ applicable: true, rate: 0 })
  })
})

describe("hint_read_rate", () => {
  test("read BEFORE edit of the owner ⇒ 1", () => {
    const b = bundle([owner(OWNER)])
    const r = hintReadRate([read(OWNER), edit(OWNER)], b)
    expect(r).toMatchObject({ applicable: true, num: 1, den: 1, rate: 1 })
  })
  test("edit WITHOUT any prior read ⇒ 0 (applicable)", () => {
    const b = bundle([owner(OWNER)])
    const r = hintReadRate([edit(OWNER)], b)
    expect(r).toMatchObject({ applicable: true, num: 0, den: 1, rate: 0 })
  })
  test("read AFTER the edit does NOT count (order matters)", () => {
    const b = bundle([owner(OWNER)])
    const r = hintReadRate([edit(OWNER), read(OWNER)], b)
    expect(r.rate).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// hint_follow_without_verify_rate — THE overtrust early warning (pinned hardest)
// ---------------------------------------------------------------------------
describe("hint_follow_without_verify_rate (overtrust early-warning)", () => {
  const b = bundle([owner(OWNER)])

  test("edits a suggested owner with NO prior read/verify ⇒ scored as follow-without-verify", () => {
    const r = hintFollowWithoutVerifyRate([edit(OWNER)], b)
    expect(r).toMatchObject({ applicable: true, num: 1, den: 1, rate: 1 })
  })

  test("edits WITH a prior verify ⇒ NOT scored (read counts as verify)", () => {
    const r = hintFollowWithoutVerifyRate([read(OWNER), edit(OWNER)], b)
    expect(r).toMatchObject({ applicable: true, num: 0, den: 1, rate: 0 })
  })

  test("prior LSP nav on the owner counts as verify", () => {
    const r = hintFollowWithoutVerifyRate([lspDef(OWNER), edit(OWNER)], b)
    expect(r.rate).toBe(0)
  })

  test("prior test-runner (behavioural exercise) counts as verify", () => {
    expect(hintFollowWithoutVerifyRate([testRunner(), edit(OWNER)], b).rate).toBe(0)
  })

  test("OVERTRUST-LAUNDER guard: a bare bash before the edit does NOT count as verify", () => {
    // A raw shell command is not a check of the specific edit target — counting
    // it would deflate the overtrust signal. So follow-without-verify STILL fires.
    expect(hintFollowWithoutVerifyRate([bash("ls"), edit(OWNER)], b).rate).toBe(1)
  })

  test("VACUITY / red-on-injection: flipping read↔edit order flips the score", () => {
    const verified = hintFollowWithoutVerifyRate([read(OWNER), edit(OWNER)], b).rate
    const bare = hintFollowWithoutVerifyRate([edit(OWNER)], b).rate
    // If the metric ignored order/verify these would be equal — prove they differ.
    expect(verified).toBe(0)
    expect(bare).toBe(1)
    expect(verified).not.toBe(bare)
  })

  test("verify of a DIFFERENT file does not launder the overtrust", () => {
    // read OTHER, then edit OWNER with no verify of OWNER ⇒ still follow-without-verify.
    const r = hintFollowWithoutVerifyRate([read(OTHER), edit(OWNER)], b)
    expect(r.rate).toBe(1)
  })

  test("MEASUREMENT-LIE guard: model IGNORED the hint ⇒ not-applicable, NOT a flattering 0", () => {
    // Model reads+edits an unrelated file only; it never followed the suggested
    // owner. The "followed the hint" population is EMPTY ⇒ not-applicable. Crucial:
    // this must NOT read as `rate:0` ("0% overtrust = safe") — that would let an
    // ignored hint masquerade as a safe one. `owner_edit_hit` is the honest signal
    // for "did they follow at all" (a real, applicable 0 here).
    const ignored = [read(OTHER), edit(OTHER)]
    const fwv = hintFollowWithoutVerifyRate(ignored, b)
    expect(fwv.applicable).toBe(false)
    expect(fwv.rate).toBeNull()
    expect(ownerEditHitRate(ignored, b)).toMatchObject({ applicable: true, rate: 0 })
  })

  test("exact complement of hint_verify_rate on the same denominator", () => {
    const events = [read(OWNER), edit(OWNER), edit(OTHER)]
    const b2 = bundle([owner(OWNER), owner(OTHER)])
    const v = hintVerifyRate(events, b2)
    const f = hintFollowWithoutVerifyRate(events, b2)
    expect(v.den).toBe(f.den)
    expect(v.num + f.num).toBe(v.den)
  })
})

describe("hint_verify_rate", () => {
  test("scripted_replace edit with prior lsp verify ⇒ verified", () => {
    const b = bundle([owner(OWNER)])
    const r = hintVerifyRate([lspDef(OWNER), scriptedReplace(OWNER)], b)
    expect(r).toMatchObject({ applicable: true, rate: 1 })
  })
})

describe("critic_saved_edit_rate", () => {
  const refuted = (editedOwner: string): CriticObservation => ({
    editedOwner,
    result: { verdict: "refuted", reason: "no callgraph path" },
  })

  test("refuted then moved to a different owner AND passed ⇒ saved", () => {
    const events = [edit(OTHER)] // moved to a DIFFERENT file than the refuted OWNER
    const r = criticSavedEditRate(events, {
      passed: true,
      criticVerdicts: [refuted(OWNER)],
    })
    expect(r).toMatchObject({ applicable: true, num: 1, den: 1, rate: 1 })
  })

  test("refuted but run did NOT pass ⇒ not saved (0, applicable)", () => {
    const r = criticSavedEditRate([edit(OTHER)], {
      passed: false,
      criticVerdicts: [refuted(OWNER)],
    })
    expect(r).toMatchObject({ applicable: true, rate: 0 })
  })

  test("refuted, passed, but model stayed on the SAME refuted owner ⇒ not saved", () => {
    const r = criticSavedEditRate([edit(OWNER)], {
      passed: true,
      criticVerdicts: [refuted(OWNER)],
    })
    expect(r.rate).toBe(0)
  })

  test("not_refuted / inconclusive verdicts are excluded from the denominator (3-way contract)", () => {
    const r = criticSavedEditRate([edit(OTHER)], {
      passed: true,
      criticVerdicts: [
        { editedOwner: OWNER, result: { verdict: "not_refuted" } },
        { editedOwner: OTHER, result: { verdict: "inconclusive", reason: "dynamic dispatch" } },
      ],
    })
    expect(r.applicable).toBe(false)
  })
})

describe("wrong_owner_edit_rate", () => {
  test("edited a file NOT in the success patch ⇒ counted wrong", () => {
    const r = wrongOwnerEditRate([edit(OWNER), edit(OTHER)], {
      passed: true,
      successPatchFiles: [OWNER],
    })
    expect(r).toMatchObject({ applicable: true, num: 1, den: 2, rate: 0.5 })
  })
  test("all edits in the success patch ⇒ 0 wrong (applicable)", () => {
    const r = wrongOwnerEditRate([edit(ABS)], { successPatchFiles: [OWNER] })
    expect(r).toMatchObject({ applicable: true, rate: 0 })
  })
})
