/**
 * Hellgate: BENCH RUN-HEALTH detector + early systemic-abort gate.
 *
 * Real pain (jun-25/26 full-remote): runs burned 20–40min and produced 0/N
 * because of SYSTEMIC failures the loop never detected early — every instance
 * died turns=0 with `ChatGPT-OAuth: not signed in` (dead token) yet all 6–7
 * instances were still attempted. This detector classifies each finished
 * instance and ABORTS FAST when the run is systemically broken, while staying
 * byte-identical (no abort) for a healthy run where the model is generating.
 *
 * Invariants under test:
 *   1. `classifyInstanceHealth` maps each representative result shape to the
 *      right category (auth vs infra vs real-attempt vs empty-stall vs graded).
 *   2. `shouldAbortRun` fires on systemic_auth (ONE on instance #1) and on
 *      systemic_infra×K, NEVER on graded_fail / model_attempt (healthy misses).
 *   3. Loop integration: a systemic_auth first instance STOPS the loop (remaining
 *      instances NOT attempted) and surfaces a runHealth verdict; a healthy run
 *      attempts ALL instances with runHealth="healthy".
 *   4. Red-on-injection: disabling the gate makes the SAME systemic run attempt
 *      ALL N instances — proving the gate is what stops it.
 */
import { describe, expect, test } from "bun:test"
import { buildReport } from "../../src/runner/batch/report"
import {
  classifyInstanceHealth,
  type InstanceHealth,
  runBatchWithHealth,
  shouldAbortRun,
} from "../../src/runner/batch/eval/run-health"
import type { Instance, InstanceResult } from "../../src/runner/batch/types"

// Minimal valid InstanceResult; override per-case.
const res = (over: Partial<InstanceResult>): InstanceResult => ({
  id: over.id ?? "x__1",
  passed: false,
  patch: "",
  turns: 0,
  ...over,
})

describe("classifyInstanceHealth", () => {
  test("not-signed-in error ⇒ systemic_auth", () => {
    const r = res({
      turns: 0,
      error:
        "ChatGPT-OAuth: not signed in — run `quanta /login --chatgpt`, or sign in to Codex first.",
    })
    expect(classifyInstanceHealth(r)).toBe("systemic_auth")
  })

  test("token refresh 401 / invalid_grant ⇒ systemic_auth", () => {
    expect(
      classifyInstanceHealth(
        res({ turns: 0, error: "ChatGPT-OAuth token refresh failed: invalid_grant (401)." }),
      ),
    ).toBe("systemic_auth")
    expect(
      classifyInstanceHealth(res({ turns: 0, error: "request failed: 401 Unauthorized" })),
    ).toBe("systemic_auth")
  })

  test("box-loss / ssh-255 / exit 137 (OOM) / readiness ⇒ systemic_infra", () => {
    expect(classifyInstanceHealth(res({ error: "box loss (spot reclaim / ssh-255)" }))).toBe(
      "systemic_infra",
    )
    expect(classifyInstanceHealth(res({ error: "process killed: exit 137 (OOM)" }))).toBe(
      "systemic_infra",
    )
    expect(
      classifyInstanceHealth(res({ error: "ssh not ready on 1.2.3.4 after 60 attempts" })),
    ).toBe("systemic_infra")
  })

  test("auth takes precedence over an incidental infra-looking word in the same error", () => {
    // An auth error string that also happens to mention a status code must NOT be
    // mis-bucketed as infra — auth is the systemic root.
    expect(
      classifyInstanceHealth(res({ error: "ChatGPT-OAuth: not signed in (token invalidated)" })),
    ).toBe("systemic_auth")
  })

  test("turns>0 with a patch, graded pass ⇒ graded_pass", () => {
    expect(
      classifyInstanceHealth(res({ turns: 5, patch: "diff --git a b\n+x", passed: true })),
    ).toBe("graded_pass")
  })

  test("turns>0 with a patch, graded fail ⇒ graded_fail (HEALTHY miss)", () => {
    expect(
      classifyInstanceHealth(
        res({
          turns: 8,
          patch: "diff --git a b\n+x",
          passed: false,
          gradeBreakdown: { resolved: false, failToPassFailed: 1, passToPassFailed: 0, passToPassTotal: 3 },
        }),
      ),
    ).toBe("graded_fail")
  })

  test("turns>0 with a patch but no grading signal ⇒ model_attempt (HEALTHY)", () => {
    // patch-gen happened (real generation) but the instance was never graded —
    // still healthy: the scaffold IS working, the model produced output.
    expect(
      classifyInstanceHealth(res({ turns: 6, patch: "diff --git a b\n+x", passed: false })),
    ).toBe("model_attempt")
  })

  test("turns=0, no error ⇒ empty_or_stall", () => {
    expect(classifyInstanceHealth(res({ turns: 0, patch: "", passed: false }))).toBe(
      "empty_or_stall",
    )
  })

  test("turns>0 but empty patch, no error, not passed ⇒ empty_or_stall (no real attempt)", () => {
    // Ran some turns but produced NOTHING and was not graded-pass — a stall, not
    // a real generation attempt.
    expect(classifyInstanceHealth(res({ turns: 3, patch: "", passed: false }))).toBe(
      "empty_or_stall",
    )
  })
})

describe("shouldAbortRun — systemic early-abort gate", () => {
  const decide = (cats: InstanceHealth[]) => shouldAbortRun(cats)

  test("ONE systemic_auth on instance #1 ⇒ ABORT (auth is all-or-nothing)", () => {
    const d = decide(["systemic_auth"])
    expect(d.abort).toBe(true)
    expect(d.category).toBe("systemic_auth")
    expect(d.reason.toLowerCase()).toContain("auth")
  })

  test("systemic_infra×2 ⇒ ABORT", () => {
    const d = decide(["systemic_infra", "systemic_infra"])
    expect(d.abort).toBe(true)
    expect(d.category).toBe("systemic_infra")
  })

  test("a SINGLE systemic_infra ⇒ do NOT abort yet (could be one flaky box)", () => {
    expect(decide(["systemic_infra"]).abort).toBe(false)
  })

  test("[graded_fail, graded_fail] ⇒ do NOT abort (healthy misses)", () => {
    expect(decide(["graded_fail", "graded_fail"]).abort).toBe(false)
  })

  test("[model_attempt] ⇒ do NOT abort (healthy generation)", () => {
    expect(decide(["model_attempt"]).abort).toBe(false)
  })

  test("mixed: one systemic_infra + one graded_fail ⇒ do NOT abort (not ALL systemic)", () => {
    expect(decide(["systemic_infra", "graded_fail"]).abort).toBe(false)
  })

  test("an empty_or_stall alone does NOT abort (not a hard systemic signal)", () => {
    expect(decide(["empty_or_stall"]).abort).toBe(false)
    expect(decide(["empty_or_stall", "empty_or_stall"]).abort).toBe(false)
  })

  test("ALL infra after K instances aborts; a later non-systemic in the window blocks it", () => {
    expect(decide(["systemic_infra", "systemic_infra", "systemic_infra"]).abort).toBe(true)
    expect(decide(["systemic_infra", "model_attempt", "systemic_infra"]).abort).toBe(false)
  })
})

describe("runBatchWithHealth — loop integration", () => {
  const inst = (id: string): Instance => ({
    id,
    repoPath: "/tmp/x",
    problemStatement: "fix it",
    testCmd: "true",
  })

  test("systemic_auth on instance #1 STOPS the loop — remaining NOT attempted", async () => {
    const instances = [inst("a__1"), inst("b__2"), inst("c__3"), inst("d__4")]
    const attempted: string[] = []
    const out = await runBatchWithHealth({
      instances,
      env: {}, // gate default-ON
      runInstance: async (i) => {
        attempted.push(i.id)
        return res({
          id: i.id,
          turns: 0,
          error: "ChatGPT-OAuth: not signed in — run `quanta /login --chatgpt`.",
        })
      },
    })
    // Only the FIRST instance was attempted before the abort fired.
    expect(attempted).toEqual(["a__1"])
    expect(out.results.length).toBe(1)
    expect(out.runHealth.aborted).toBe(true)
    expect(out.runHealth.verdict).toBe("systemic_auth")
    expect(out.runHealth.reason.toLowerCase()).toContain("auth")
    expect(out.runHealth.attempted).toBe(1)
    expect(out.runHealth.total).toBe(4)
  })

  test("healthy run attempts ALL instances, runHealth='healthy', no abort", async () => {
    const instances = [inst("a__1"), inst("b__2"), inst("c__3")]
    const attempted: string[] = []
    const out = await runBatchWithHealth({
      instances,
      env: {},
      runInstance: async (i) => {
        attempted.push(i.id)
        return res({ id: i.id, turns: 5, patch: "diff --git a b\n+x", passed: i.id === "c__3" })
      },
    })
    expect(attempted).toEqual(["a__1", "b__2", "c__3"])
    expect(out.results.length).toBe(3)
    expect(out.runHealth.aborted).toBe(false)
    expect(out.runHealth.verdict).toBe("healthy")
  })

  test("RED-ON-INJECTION: gate disabled ⇒ systemic run attempts ALL N", async () => {
    const instances = [inst("a__1"), inst("b__2"), inst("c__3"), inst("d__4")]
    const attempted: string[] = []
    const out = await runBatchWithHealth({
      instances,
      env: { QUANTA_BENCH_HEALTH_ABORT: "0" }, // operator forces full run
      runInstance: async (i) => {
        attempted.push(i.id)
        return res({
          id: i.id,
          turns: 0,
          error: "ChatGPT-OAuth: not signed in",
        })
      },
    })
    // Gate OFF ⇒ every instance attempted despite the systemic auth failure.
    expect(attempted).toEqual(["a__1", "b__2", "c__3", "d__4"])
    expect(out.results.length).toBe(4)
    expect(out.runHealth.aborted).toBe(false)
    // The verdict still REPORTS the diagnosis even though it did not abort.
    expect(out.runHealth.verdict).toBe("systemic_auth")
  })

  test("graded_fail run is HEALTHY-by-miss: all attempted, no abort", async () => {
    const instances = [inst("a__1"), inst("b__2")]
    const attempted: string[] = []
    const out = await runBatchWithHealth({
      instances,
      env: {},
      runInstance: async (i) => {
        attempted.push(i.id)
        return res({
          id: i.id,
          turns: 7,
          patch: "diff --git a b\n+x",
          passed: false,
          gradeBreakdown: { resolved: false, failToPassFailed: 1, passToPassFailed: 0, passToPassTotal: 3 },
        })
      },
    })
    expect(attempted).toEqual(["a__1", "b__2"])
    expect(out.runHealth.aborted).toBe(false)
    expect(out.runHealth.verdict).toBe("healthy")
  })

  test("first instance HEALTHY then box dies — single infra does NOT abort", async () => {
    const instances = [inst("a__1"), inst("b__2"), inst("c__3")]
    const attempted: string[] = []
    const out = await runBatchWithHealth({
      instances,
      env: {},
      runInstance: async (i) => {
        attempted.push(i.id)
        if (i.id === "b__2") return res({ id: i.id, error: "box loss (ssh-255)" })
        return res({ id: i.id, turns: 5, patch: "diff --git a b\n+x" })
      },
    })
    // model_attempt #1 proves health; one flaky infra in the middle is tolerated.
    expect(attempted).toEqual(["a__1", "b__2", "c__3"])
    expect(out.runHealth.aborted).toBe(false)
    expect(out.runHealth.verdict).toBe("healthy")
  })
})

describe("buildReport — runHealth field is byte-identical-for-healthy", () => {
  const meta = { model: "m", provider: "p", n: 1 }
  const okResult = res({ id: "a__1", turns: 5, patch: "diff --git a b\n+x", passed: true })

  test("no runHealth supplied ⇒ field ABSENT (byte-identical legacy report)", () => {
    const report = buildReport(meta, [okResult])
    expect("runHealth" in report).toBe(false)
  })

  test("healthy verdict supplied ⇒ field OMITTED (normal run unchanged)", () => {
    const report = buildReport(
      { ...meta, runHealth: { aborted: false, verdict: "healthy", reason: "", attempted: 1, total: 1 } },
      [okResult],
    )
    expect("runHealth" in report).toBe(false)
  })

  test("aborted verdict supplied ⇒ field PRESENT with the diagnosis", () => {
    const report = buildReport(
      {
        ...meta,
        runHealth: {
          aborted: true,
          verdict: "systemic_auth",
          reason: "dead token",
          attempted: 1,
          total: 6,
        },
      },
      [res({ id: "a__1", error: "ChatGPT-OAuth: not signed in" })],
    )
    expect(report.runHealth).toEqual({
      aborted: true,
      verdict: "systemic_auth",
      reason: "dead token",
      attempted: 1,
      total: 6,
    })
  })

  test("non-healthy diagnosis WITHOUT abort (gate disabled) ⇒ field PRESENT", () => {
    const report = buildReport(
      {
        ...meta,
        runHealth: {
          aborted: false,
          verdict: "systemic_auth",
          reason: "",
          attempted: 6,
          total: 6,
        },
      },
      [res({ id: "a__1", error: "ChatGPT-OAuth: not signed in" })],
    )
    expect(report.runHealth?.verdict).toBe("systemic_auth")
    expect(report.runHealth?.aborted).toBe(false)
  })
})
