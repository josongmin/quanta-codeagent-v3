/**
 * RFC-03 C4 hellgate — criterion declaration / provenance (RED-first, then GREEN).
 *
 * Two base defects this packet closes (pinned RED before the C4 fix):
 *
 *   (a) VERIFIER-ONLY CHECKED TRANSITION is absent. A criterion the caller
 *       declares as machine-CHECKED can today be marked met through a plain model
 *       update with NO verifier evidence. The fix: a checked criterion may become
 *       met ONLY via a verifier receipt; a model/tool `markCriterion(met:true)`
 *       is refused structurally, INDEPENDENT of the propose gate.
 *
 *   (b) COMPLETION PROVENANCE does not survive restart. A completed manual OR
 *       checked criterion carries no persisted receipt (source / actor / check id
 *       / objective revision / source digest / verifier result), so after a real
 *       save→reopen the "how was this completed" evidence is gone.
 *
 * Plus the C4 stop-rule rails: no placeholder verifier receipt is mintable from a
 * model/tool payload; the declared CheckSpec is immutable after creation; the
 * execution port is a typed-but-UNSUPPORTED seam; the decoder is exhaustive over
 * the manual/checked union.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createObjectiveAuthority,
  createVerifierCompletion,
  type ObjectiveAuthority,
  unsupportedCheckExecutionPort,
} from "@/objective"
import {
  buildObjectiveAuthority,
  encodeObjectiveSnapshot,
} from "@/runner/assemble/session-authorities"
import { loadSessionById, type SessionMeta, saveSessionById } from "@/session"
import { __resetRuntimeConfig } from "@/shared"

const CHECK = {
  kind: "command",
  argv: ["bun", "test"],
  timeoutMs: 1_000,
  successExitCodes: [0],
} as const

/** Seed a thread with one CHECKED criterion; return the authority + criterion id. */
const seedChecked = (
  opts?: Parameters<typeof createObjectiveAuthority>[0],
): { auth: ObjectiveAuthority; cid: string } => {
  const auth = createObjectiveAuthority(opts ?? {}) as ObjectiveAuthority
  auth.commit(
    auth.prepare({
      threadId: "t",
      actor: "system",
      mutation: {
        kind: "create",
        definition: { goal: "g", criteria: [{ text: "tests pass", check: CHECK }] },
      },
    }),
    { admitted: true },
  )
  const cid = auth.get("t")?.successCriteria[0]?.id ?? ""
  return { auth, cid }
}

describe("C4 (a) — a checked criterion is verifier-only (model cannot self-mark)", () => {
  test("declared criterion is CHECKED and carries an immutable check spec", () => {
    const { auth, cid } = seedChecked()
    const c = auth.get("t")?.successCriteria[0]
    expect(cid).not.toBe("")
    expect(c?.kind).toBe("checked")
    expect(c?.kind === "checked" ? c.check.argv : []).toEqual(["bun", "test"])
    // domain-minted identity + fixed cwd policy (NOT model-supplied).
    expect(c?.kind === "checked" ? typeof c.check.id : "").toBe("string")
    expect(c?.kind === "checked" ? c.check.cwdPolicy : "").toBe("thread")
  })

  test("RED→GREEN: a MODEL markCriterion(met:true) on a checked criterion is REFUSED", () => {
    const { auth, cid } = seedChecked()
    const res = auth.commit(
      auth.prepare({
        threadId: "t",
        actor: "model",
        mutation: { kind: "markCriterion", criterionId: cid, met: true },
      }),
      { admitted: true },
    )
    expect(res.ok).toBe(false)
    // GOAL-02: the policy table refuses a model markCriterion BEFORE the
    // structural checked-only guard runs, so the code is the actor's
    // `manual-attestation-required` (the checked guard still answers for the
    // actors the table admits — see the next case).
    expect(res.ok === false ? res.reason : "").toBe("manual-attestation-required")
    // the criterion stays NOT met — no self-completion leaked through.
    expect(auth.get("t")?.successCriteria[0]?.met).toBe(false)
  })

  test("even a SYSTEM/user/continuation markCriterion cannot complete a checked criterion", () => {
    // GOAL-02: user/system pass the policy and hit the STRUCTURAL guard
    // (`checked-verifier-only`); continuation is refused by the table first.
    const expected = {
      system: "checked-verifier-only",
      user: "checked-verifier-only",
      continuation: "manual-attestation-required",
    } as const
    for (const actor of ["system", "continuation", "user"] as const) {
      const { auth, cid } = seedChecked()
      const res = auth.commit(
        auth.prepare({
          threadId: "t",
          actor,
          mutation: { kind: "markCriterion", criterionId: cid, met: true },
        }),
        { admitted: true },
      )
      expect(res.ok).toBe(false)
      expect(res.ok === false ? res.reason : "").toBe(expected[actor])
      expect(auth.get("t")?.successCriteria[0]?.met).toBe(false)
    }
  })

  test("a VERIFIER receipt (passing) completes the checked criterion", () => {
    const { auth, cid } = seedChecked({ now: () => 777 })
    const verifier = createVerifierCompletion(auth, { now: () => 777 })
    const checkId = (() => {
      const c = auth.get("t")?.successCriteria[0]
      return c?.kind === "checked" ? c.check.id : ""
    })()
    const res = verifier.complete({
      threadId: "t",
      criterionId: cid,
      checkId,
      sourceDigest: "sha256:abc",
      result: { exitCode: 0, passed: true },
    })
    expect(res.ok).toBe(true)
    const c = auth.get("t")?.successCriteria[0]
    expect(c?.met).toBe(true)
    // provenance carries check id + objective revision + source digest + result.
    const completion = c?.completion
    expect(completion?.source).toBe("verifier")
    expect(completion?.source === "verifier" ? completion.checkId : "").toBe(checkId)
    expect(completion?.source === "verifier" ? completion.sourceDigest : "").toBe("sha256:abc")
    expect(completion?.source === "verifier" ? completion.verifierResult.passed : false).toBe(true)
    expect(typeof completion?.objectiveRevision).toBe("number")
  })

  test("a NON-passing verifier result does NOT complete the criterion (abstain, not auto-complete)", () => {
    const { auth, cid } = seedChecked()
    const verifier = createVerifierCompletion(auth)
    const checkId = (() => {
      const c = auth.get("t")?.successCriteria[0]
      return c?.kind === "checked" ? c.check.id : ""
    })()
    const res = verifier.complete({
      threadId: "t",
      criterionId: cid,
      checkId,
      sourceDigest: "sha256:zzz",
      result: { exitCode: 1, passed: false },
    })
    expect(res.ok).toBe(false)
    expect(auth.get("t")?.successCriteria[0]?.met).toBe(false)
  })

  test("STOP-RULE: a receipt for a DIFFERENT check id cannot complete the criterion (no forgery)", () => {
    const { auth, cid } = seedChecked()
    const verifier = createVerifierCompletion(auth)
    const res = verifier.complete({
      threadId: "t",
      criterionId: cid,
      checkId: "forged-check-id",
      sourceDigest: "sha256:abc",
      result: { exitCode: 0, passed: true },
    })
    expect(res.ok).toBe(false)
    expect(auth.get("t")?.successCriteria[0]?.met).toBe(false)
  })
})

describe("C4 — manual criteria keep explicit completion with provenance", () => {
  // GOAL-02 (REVERSED): this used to prove the MODEL can mark a manual criterion
  // met (carrying a `model`-attested receipt). Manual attestation is now
  // user/system-only; the model is refused `manual-attestation-required` and no
  // receipt is minted. The USER mark is the paired control and carries the
  // authority-minted receipt with the bound actor.
  test("a manual criterion can NOT be marked met by the model; a USER mark carries a manual receipt", () => {
    const auth = createObjectiveAuthority({ now: () => 42 }) as ObjectiveAuthority
    auth.commit(
      auth.prepare({
        threadId: "t",
        actor: "system",
        mutation: { kind: "create", definition: { goal: "g", successCriteria: ["do the thing"] } },
      }),
      { admitted: true },
    )
    const cid = auth.get("t")?.successCriteria[0]?.id ?? ""
    const denied = auth.commit(
      auth.prepare({
        threadId: "t",
        actor: "model",
        mutation: { kind: "markCriterion", criterionId: cid, met: true },
      }),
      { admitted: true },
    )
    expect(denied.ok).toBe(false)
    expect(denied.ok === false ? denied.reason : "").toBe("manual-attestation-required")
    expect(auth.get("t")?.successCriteria[0]?.met).toBe(false)
    expect(auth.get("t")?.successCriteria[0]?.completion).toBeUndefined()

    const res = auth.commit(
      auth.prepare({
        threadId: "t",
        actor: "user",
        mutation: { kind: "markCriterion", criterionId: cid, met: true },
      }),
      { admitted: true },
    )
    expect(res.ok).toBe(true)
    const c = auth.get("t")?.successCriteria[0]
    expect(c?.kind).toBe("manual")
    expect(c?.met).toBe(true)
    expect(c?.completion?.source).toBe("manual")
    expect(c?.completion?.source === "manual" ? c.completion.actor : "").toBe("user")
    expect(c?.completion?.objectiveId).toBe(auth.get("t")?.objectiveId ?? "")
    expect(c?.completion?.verifiedAt).toBe(42)
    expect(auth.get("t")?.status).toBe("completed")
  })

  test("unmarking a manual criterion clears its completion receipt", () => {
    const auth = createObjectiveAuthority({}) as ObjectiveAuthority
    auth.create("t", { goal: "g", successCriteria: ["x"] })
    const cid = auth.get("t")?.successCriteria[0]?.id ?? ""
    auth.markCriterion("t", cid, true)
    expect(auth.get("t")?.successCriteria[0]?.completion).toBeDefined()
    auth.markCriterion("t", cid, false)
    expect(auth.get("t")?.successCriteria[0]?.completion).toBeUndefined()
  })
})

describe("C4 (b) — completion provenance + check spec survive a real save→reopen", () => {
  let dir: string
  let env: NodeJS.ProcessEnv
  const mkMeta = (id: string): SessionMeta => ({
    id,
    title: id,
    cwd: "/tmp/w",
    createdAt: 1,
    lastTouched: 1,
    archived: false,
  })

  beforeEach(() => {
    env = { ...process.env }
    dir = mkdtempSync(join(tmpdir(), "c4-persist-"))
    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]
    Object.assign(process.env, env)
    __resetRuntimeConfig()
  })

  /** Seed a thread with a completed manual + a verifier-completed checked
   *  criterion; return the live authority + the checked criterion's check id. */
  const seedCompleted = (): { auth: ObjectiveAuthority; checkId: string } => {
    const auth = buildObjectiveAuthority({ now: () => 500 }) as unknown as ObjectiveAuthority
    auth.commit(
      auth.prepare({
        threadId: "thr",
        actor: "system",
        mutation: {
          kind: "create",
          definition: {
            goal: "ship",
            criteria: [{ text: "manual step" }, { text: "tests pass", check: CHECK }],
          },
        },
      }),
      { admitted: true },
    )
    const manualId = auth.get("thr")?.successCriteria[0]?.id ?? ""
    auth.markCriterion("thr", manualId, true) // system-attested (port surface) manual completion
    const checked = auth.get("thr")?.successCriteria[1]
    const checkId = checked?.kind === "checked" ? checked.check.id : ""
    createVerifierCompletion(auth, { now: () => 500 }).complete({
      threadId: "thr",
      criterionId: checked?.id ?? "",
      checkId,
      sourceDigest: "sha256:deadbeef",
      result: { exitCode: 0, passed: true },
    })
    return { auth, checkId }
  }

  test("checked check spec + verifier receipt round-trip byte-equivalently", async () => {
    const { auth, checkId } = seedCompleted()
    const snapshot = encodeObjectiveSnapshot(auth)
    await saveSessionById(mkMeta("s"), { reason: "x", turns: 1, messages: [], objective: snapshot })
    const reopened = await loadSessionById("s")
    // zod decoder does NOT strip the new provenance keys.
    expect(reopened?.objective).toEqual(snapshot)

    const fresh = buildObjectiveAuthority({
      now: () => 9_000,
      restoreFrom: reopened?.objective,
    }) as unknown as ObjectiveAuthority
    const rChecked = fresh.get("thr")?.successCriteria[1]
    expect(rChecked?.kind).toBe("checked")
    expect(rChecked?.kind === "checked" ? rChecked.check.id : "").toBe(checkId)
    expect(rChecked?.met).toBe(true)
    const comp = rChecked?.completion
    expect(comp?.source === "verifier" ? comp.sourceDigest : "").toBe("sha256:deadbeef")
    expect(comp?.source === "verifier" ? comp.checkId : "").toBe(checkId)
    // manual provenance also survives.
    expect(fresh.get("thr")?.successCriteria[0]?.completion?.source).toBe("manual")
    // byte-equivalent re-encode.
    expect(encodeObjectiveSnapshot(fresh)).toEqual(snapshot)
  })
})

describe("C4 adversarial — no forged/placeholder receipt can complete a checked criterion", () => {
  test("a MODEL actor cannot drive the verifier-only mutation (actor gate)", () => {
    const { auth, cid } = seedChecked()
    const c = auth.get("t")?.successCriteria[0]
    const checkId = c?.kind === "checked" ? c.check.id : ""
    // Simulate a compromised call path handing the receipt with actor:"model".
    const res = auth.commit(
      auth.prepare({
        threadId: "t",
        actor: "model",
        mutation: {
          kind: "markCriterionVerified",
          criterionId: cid,
          receipt: {
            source: "verifier",
            objectiveId: auth.get("t")?.objectiveId ?? "",
            checkId,
            objectiveRevision: auth.readDomain("t").revision,
            sourceDigest: "sha256:abc",
            verifierResult: { exitCode: 0, passed: true },
            verifiedAt: 1,
          },
        },
      }),
      { admitted: true },
    )
    expect(res.ok).toBe(false)
    // GOAL-02: `markCriterionVerified` is verifier-only in the policy table —
    // every other actor is `actor-forbidden` (was `forbidden-completion`).
    expect(res.ok === false ? res.reason : "").toBe("actor-forbidden")
    expect(auth.get("t")?.successCriteria[0]?.met).toBe(false)
  })

  test("a verifier receipt with an EMPTY source digest is refused (receipt completeness)", () => {
    const { auth, cid } = seedChecked()
    const verifier = createVerifierCompletion(auth)
    const c = auth.get("t")?.successCriteria[0]
    const checkId = c?.kind === "checked" ? c.check.id : ""
    const res = verifier.complete({
      threadId: "t",
      criterionId: cid,
      checkId,
      sourceDigest: "", // missing evidence
      result: { exitCode: 0, passed: true },
    })
    expect(res.ok).toBe(false)
    expect(auth.get("t")?.successCriteria[0]?.met).toBe(false)
  })

  test("a STALE revision receipt is refused (revision is CAS-bound)", () => {
    const { auth, cid } = seedChecked()
    const c = auth.get("t")?.successCriteria[0]
    const checkId = c?.kind === "checked" ? c.check.id : ""
    const res = auth.commit(
      auth.prepare({
        threadId: "t",
        actor: "verifier",
        mutation: {
          kind: "markCriterionVerified",
          criterionId: cid,
          receipt: {
            source: "verifier",
            objectiveId: auth.get("t")?.objectiveId ?? "",
            checkId,
            objectiveRevision: 999, // does not match current
            sourceDigest: "sha256:abc",
            verifierResult: { exitCode: 0, passed: true },
            verifiedAt: 1,
          },
        },
      }),
      { admitted: true },
    )
    expect(res.ok).toBe(false)
    expect(auth.get("t")?.successCriteria[0]?.met).toBe(false)
  })

  test("even the RAW store cannot complete a checked criterion via markCriterion", async () => {
    const { createObjectiveStore } = await import("@/objective")
    const store = createObjectiveStore()
    store.create("t", {
      goal: "g",
      criteria: [{ text: "tests", check: CHECK }],
    })
    const cid = store.get("t")?.successCriteria[0]?.id ?? ""
    store.markCriterion("t", cid, true)
    expect(store.get("t")?.successCriteria[0]?.met).toBe(false)
  })
})

describe("C4 adversarial — decoder is exhaustive + migration-safe", () => {
  /** A v1 (pre-GOAL-01) persisted thread with ONE legacy manual criterion. */
  const legacyThread = (criterion: Record<string, unknown>) => ({
    version: 1 as const,
    threads: [
      {
        threadId: "t",
        revision: 1,
        goal: "g",
        successCriteria: [criterion as never],
        status: "active",
        explicitStatus: "active" as const,
        budget: { tokensUsed: 0, turnsUsed: 0 },
        blockers: [],
        nextActions: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  })

  // GOAL-02 (REVERSED): a legacy manual criterion used to "stay
  // model-completable". Manual attestation is user/system-only now — the model
  // is refused; the USER completes it (paired control).
  test("a LEGACY criterion (no kind) decodes as MANUAL; the model may not complete it, the user may", () => {
    const auth = buildObjectiveAuthority({
      restoreFrom: legacyThread({ id: "c1", text: "legacy", met: false }),
    }) as unknown as ObjectiveAuthority
    const c = auth.get("t")?.successCriteria[0]
    expect(c?.kind).toBe("manual")
    const denied = auth.commit(
      auth.prepare({
        threadId: "t",
        actor: "model",
        mutation: { kind: "markCriterion", criterionId: "c1", met: true },
      }),
      { admitted: true },
    )
    expect(denied.ok).toBe(false)
    expect(denied.ok === false ? denied.reason : "").toBe("manual-attestation-required")
    expect(auth.get("t")?.successCriteria[0]?.met).toBe(false)
    const res = auth.commit(
      auth.prepare({
        threadId: "t",
        actor: "user",
        mutation: { kind: "markCriterion", criterionId: "c1", met: true },
      }),
      { admitted: true },
    )
    expect(res.ok).toBe(true)
    expect(auth.get("t")?.successCriteria[0]?.met).toBe(true)
    expect(auth.get("t")?.status).toBe("completed")
  })

  // GOAL-02: COMPLETION is a projection of TRUSTED evidence only. A legacy
  // manual criterion "completed by the model" (a v1 receipt attested by
  // `model`) decodes with `met:true` and keeps its receipt, but the status does
  // NOT derive `completed`. The SAME receipt attested by `user` does.
  test("a LEGACY manual criterion with a MODEL-attested receipt is met but INERT for completion; a USER receipt completes", () => {
    const withActor = (actor: string) =>
      buildObjectiveAuthority({
        restoreFrom: legacyThread({
          id: "c1",
          text: "legacy",
          met: true,
          completion: { source: "manual", actor, objectiveRevision: 1, verifiedAt: 1 },
        }),
      }) as unknown as ObjectiveAuthority

    const untrusted = withActor("model")
    const c = untrusted.get("t")?.successCriteria[0]
    expect(c?.kind).toBe("manual")
    expect(c?.met).toBe(true)
    expect(c?.completion?.source === "manual" ? c.completion.actor : "").toBe("model")
    // the migrated receipt is bound to the migrated generation…
    expect(c?.completion?.objectiveId).toBe(untrusted.get("t")?.objectiveId ?? "")
    // …yet the objective is NOT completed: the evidence is untrusted.
    expect(untrusted.get("t")?.status).toBe("active")
    expect(untrusted.readDomain("t").validationContract).toBe("manual-only")

    const trusted = withActor("user")
    expect(trusted.get("t")?.successCriteria[0]?.met).toBe(true)
    expect(trusted.get("t")?.status).toBe("completed")
  })

  test("a checked criterion with an UNRECOVERABLE check downgrades to manual (fail-safe)", () => {
    const bad = {
      version: 1,
      threads: [
        {
          threadId: "t",
          revision: 1,
          goal: "g",
          // kind says checked but the check is malformed (no id / no argv).
          successCriteria: [
            { id: "c1", text: "x", met: false, kind: "checked", check: { kind: "command" } },
          ],
          status: "active",
          explicitStatus: "active" as const,
          budget: { tokensUsed: 0, turnsUsed: 0 },
          blockers: [],
          nextActions: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    } as unknown as NonNullable<Parameters<typeof buildObjectiveAuthority>[0]>["restoreFrom"]
    const auth = buildObjectiveAuthority({ restoreFrom: bad }) as unknown as ObjectiveAuthority
    expect(auth.get("t")?.successCriteria[0]?.kind).toBe("manual")
  })
})

describe("C4 — CheckSpec immutability + unsupported execution seam", () => {
  test("the stored CheckSpec (and its argv) is frozen (immutable after creation)", () => {
    const { auth } = seedChecked()
    const c = auth.get("t")?.successCriteria[0]
    const spec = c?.kind === "checked" ? c.check : null
    expect(spec).not.toBeNull()
    expect(Object.isFrozen(spec)).toBe(true)
    expect(Object.isFrozen(spec?.argv)).toBe(true)
    // a mutation attempt on the frozen argv does not take effect.
    expect(() => {
      ;(spec?.argv as string[]).push("rm")
    }).toThrow()
  })

  test("re-declaring via a fresh replace does NOT mutate a prior check in place (new id)", () => {
    const { auth } = seedChecked()
    const before = auth.get("t")?.successCriteria[0]
    const beforeId = before?.kind === "checked" ? before.check.id : ""
    const beforeObjectiveId = auth.get("t")?.objectiveId
    // GOAL-01: `replace` is the explicit overwrite — a fresh generation id too.
    auth.replace("t", { goal: "g2", criteria: [{ text: "again", check: CHECK }] })
    expect(auth.get("t")?.objectiveId).not.toBe(beforeObjectiveId)
    const after = auth.get("t")?.successCriteria[0]
    const afterId = after?.kind === "checked" ? after.check.id : ""
    expect(afterId).not.toBe("")
    expect(afterId).not.toBe(beforeId) // a fresh criterion, not an in-place edit
  })

  test("the execution port is a typed-but-UNSUPPORTED seam (C5 PARKED)", async () => {
    await expect(
      unsupportedCheckExecutionPort.execute(
        {
          id: "x",
          kind: "command",
          argv: [],
          cwdPolicy: "thread",
          timeoutMs: 1,
          successExitCodes: [0],
        },
        { threadId: "t", sourceDigest: "d" },
      ),
    ).rejects.toThrow()
  })
})
