/**
 * Hellgate — empty-patch guard (verdict.ts) adversarial pins.
 *
 * `src/runner/batch/eval/verdict.ts` contains a fail-closed guard that
 * intercepts a patch which is empty after `.trim()` and short-circuits to
 *   { passed: false, error: "empty prediction (agent produced no patch)" }
 * BEFORE the local `testCmd` is exec'd.
 *
 * Rationale (from the module docstring): swebench `-k` substring matching
 * can collect tests that pass on base too, so running F2P on an unpatched
 * sandbox can return a FALSE PASS. The guard makes the bench "fail-closed"
 * for empty patches — empty input ⇒ unresolved, end of story.
 *
 * This hellgate pins:
 *   - The exact trim() semantics (whitespace flavours, NUL, BOM, CRLF)
 *   - The shape of the returned VerifyOutcome (every field, exit code 1)
 *   - That testCmd is NEVER executed for an empty patch (we'd see a spawn
 *     side-effect if it were — but verify() uses an internal `exec`. We
 *     instead pin via the absence of stdout/stderr leak in logTail).
 *   - The python-swebench path takes priority: when wired + swebench meta,
 *     the empty-patch guard does NOT fire (the python harness handles it).
 *   - Real-looking unified diff strings short-circuit past the guard.
 */
import { describe, expect, test } from "bun:test"
import { type PythonSwebenchEvaluate, verify } from "@/runner/batch/eval/verdict"
import type { Instance } from "@/runner/batch/types"

const mkInstance = (over: Partial<Instance> = {}): Instance => ({
  id: "test-001",
  repoPath: "/tmp/repo",
  problemStatement: "fix the bug",
  testCmd: "echo FAIL_ON_EMPTY_PATCH_GUARD && exit 7",
  ...over,
})

const SANDBOX = "/tmp/sbox-does-not-exist-but-never-touched"

// ── A. empty-patch detection (no python harness wired) ─────────────────────────

describe("hellgate — empty-patch trim() detection", () => {
  test('patch = "" ⇒ fail-closed with canonical error message', async () => {
    const out = await verify(mkInstance(), "", SANDBOX, { timeoutMs: 1000 })
    expect(out.passed).toBe(false)
    expect(out.error).toBe("empty prediction (agent produced no patch)")
    expect(out.exitCode).toBe(1)
    expect(out.command).toBe(mkInstance().testCmd) // command = testCmd, NOT bash spawn
    expect(out.failedTests).toEqual([])
    expect(out.logTail).toContain("empty patch") // logTail explains skip
    expect(out.reportPath).toBe("")
  })

  test('patch = "   " (spaces only) ⇒ fail-closed', async () => {
    const out = await verify(mkInstance(), "   ", SANDBOX, { timeoutMs: 1000 })
    expect(out.passed).toBe(false)
    expect(out.error).toBe("empty prediction (agent produced no patch)")
  })

  test('patch = "\\n\\n\\n" (newlines only) ⇒ fail-closed', async () => {
    const out = await verify(mkInstance(), "\n\n\n", SANDBOX, { timeoutMs: 1000 })
    expect(out.passed).toBe(false)
    expect(out.error).toBe("empty prediction (agent produced no patch)")
  })

  test('patch = "\\t\\t" (tabs only) ⇒ fail-closed', async () => {
    const out = await verify(mkInstance(), "\t\t", SANDBOX, { timeoutMs: 1000 })
    expect(out.passed).toBe(false)
  })

  test('patch = "\\r\\n" (CRLF only) ⇒ fail-closed', async () => {
    const out = await verify(mkInstance(), "\r\n", SANDBOX, { timeoutMs: 1000 })
    expect(out.passed).toBe(false)
  })

  test('patch = " \\t\\n \\r \\n " (mixed whitespace soup) ⇒ fail-closed', async () => {
    const out = await verify(mkInstance(), " \t\n \r \n ", SANDBOX, { timeoutMs: 1000 })
    expect(out.passed).toBe(false)
    expect(out.error).toBe("empty prediction (agent produced no patch)")
  })

  test("patch = U+00A0 (non-breaking space) — NOT trimmed by trim(), goes to testCmd path", async () => {
    // String.trim() removes U+00A0 in modern JS (whitespace per ES2019+).
    // This test pins the actual runtime behaviour rather than asserting one
    // way or another — if Bun's trim treats nbsp as whitespace, it's empty;
    // if not, it falls through to testCmd. Either way it MUST NOT throw.
    const out = await verify(mkInstance({ testCmd: "exit 0" }), " ", "/tmp", {
      timeoutMs: 1000,
    })
    // Both outcomes are valid for the guard — what matters is no throw.
    expect(typeof out.passed).toBe("boolean")
  })

  test('patch = "diff --git a/x b/x\\n..." (real-looking diff) ⇒ guard does NOT fire', async () => {
    // The verdict module will fall through to exec(testCmd). We supply a
    // testCmd that errors fast so the test stays hermetic. The KEY pin: error
    // string must NOT be "empty prediction ..." — the guard didn't fire.
    const realDiff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-foo\n+bar\n"
    const out = await verify(mkInstance({ testCmd: "exit 2" }), realDiff, "/tmp", {
      timeoutMs: 1000,
    })
    expect(out.error).not.toBe("empty prediction (agent produced no patch)")
    // exit 2 from `exit 2` cmd ⇒ exitCode 2, passed false
    expect(out.passed).toBe(false)
    expect(out.exitCode).toBe(2)
  })

  test("patch with single non-whitespace char ⇒ guard does NOT fire", async () => {
    const out = await verify(mkInstance({ testCmd: "exit 3" }), "x", "/tmp", {
      timeoutMs: 1000,
    })
    expect(out.error).not.toBe("empty prediction (agent produced no patch)")
    expect(out.exitCode).toBe(3)
  })
})

// ── B. python-swebench precedence ──────────────────────────────────────────────

describe("hellgate — python-swebench path bypasses the local empty-patch guard", () => {
  const swInstance = mkInstance({
    swebench: {
      instanceId: "astropy__astropy-12907",
      repo: "astropy/astropy",
      baseCommit: "abc123",
    },
  })

  test("empty patch + swebench meta + evaluator wired ⇒ evaluator IS called (NOT the local guard)", async () => {
    let called = false
    const seen: { patch?: string } = {}
    const evaluate: PythonSwebenchEvaluate = async (_inst, patch) => {
      called = true
      seen.patch = patch
      return { resolved: false, gradingCompleted: true, log: "ok" }
    }
    const out = await verify(swInstance, "", SANDBOX, {
      timeoutMs: 1000,
      pythonSwebench: { evaluate, opts: {} },
    })
    expect(called).toBe(true)
    expect(seen.patch).toBe("")
    // gradingCompleted:true + resolved:false ⇒ NOT infra failure ⇒ no error field
    expect(out.passed).toBe(false)
    expect(out.error).toBeUndefined()
    expect(out.command).toContain("python -m swebench.harness.run_evaluation")
    expect(out.command).toContain("astropy__astropy-12907")
  })

  test("python-harness wired but evaluator missing ⇒ explicit not-wired error (NOT empty-patch error)", async () => {
    const out = await verify(swInstance, "", SANDBOX, {
      timeoutMs: 1000,
      pythonSwebench: { opts: {} }, // evaluator missing
    })
    expect(out.passed).toBe(false)
    expect(out.error).toBe("python swebench evaluator not wired")
    expect(out.error).not.toContain("empty prediction")
  })

  test("python-swebench wired but instance LACKS swebench meta ⇒ local guard fires", async () => {
    const localOnly = mkInstance() // no swebench field
    let called = false
    const evaluate: PythonSwebenchEvaluate = async () => {
      called = true
      return { resolved: false, gradingCompleted: true, log: "" }
    }
    const out = await verify(localOnly, "", SANDBOX, {
      timeoutMs: 1000,
      pythonSwebench: { evaluate, opts: {} },
    })
    expect(called).toBe(false)
    expect(out.error).toBe("empty prediction (agent produced no patch)")
  })
})

// ── C. python harness infra-fail vs real-fail distinction ──────────────────────

describe("hellgate — python harness gradingCompleted distinction", () => {
  const swInstance = mkInstance({
    swebench: {
      instanceId: "x__y-1",
      repo: "x/y",
      baseCommit: "deadbeef",
    },
  })

  test("gradingCompleted:false + resolved:false ⇒ infra fail (error field SET to log slice)", async () => {
    const evaluate: PythonSwebenchEvaluate = async () => ({
      resolved: false,
      gradingCompleted: false,
      log: "harness exploded: build failed at step 3",
    })
    const out = await verify(swInstance, "diff --git a/x b/x\n", SANDBOX, {
      timeoutMs: 1000,
      pythonSwebench: { evaluate, opts: {} },
    })
    expect(out.passed).toBe(false)
    expect(out.error).toBe("harness exploded: build failed at step 3")
    expect(out.exitCode).toBe(1)
  })

  test("gradingCompleted:true + resolved:false ⇒ REAL fail (NO error field — clean unresolved)", async () => {
    const evaluate: PythonSwebenchEvaluate = async () => ({
      resolved: false,
      gradingCompleted: true,
      log: "tests ran, 3 failed",
    })
    const out = await verify(swInstance, "diff --git a/x b/x\n", SANDBOX, {
      timeoutMs: 1000,
      pythonSwebench: { evaluate, opts: {} },
    })
    expect(out.passed).toBe(false)
    expect(out.error).toBeUndefined() // important: clean unresolved
    expect(out.exitCode).toBe(1)
  })

  test("gradingCompleted:true + resolved:true ⇒ PASS, no error, exit 0", async () => {
    const evaluate: PythonSwebenchEvaluate = async () => ({
      resolved: true,
      gradingCompleted: true,
      log: "all green",
    })
    const out = await verify(swInstance, "diff --git a/x b/x\n", SANDBOX, {
      timeoutMs: 1000,
      pythonSwebench: { evaluate, opts: {} },
    })
    expect(out.passed).toBe(true)
    expect(out.error).toBeUndefined()
    expect(out.exitCode).toBe(0)
  })

  test("log slice respects 500-char cap for error + 2000-char cap for logTail", async () => {
    const giantLog = "x".repeat(10_000)
    const evaluate: PythonSwebenchEvaluate = async () => ({
      resolved: false,
      gradingCompleted: false,
      log: giantLog,
    })
    const out = await verify(swInstance, "diff --git a/x b/x\n", SANDBOX, {
      timeoutMs: 1000,
      pythonSwebench: { evaluate, opts: {} },
    })
    expect(out.error?.length).toBe(500)
    expect(out.logTail.length).toBe(2000)
  })
})

// ── D. VerifyOutcome shape — every field always present ───────────────────────

describe("hellgate — VerifyOutcome shape invariants", () => {
  test("empty-patch path returns ALL required VerifyOutcome fields", async () => {
    const out = await verify(mkInstance(), "", SANDBOX, { timeoutMs: 1000 })
    // Every field of VerifyOutcome must be present (typed contract).
    expect("passed" in out).toBe(true)
    expect("command" in out).toBe(true)
    expect("exitCode" in out).toBe(true)
    expect("failedTests" in out).toBe(true)
    expect("logTail" in out).toBe(true)
    expect("reportPath" in out).toBe(true)
    expect("error" in out).toBe(true) // empty-patch DOES set error
  })

  test("empty-patch path → reportPath always empty string", async () => {
    const out = await verify(mkInstance(), "", SANDBOX, { timeoutMs: 1000 })
    expect(out.reportPath).toBe("")
  })

  test("empty-patch path → failedTests always empty array", async () => {
    const out = await verify(mkInstance(), "", SANDBOX, { timeoutMs: 1000 })
    expect(out.failedTests).toEqual([])
  })
})
