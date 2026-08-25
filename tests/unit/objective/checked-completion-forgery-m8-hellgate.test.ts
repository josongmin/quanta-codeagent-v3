/**
 * RFC-03 M8 (MED — restore admits forged checked completion) HELLGATE.
 *
 * BASE DEFECT: the persisted criterion schema allows `met:true` with `kind:
 * "checked"` and NO `completion`, and both decoders (`restore.ts` `toCriterion`
 * and the core store `rebuildCritCell`) set `met = raw.met === true` regardless of
 * completion presence. So a tampered / hand-edited session file could round-trip a
 * CHECKED criterion to `met:true` WITHOUT the verifier receipt (check id +
 * objective revision + source digest + verifier result) the C4 invariant requires
 * — the exact self-mark a checked (verifier-only) criterion must NEVER admit.
 *
 * FIX (fail-closed, non-heuristic — mirrors the live `applyVerifierCompletion`):
 * a CHECKED criterion is met ONLY with a valid verifier receipt that BINDS this
 * check (`checkId === check.id`) AND passed. Absent / mismatched / failed ⇒ the
 * criterion restores as the un-completed checked state (met:false). Manual
 * criteria are unaffected.
 *
 * Two decode seams (both fixed): `buildObjectiveAuthority({restoreFrom})` (the
 * session-DTO adapter) and `ObjectivePort.fromSnapshot` (the core-store rebuild).
 */

import { describe, expect, test } from "bun:test"
import { createObjectiveAuthority } from "@/objective"
import { buildObjectiveAuthority } from "@/runner/assemble/session-authorities"
import type { PersistedObjectiveSnapshot } from "@/session"

const CHECK = {
  id: "chk-1",
  kind: "command" as const,
  argv: ["pytest", "-q"],
  cwdPolicy: "thread" as const,
  timeoutMs: 30_000,
  successExitCodes: [0],
}

const verifierReceipt = (over: Record<string, unknown> = {}) => ({
  source: "verifier" as const,
  checkId: "chk-1",
  objectiveRevision: 1,
  sourceDigest: "sha256:deadbeef",
  verifierResult: { exitCode: 0, passed: true },
  verifiedAt: 1_000,
  ...over,
})

/** Build a one-thread persisted snapshot carrying a single CHECKED criterion. */
const snapshotWithChecked = (crit: {
  met: boolean
  completion?: unknown
}): PersistedObjectiveSnapshot => ({
  version: 1,
  threads: [
    {
      threadId: "t1",
      revision: 1,
      goal: "ship",
      successCriteria: [
        {
          id: "c1",
          text: "tests pass",
          met: crit.met,
          kind: "checked",
          check: CHECK,
          ...(crit.completion !== undefined ? { completion: crit.completion as never } : {}),
        },
      ],
      status: "active",
      explicitStatus: "active",
      budget: { tokensUsed: 0, turnsUsed: 0 },
      blockers: [],
      nextActions: [],
      createdAt: 0,
      updatedAt: 0,
    },
  ],
})

const critOf = (auth: ReturnType<typeof buildObjectiveAuthority>, threadId = "t1") =>
  auth.get(threadId)?.successCriteria[0]

// ── SEAM 1: buildObjectiveAuthority({restoreFrom}) — the session-DTO adapter ──
describe("M8 · restoreFrom — forged checked completion is fail-closed", () => {
  test("[1] checked met:true with NO completion ⇒ restores met:FALSE (forgery rejected)", () => {
    const auth = buildObjectiveAuthority({ restoreFrom: snapshotWithChecked({ met: true }) })
    const c = critOf(auth)
    expect(c?.kind).toBe("checked")
    expect(c?.met).toBe(false)
    expect(c?.completion).toBeUndefined()
  })

  test("[2] checked met:true with a VALID bound verifier receipt ⇒ restores met:TRUE (non-vacuous)", () => {
    const auth = buildObjectiveAuthority({
      restoreFrom: snapshotWithChecked({ met: true, completion: verifierReceipt() }),
    })
    const c = critOf(auth)
    expect(c?.met).toBe(true)
    expect(c?.completion?.source).toBe("verifier")
  })

  test("[3] checked met:true with a MISMATCHED checkId ⇒ met:FALSE (receipt does not bind)", () => {
    const auth = buildObjectiveAuthority({
      restoreFrom: snapshotWithChecked({
        met: true,
        completion: verifierReceipt({ checkId: "chk-OTHER" }),
      }),
    })
    expect(critOf(auth)?.met).toBe(false)
  })

  test("[4] checked met:true with a FAILED verifier result ⇒ met:FALSE", () => {
    const auth = buildObjectiveAuthority({
      restoreFrom: snapshotWithChecked({
        met: true,
        completion: verifierReceipt({ verifierResult: { exitCode: 1, passed: false } }),
      }),
    })
    expect(critOf(auth)?.met).toBe(false)
  })

  test("[5] MANUAL criterion met:true is unaffected (only checked is verifier-gated)", () => {
    const auth = buildObjectiveAuthority({
      restoreFrom: {
        version: 1,
        threads: [
          {
            threadId: "t1",
            revision: 1,
            goal: "ship",
            successCriteria: [{ id: "m1", text: "manual done", met: true }],
            status: "active",
            explicitStatus: "active",
            budget: { tokensUsed: 0, turnsUsed: 0 },
            blockers: [],
            nextActions: [],
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      },
    })
    const c = critOf(auth)
    expect(c?.kind).toBe("manual")
    expect(c?.met).toBe(true)
    // GOAL-02: `met` survives, but with NO trusted attestation the objective
    // does not derive `completed` (completion is a projection of trusted evidence).
    expect(c?.completion).toBeUndefined()
    expect(auth.get("t1")?.status).toBe("active")
  })
})

// ── SEAM 2: ObjectivePort.fromSnapshot — the core-store rebuildCritCell path ──
describe("M8 · fromSnapshot — core-store rebuild is fail-closed for checked met", () => {
  const forgedObjective = (completion?: unknown) => ({
    threadId: "t1",
    goal: "ship",
    successCriteria: [
      {
        kind: "checked",
        id: "c1",
        text: "tests pass",
        met: true,
        check: CHECK,
        ...(completion !== undefined ? { completion } : {}),
      },
    ],
    status: "active",
    budget: { tokensUsed: 0, turnsUsed: 0 },
    blockers: [],
    nextActions: [],
    createdAt: 0,
    updatedAt: 0,
  })

  test("[6] rebuild of a checked met:true with NO completion ⇒ met:FALSE", () => {
    const auth = createObjectiveAuthority()
    auth.fromSnapshot({ objectives: [forgedObjective()] } as never)
    expect(auth.get("t1")?.successCriteria[0]?.met).toBe(false)
  })

  test("[7] rebuild of a checked met:true with a VALID bound receipt ⇒ met:TRUE (non-vacuous)", () => {
    const auth = createObjectiveAuthority()
    auth.fromSnapshot({ objectives: [forgedObjective(verifierReceipt())] } as never)
    expect(auth.get("t1")?.successCriteria[0]?.met).toBe(true)
  })
})

// ── GOAL-01: a verifier receipt is bound to the objective GENERATION ─────────
// The check id alone is no longer enough to be well-formed: the receipt must
// name the LIVE `objectiveId`. A receipt minted against a previous generation
// (pre-`replace`) or any other id is refused `objective-mismatch` — live AND on
// the restore seam.
describe("GOAL-01 · a verifier receipt for the right check but the wrong generation is refused", () => {
  const CHECK_DECL = {
    kind: "command" as const,
    argv: ["pytest", "-q"],
    timeoutMs: 30_000,
    successExitCodes: [0],
  }

  const seedChecked = () => {
    const auth = createObjectiveAuthority({ now: () => 5 })
    auth.create("t", { goal: "guarded", criteria: [{ text: "tests pass", check: CHECK_DECL }] })
    const c = auth.get("t")?.successCriteria[0]
    return {
      auth,
      cid: c?.id ?? "",
      checkId: c?.kind === "checked" ? c.check.id : "",
      objectiveId: auth.get("t")?.objectiveId ?? "",
    }
  }

  const verify = (
    auth: ReturnType<typeof createObjectiveAuthority>,
    cid: string,
    receipt: Record<string, unknown>,
  ) =>
    auth.commit(
      auth.prepare({
        threadId: "t",
        actor: "verifier",
        mutation: {
          kind: "markCriterionVerified",
          criterionId: cid,
          receipt: receipt as never,
        },
      }),
      { admitted: true },
    )

  test("[8] LIVE: right checkId + OTHER objectiveId ⇒ objective-mismatch, criterion stays unmet", () => {
    const { auth, cid, checkId } = seedChecked()
    const res = verify(
      auth,
      cid,
      verifierReceipt({
        checkId,
        objectiveId: "some-other-objective",
        objectiveRevision: auth.readDomain("t").revision,
      }),
    )
    expect(res.ok).toBe(false)
    expect(res.ok === false ? res.reason : "").toBe("objective-mismatch")
    expect(auth.get("t")?.successCriteria[0]?.met).toBe(false)
  })

  test("[9] LIVE: a receipt from the PREVIOUS generation (pre-replace) ⇒ objective-mismatch", () => {
    const { auth, objectiveId: staleId } = seedChecked()
    // The definition is replaced: a fresh generation + fresh criterion/check ids.
    auth.replace("t", { goal: "guarded v2", criteria: [{ text: "tests pass", check: CHECK_DECL }] })
    const c = auth.get("t")?.successCriteria[0]
    const cid = c?.id ?? ""
    const checkId = c?.kind === "checked" ? c.check.id : ""
    expect(auth.get("t")?.objectiveId).not.toBe(staleId)
    const res = verify(
      auth,
      cid,
      verifierReceipt({
        checkId,
        objectiveId: staleId,
        objectiveRevision: auth.readDomain("t").revision,
      }),
    )
    expect(res.ok).toBe(false)
    expect(res.ok === false ? res.reason : "").toBe("objective-mismatch")
    expect(auth.get("t")?.successCriteria[0]?.met).toBe(false)
    // Paired control: the SAME receipt with the live id is admitted (non-vacuous).
    const ok = verify(
      auth,
      cid,
      verifierReceipt({
        checkId,
        objectiveId: auth.get("t")?.objectiveId ?? "",
        objectiveRevision: auth.readDomain("t").revision,
      }),
    )
    expect(ok.ok).toBe(true)
    expect(auth.get("t")?.successCriteria[0]?.met).toBe(true)
  })

  test("[10] RESTORE (v2): checked met:true whose receipt names ANOTHER objectiveId ⇒ met:FALSE", () => {
    const body = (completion: unknown) => ({
      version: 2 as const,
      threads: [
        {
          threadId: "t1",
          revision: 1,
          objective: {
            objectiveId: "gen-live",
            createdBy: "system",
            goal: "ship",
            successCriteria: [
              {
                id: "c1",
                text: "tests pass",
                met: true,
                kind: "checked" as const,
                check: CHECK,
                completion: completion as never,
              },
            ],
            status: "active",
            explicitStatus: "active" as const,
            budget: { tokensUsed: 0, turnsUsed: 0 },
            blockers: [],
            nextActions: [],
            createdAt: 0,
            updatedAt: 0,
          },
        },
      ],
    })
    const forged = buildObjectiveAuthority({
      restoreFrom: body(verifierReceipt({ objectiveId: "gen-stale" })),
    })
    expect(critOf(forged)?.met).toBe(false)
    expect(critOf(forged)?.completion).toBeUndefined()
    // Paired control: the live generation's receipt restores met:true.
    const genuine = buildObjectiveAuthority({
      restoreFrom: body(verifierReceipt({ objectiveId: "gen-live" })),
    })
    expect(critOf(genuine)?.met).toBe(true)
  })
})
